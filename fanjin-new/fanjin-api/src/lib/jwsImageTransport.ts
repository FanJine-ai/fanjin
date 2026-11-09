import FormData from "form-data";
import { downloadPublicRemoteImage } from "./safeRemoteVideoDownload";
import type { RelayChannel } from "./sharedTypes";
import type { RelayImageRequest } from "./relayImage";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export function isJwsImageChannel(channel: RelayChannel): boolean {
  return channel.provider === "openai" && channel.config?.imageTransport === "jws-images-v1";
}

/** JWS's standard image API accepts display names and only returns Base64. */
export function buildJwsImageFields(request: RelayImageRequest, model: string, count: number): Record<string, string | number> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) throw Error("图片数量必须为 1 到 10");
  if (request.size && request.size !== "auto" && !/^[1-9]\d*x[1-9]\d*$/.test(request.size)) throw Error("请选择模型支持的像素尺寸");
  if (request.quality && !["auto","low","medium","high","xhigh","max"].includes(request.quality)) throw Error("当前图片模型不支持此质量选项");
  if (request.output_format && !["png","jpeg","webp"].includes(request.output_format)) throw Error("当前图片模型不支持此格式");
  if (request.style || request.guidance_scale !== undefined || request.optimize_prompt || request.optimize_prompt_options || request.watermark === true) throw Error("当前图片模型不支持所选扩展参数");
  if (request.seed !== undefined && request.seed !== -1) throw Error("当前图片模型不支持固定随机种子");
  const fields: Record<string,string|number> = {model,prompt:request.prompt,n:count,response_format:"b64_json"};
  for (const key of ["size","quality","output_format","user"] as const) {
    if (request[key]) fields[key]=request[key]!;
  }
  // Workbench stores provider-neutral 1K presets. GPT Image only accepts its
  // three native sizes, so translate the equivalent landscape/portrait
  // presets at the provider boundary instead of advertising unsupported 16:9.
  if (/^gpt-image(?:-|$)/i.test(model) && typeof fields.size === "string") {
    fields.size = ({
      "1248x832": "1536x1024",
      "832x1248": "1024x1536",
    } as Record<string, string>)[fields.size] || fields.size;
  }
  return fields;
}

export function imageMime(body: Buffer): string {
  if(body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return "image/png";
  if(body[0]===255 && body[1]===216 && body[2]===255)return "image/jpeg";
  if(body.toString("ascii",0,4)==="RIFF" && body.toString("ascii",8,12)==="WEBP")return "image/webp";
  throw Error("参考图必须是 PNG、JPEG 或 WebP 图片");
}

export async function readJwsImageReference(ref: string): Promise<{body:Buffer;mime:string}> {
  let body:Buffer;
  if(/^https?:\/\//i.test(ref)) body=(await downloadPublicRemoteImage({url:ref,maximumBytes:MAX_IMAGE_BYTES,timeoutMs:30000,maximumRedirects:3})).body;
  else {
    const match=/^(?:data:image\/(?:png|jpeg|webp);base64,)?([A-Za-z0-9+/]+={0,2})$/.exec(ref);
    if(!match || match[1].length>Math.ceil(MAX_IMAGE_BYTES/3)*4)throw Error("参考图片编码无效或文件过大");
    body=Buffer.from(match[1],"base64");
    if(body.toString("base64")!==match[1])throw Error("参考图片编码无效");
  }
  if(body.length>MAX_IMAGE_BYTES)throw Error("参考图片文件过大");
  return {body,mime:imageMime(body)};
}

export async function prepareJwsImageRequest(
  request: RelayImageRequest, model: string, count: number,
  download: typeof downloadPublicRemoteImage = downloadPublicRemoteImage,
): Promise<{path: string; body: Record<string,string|number> | FormData; headers: Record<string,string>}> {
  const fields=buildJwsImageFields(request,model,count);
  const refs=Array.isArray(request.image)?request.image:request.image?[request.image]:[];
  if(!refs.length)return {path:"images/generations",body:fields,headers:{"Content-Type":"application/json"}};
  // Lowest limit across the two configured official GPT Image 2 lines.
  if(refs.length>15)throw Error("当前图片通道最多支持 15 张参考图");
  const form=new FormData();
  for(const [key,value] of Object.entries(fields))form.append(key,String(value));
  let totalBytes=0;
  for(const [index,ref] of refs.entries()) {
    let body:Buffer;
    if(/^https?:\/\//i.test(ref)) {
      // DNS-pinned public transport rejects private addresses and unsafe redirects.
      body=(await download({url:ref,maximumBytes:MAX_IMAGE_BYTES,timeoutMs:30000,maximumRedirects:3})).body;
    } else {
      const match=/^(?:data:image\/(?:png|jpeg|webp);base64,)?([A-Za-z0-9+/]+={0,2})$/.exec(ref);
      if(!match || match[1].length>Math.ceil(MAX_IMAGE_BYTES/3)*4)throw Error("参考图片编码无效或文件过大");
      body=Buffer.from(match[1],"base64");
      if(body.toString("base64")!==match[1])throw Error("参考图片编码无效");
    }
    totalBytes+=body.length;
    if(body.length>MAX_IMAGE_BYTES || totalBytes>MAX_TOTAL_BYTES)throw Error("参考图片文件过大");
    const mime=imageMime(body);
    form.append("image[]",body,{filename:`reference-${index+1}.${mime.split("/")[1]}`,contentType:mime,knownLength:body.length});
  }
  return {path:"images/edits",body:form,headers:form.getHeaders()};
}
