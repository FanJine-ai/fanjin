import type { RelayChatRequest } from "./relayChat";
import type { ResponsesRequest } from "./protocolConverter";
import { nextSseEvent, readSseData } from "../agent-model/sseParser";

/** Lossless subset used by Agent: messages, images, function calls and results. */
export function chatToNativeResponses(request: RelayChatRequest): ResponsesRequest {
  for (const key of ["stop", "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs", "audio", "modalities"]) {
    if (request[key] != null) throw new Error(`Native Responses does not support chat field: ${key}`);
  }
  if (request.n != null && request.n !== 1) throw new Error("Native Responses requires n=1");
  const input: any[] = [];
  for (const message of request.messages as any[]) {
    if (message.role === "tool") {
      if (!message.tool_call_id || typeof message.content !== "string") throw new Error("Invalid tool result");
      input.push({type:"function_call_output",call_id:message.tool_call_id,output:message.content});
      continue;
    }
    if (!["system","developer","user","assistant"].includes(message.role)) throw new Error("Invalid message role");
    const content = typeof message.content === "string"
      ? [{type:message.role === "assistant" ? "output_text" : "input_text",text:message.content}]
      : (message.content || []).map((part:any) => {
        if (part.type === "text") return {type:message.role === "assistant" ? "output_text" : "input_text",text:part.text};
        if (part.type === "image_url" && message.role === "user" && part.image_url?.url) {
          return {type:"input_image",image_url:part.image_url.url,detail:part.image_url.detail || "auto"};
        }
        throw new Error("Unsupported chat content for Native Responses");
      });
    if (content.length && content.some((part:any)=>part.type === "input_image" || part.text)) input.push({type:"message",role:message.role,content});
    for (const tool of message.tool_calls || []) {
      if (message.role !== "assistant" || tool.type !== "function" || !tool.id || !tool.function?.name) throw new Error("Invalid function call");
      input.push({type:"function_call",call_id:tool.id,name:tool.function.name,arguments:tool.function.arguments || "{}"});
    }
  }
  const tools = request.tools?.map((tool:any) => {
    if(tool.type !== "function" || !tool.function?.name) throw new Error("Only client function tools are supported");
    return {type:"function",...tool.function};
  });
  const toolChoice:any=request.tool_choice;
  const format:any=request.response_format;
  if (request.reasoning_effort != null && typeof request.reasoning_effort !== "string") throw new Error("Invalid reasoning effort");
  if(format && !["text","json_object","json_schema"].includes(format.type)) throw new Error("Invalid response format");
  return {
    model:request.model,input,stream:request.stream,store:false,
    max_output_tokens:request.max_completion_tokens ?? request.max_tokens,
    ...(request.temperature !== undefined?{temperature:request.temperature}:{}),
    ...(request.top_p !== undefined?{top_p:request.top_p}:{}),
    ...(tools?.length?{tools}:{}),
    ...(toolChoice?{tool_choice:typeof toolChoice === "string"?toolChoice:{type:"function",name:toolChoice.function?.name}}:{}),
    ...(request.parallel_tool_calls !== undefined?{parallel_tool_calls:request.parallel_tool_calls}:{}),
    ...(typeof request.reasoning_effort === "string"?{reasoning:{effort:request.reasoning_effort}}:{}),
    ...(format?{text:{format:format.type === "json_schema"?{type:"json_schema",...format.json_schema}:format}}:{}),
  };
}

export function nativeResponseToChat(response:any, model:string):any {
  const output=Array.isArray(response.output)?response.output:[];
  const calls=output.filter((item:any)=>item.type === "function_call");
  const text=output.filter((item:any)=>item.type === "message").flatMap((item:any)=>item.content||[]).filter((part:any)=>part.type === "output_text").map((part:any)=>part.text).join("");
  return {
    id:response.id,object:"chat.completion",created:response.created_at||Math.floor(Date.now()/1000),model,
    choices:[{index:0,message:{role:"assistant",content:text||null,...(calls.length?{tool_calls:calls.map((call:any)=>({id:call.call_id,type:"function",function:{name:call.name,arguments:call.arguments||""}}))}:{})},finish_reason:response.status === "incomplete"?"length":calls.length?"tool_calls":"stop"}],
    ...(response.usage?{usage:{prompt_tokens:response.usage.input_tokens,completion_tokens:response.usage.output_tokens,total_tokens:response.usage.total_tokens,prompt_tokens_details:response.usage.input_tokens_details,completion_tokens_details:response.usage.output_tokens_details}}:{}),
  };
}

/** The source stream settles usage before closing; finish is emitted afterwards. */
export function nativeResponsesStreamToChat(
  source:ReadableStream<Uint8Array>,model:string,onSettled?:()=>Promise<void>,
):ReadableStream<Uint8Array> {
  const encoder=new TextEncoder(),decoder=new TextDecoder();
  let buffer="",responseId="",terminal:any=null,sawText=false;
  const calls=new Map<number,{index:number,id:string,name:string,arguments:string}>();
  const emit=(controller:TransformStreamDefaultController<Uint8Array>,delta:any,finish:any=null,usage?:any)=>controller.enqueue(encoder.encode(`data: ${JSON.stringify({id:responseId,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model,choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})}\n\n`));
  const frame=(value:string,controller:TransformStreamDefaultController<Uint8Array>)=>{
    const data=readSseData(value);if(!data || data === "[DONE]")return;
    const event=JSON.parse(data);
    if(event.type === "error" || event.type === "response.failed" || event.error) throw new Error(event.error?.message||event.response?.error?.message||"Native Responses failed");
    responseId=event.response?.id || responseId;
    if(event.type === "response.output_text.delta") {sawText=true;emit(controller,{content:event.delta});}
    if(event.type === "response.output_item.added" && event.item?.type === "function_call") {
      const item=event.item,call={index:calls.size,id:item.call_id,name:item.name,arguments:item.arguments||""};
      calls.set(event.output_index,call);emit(controller,{tool_calls:[{index:call.index,id:call.id,type:"function",function:{name:call.name,arguments:call.arguments}}]});
    }
    if(event.type === "response.function_call_arguments.delta") {
      const call=calls.get(event.output_index);if(!call)throw new Error("Function arguments arrived without call identity");
      call.arguments+=event.delta;emit(controller,{tool_calls:[{index:call.index,function:{arguments:event.delta}}]});
    }
    if(event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const call=calls.get(event.output_index);
      if(call && !call.arguments && event.item.arguments) {call.arguments=event.item.arguments;emit(controller,{tool_calls:[{index:call.index,function:{arguments:call.arguments}}]});}
    }
    if(["response.completed","response.incomplete"].includes(event.type)) terminal=event.response;
  };
  return source.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,controller){buffer+=decoder.decode(chunk,{stream:true});let event;while((event=nextSseEvent(buffer))){buffer=event.rest;frame(event.event,controller);}},
    async flush(controller){
      buffer+=decoder.decode();if(buffer.trim())frame(buffer,controller);
      if(!terminal?.usage)throw new Error("Native Responses ended without terminal usage");
      const completion=nativeResponseToChat(terminal,model),choice=completion.choices[0];
      if(!sawText && choice.message.content)emit(controller,{content:choice.message.content});
      if(!calls.size && choice.message.tool_calls?.length)emit(controller,{tool_calls:choice.message.tool_calls.map((call:any,index:number)=>({...call,index}))});
      await onSettled?.();
      emit(controller,{},choice.finish_reason,completion.usage);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  }));
}
