import crypto from "node:crypto";
import type {RelayChannel} from "./sharedTypes";
import type {RelayImageRequest,RelayImageResult} from "./relayImage";
import {withChannelApiKeyForDispatch,resolveChannelBaseUrl} from "./relayChannelCredential";
import {joinProviderApiPath} from "./channelRouter";
import {buildJwsImageFields,readJwsImageReference,imageMime} from "./jwsImageTransport";
import type {JwsImageQuote,JwsImageCharge} from "./jwsImagePricing";
import {JwsImageError,selectJwsSku} from "./jwsImageCatalog";
export {JwsImageError,selectJwsSku,jwsWorkbenchImageCapabilities,jwsReferenceImageInputSlots} from "./jwsImageCatalog";

export type JwsTask = {id:string;status:string;billingStatus:string;settlementStatus?:string;amount:number;currency:string;outputCount:number;model:string;requestId:string;error?:{code?:string}};
type JwsHttp=(path:string,method?:string,body?:unknown,headers?:Record<string,string>)=>Promise<any>;
export interface PreparedJwsImage {quote:JwsImageQuote;body:Record<string,unknown>;request:JwsHttp;count:number;model:string;upstreamRequestId?:string;}

export function isJwsAsyncImage(channel:RelayChannel):boolean {return channel.provider==="openai" && channel.config?.imageTransport==="jws-async-v1";}

export function jwsTaskRequestId(requestId:string):string {
  const hash=crypto.createHash("sha256").update("fanjin-jws-image-v1:"+requestId).digest("hex");
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}

function jwsHttp(channel:RelayChannel,model:string):JwsHttp {
  return async(path,method="GET",body,headers={})=>{
    const dispatched=withChannelApiKeyForDispatch(channel,{channelId:channel.id,provider:channel.provider,endpointType:"image_generation",model},key=>({response:fetch(joinProviderApiPath(resolveChannelBaseUrl(channel),`v1/${path}`),{method,headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json",...headers},...(body!==undefined?{body:Buffer.isBuffer(body)?new Uint8Array(body):JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)})}));
    const response=await dispatched.response;
    if(!response.ok) {
      // Keep machine-readable diagnostics without surfacing raw upstream text,
      // which can contain account details or request content.
      const detail=await response.json().catch(()=>null);
      const safe=(value:unknown)=>typeof value==="string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)?value:undefined;
      throw new JwsImageError(`图片服务请求失败（${response.status}）`,response.status,![400,401,402,403,404,409,413,415,422,429].includes(response.status),safe(detail?.error?.code),safe(detail?.error?.traceId));
    }
    if(response.headers.get("content-type")?.startsWith("image/")) {
      const reader=response.body?.getReader();if(!reader)throw new JwsImageError("图片服务未返回图片");
      const parts:Uint8Array[]=[];let bytes=0;
      while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>32*1024*1024){await reader.cancel();throw new JwsImageError("图片结果过大");}parts.push(next.value);}
      const result=Buffer.concat(parts);imageMime(result);return result;
    }
    return response.json();
  };
}

export async function prepareJwsAsyncImage(input:RelayImageRequest,channel:RelayChannel,modelName:string,count:number,request:JwsHttp=jwsHttp(channel,modelName),requestIdentity:string=crypto.randomUUID()):Promise<PreparedJwsImage> {
  buildJwsImageFields(input,modelName,count);
  const upstreamRequestId=jwsTaskRequestId(requestIdentity);
  const catalog=await request("catalog/models?type=image");
  const model=catalog.data?.find((row:any)=>row.name===modelName);
  if(!model || !/^image:[^/]+$/.test(model.id))throw new JwsImageError("图片模型未在上游开放",404,false);
  if(input.output_format && !model.capabilities?.outputFormats?.includes(input.output_format))throw new JwsImageError("模型不支持所选图片格式",422,false);
  const params=selectJwsSku(model,input,count);
  const quote=(await request("quotes","POST",{type:"image",model:model.id,params})).data;
  if(!quote?.quoteId || quote.model!==model.id || quote.currency!=="USD" || !Number.isFinite(quote.amount) || quote.amount<=0 || !["fixed","usage"].includes(quote.pricingMode))throw new JwsImageError("图片服务报价无效",502,false);
  const body:Record<string,unknown>={model:model.id,prompt:input.prompt,...params,maxAmount:quote.amount,...(input.output_format?{outputFormat:input.output_format}:{})};
  const refs=Array.isArray(input.image)?input.image:input.image?[input.image]:[];
  if(refs.length) {
    const files=[];let total=0;
    for(const ref of refs){const file=await readJwsImageReference(ref);total+=file.body.length;if(total>50*1024*1024)throw new JwsImageError("参考图片总大小过大",422,false);files.push(file);}
    // JWS binds the uploaded inputs to the generation request identity.
    // Its official client uses the same UUID for both endpoint idempotency keys.
    const sessionKey=upstreamRequestId;
    const session=(await request("inputs","POST",{purpose:"image-generation",items:files.map((file,index)=>({sourceId:String(index),mimeType:file.mime,size:file.body.length,sha256:crypto.createHash("sha256").update(file.body).digest("hex")}))},{"Idempotency-Key":sessionKey})).data;
    if(!session?.id || !Array.isArray(session.items) || session.items.length!==files.length)throw new JwsImageError("参考图片上传会话无效",502,false);
    const orderedItems=files.map((_,index)=>session.items.filter((item:any)=>item.sourceId===String(index)));
    if(orderedItems.some(matches=>matches.length!==1) || session.items.some((item:any)=>typeof item.itemId!=="string" || !item.itemId) || new Set(session.items.map((item:any)=>item.itemId)).size!==files.length)throw new JwsImageError("参考图片顺序无效",502,false);
    for(const [index,[item]] of orderedItems.entries()){const file=files[index];await request(`inputs/${encodeURIComponent(session.id)}/items/${encodeURIComponent(item.itemId)}`,"PUT",file.body,{"Content-Type":file.mime});}
    // A successful PUT alone is not evidence that every input is ready for
    // generation. Read the same session before reserving or dispatching.
    const ready=(await request(`inputs/${encodeURIComponent(session.id)}`)).data;
    if(ready?.id!==session.id || ready.requestId!==sessionKey || ready.purpose!=="image-generation" || !Array.isArray(ready.items) || ready.items.length!==files.length || orderedItems.some(([item])=>!ready.items.some((entry:any)=>entry.itemId===item.itemId && entry.sourceId===item.sourceId && entry.uploaded===true)))throw new JwsImageError("参考图片上传结果未确认，请稍后重试",502,false);
    if(ready.status!=="ready")throw new JwsImageError("参考图片仍在准备中，请稍后重试",409,false);
    body.inputSessionId=session.id;body.imageInputIds=orderedItems.map(([item])=>item.itemId);
  }
  return {quote,body,request,count,model:model.id,...(refs.length ? {upstreamRequestId} : {})};
}

/** A single create, durable acceptance receipt, then read-only polling. */
export async function executeJwsAsyncImage(prepared:PreparedJwsImage,requestId:string,recordAccepted:(task:JwsTask)=>Promise<void>,options:{timeoutMs?:number;pollMs?:number}={}):Promise<RelayImageResult & {upstreamCharge:JwsImageCharge}> {
  const key=prepared.upstreamRequestId ?? jwsTaskRequestId(requestId);
  let task:JwsTask=(await prepared.request("image/generations","POST",prepared.body,{"Idempotency-Key":key})).data;
  if(!task?.id || !/^image:[0-9a-f-]+$/i.test(task.id) || task.model!==prepared.model || task.requestId!==key)throw new JwsImageError("图片任务回执无效");
  const taskId=task.id;
  await recordAccepted(task);
  const deadline=Date.now()+(options.timeoutMs||600000);
  while(["queued","processing"].includes(task.status)) {
    if(Date.now()>=deadline)throw new JwsImageError("图片任务仍在处理，请稍后刷新状态",504,true);
    await new Promise(r=>setTimeout(r,options.pollMs??2000));
    task=(await prepared.request(`tasks/${encodeURIComponent(taskId)}`)).data;
    if(task?.id!==taskId || task?.model!==prepared.model || task?.requestId!==key)throw new JwsImageError("图片任务查询身份不一致");
  }
  // Retain terminal failure/refund evidence as well as successful settlement;
  // otherwise recovery only sees the initial processing receipt.
  await recordAccepted(task);
  if(task.status==="failed" && task.billingStatus==="refunded")throw new JwsImageError("图片生成失败，本次不扣费",502,true,undefined,undefined,true);
  if(task.status!=="succeeded" || task.billingStatus!=="charged" || (prepared.quote.pricingMode==="usage" && task.settlementStatus!=="settled"))throw new JwsImageError("图片任务尚未完成或账单待确认");
  if(task.currency!=="USD" || !Number.isFinite(task.amount) || task.amount<0 || task.outputCount!==prepared.count)throw new JwsImageError("图片任务结果或账单不完整");
  const data=[];
  for(let index=0;index<task.outputCount;index++){const body=await prepared.request(`tasks/${encodeURIComponent(task.id)}/content?index=${index}`);if(!Buffer.isBuffer(body))throw new JwsImageError("图片内容格式无效");data.push({b64_json:body.toString("base64")});}
  return {created:Math.floor(Date.now()/1000),data,upstreamCharge:{amount:task.amount,currency:"USD",taskId:task.id,billingStatus:"charged",settlementStatus:task.settlementStatus}};
}
