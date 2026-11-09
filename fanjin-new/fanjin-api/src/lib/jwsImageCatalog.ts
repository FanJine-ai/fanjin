import type {RelayImageRequest} from "./relayImage";
import {VOLCENGINE_IMAGE_SIZE_PRESETS} from "./volcengineImageSize";

// Workbench currently uses the shared 1K/2K/4K presets as its wire contract.
// These are JWS's advertised pixel presets for those same tier/ratio choices.
// Never estimate a new size or classify a 2K ultrawide preset as 4K by width.
const JWS_PIXEL_PRESETS:Record<string,Record<string,string>>={
  "1K":{"1:1":"1024x1024","3:2":"1536x1024","2:3":"1024x1536","16:9":"1280x720","9:16":"720x1280","4:3":"1024x768","3:4":"768x1024","21:9":"1280x544"},
  "2K":{"1:1":"2048x2048","3:2":"2160x1440","2:3":"1440x2160","16:9":"2560x1440","9:16":"1440x2560","4:3":"2048x1536","3:4":"1536x2048","21:9":"2560x1088"},
  "4K":{"1:1":"2880x2880","3:2":"3456x2304","2:3":"2304x3456","16:9":"3840x2160","9:16":"2160x3840","4:3":"3200x2400","3:4":"2400x3200","21:9":"3840x1600"},
};

export class JwsImageError extends Error {
  constructor(message:string,readonly statusCode=502,readonly upstreamMayHaveAccepted=true,readonly upstreamCode?:string,readonly upstreamTraceId?:string,readonly upstreamRefundConfirmed=false){super(message);}
}
export function selectJwsSku(model:any,input:RelayImageRequest,count:number):any {
  const refs=Array.isArray(input.image)?input.image:input.image?[input.image]:[];
  if(!Number.isSafeInteger(count) || count<1 || count>Number(model.capabilities?.maxOutputImages) || refs.length>Number(model.capabilities?.maxInputImages))throw new JwsImageError("图片或参考图数量超出模型限制",422,false);
  const mode=refs.length?"image-to-image":"text-to-image";
  const sizes:string[]=model.capabilities?.sizes || [];
  let size=input.size||"1024x1024",resolution="1K";
  if(size!=="auto") {
    const [width,height]=size.split("x").map(Number);
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw new JwsImageError("请选择像素尺寸",422,false);
    const preset=Object.entries(VOLCENGINE_IMAGE_SIZE_PRESETS).flatMap(([tier,ratios])=>Object.entries(ratios).map(([ratio,pixels])=>({tier,ratio,pixels}))).find(p=>p.pixels===size);
    const ratios=sizes.filter((v:string)=>/^\d+:\d+$/.test(v));
    const ratio=preset?.ratio || ratios.find((v:string)=>{const [w,h]=v.split(":").map(Number);return Math.abs(width/height-w/h)<0.015;});
    resolution=preset?.tier || (Math.max(width,height)<=1536?"1K":Math.max(width,height)<=2560?"2K":"4K");
    if(ratio && ratios.includes(ratio))size=ratio;
    else if(preset && !sizes.includes(size))size=JWS_PIXEL_PRESETS[preset.tier]?.[preset.ratio] || size;
  } else {
    size=sizes.includes("auto")?"auto":sizes.includes("1:1")?"1:1":"1024x1024";
  }
  // An auto SKU is a shared price for the model's advertised sizes. It must
  // not authorize an arbitrary size or silently downgrade a requested tier.
  if(!sizes.includes(size))throw new JwsImageError("模型不支持所选尺寸与质量组合",422,false);
  const candidates=(model.skus || []).filter((s:any)=>s.mode===mode && s.resolution===resolution && (s.size===size || s.size==="auto"));
  const requested=input.quality;
  const quality=requested && requested!=="auto"?requested
    :requested==="auto" && candidates.some((s:any)=>s.quality==="auto")?"auto"
    :["medium","auto","low","high"].find(q=>candidates.some((s:any)=>s.quality===q));
  const sku=candidates.find((s:any)=>s.quality===quality && s.size===size)
    || candidates.find((s:any)=>s.quality===quality && s.size==="auto");
  if(!sku)throw new JwsImageError("模型不支持所选尺寸与质量组合",422,false);
    if (model.name === "Wan 2.7 Image Pro" && refs.length && resolution === "4K") throw new JwsImageError("万相图片编辑最高支持 2K",422,false);
  if (/^Wan 2\.7 Image(?: Pro)?$/.test(model.name) && count > 4) throw new JwsImageError("万相普通生成最多支持 4 张图片",422,false);
  return {mode:sku.mode,size,resolution:sku.resolution,quality:sku.quality,count,...(refs.length ? {referenceCount: refs.length} : {})};
}

/** Inventory only: this does not grant a paid certification or enable a route. */
export function jwsWorkbenchImageCapabilities(model:any):{qualities:string[];aspectRatios:string[];defaultQuality:string;defaultAspectRatio:string} {
  const tiers=Object.keys(VOLCENGINE_IMAGE_SIZE_PRESETS).filter(tier=>model.capabilities?.resolutions?.includes(tier));
  const aspectRatios=Object.keys(VOLCENGINE_IMAGE_SIZE_PRESETS["1K"]).filter(ratio=>tiers.every(tier=>{
    const size=(VOLCENGINE_IMAGE_SIZE_PRESETS as Record<string,Record<string,string>>)[tier][ratio];
    try{return selectJwsSku(model,{model:model.name,prompt:"capability validation",size},1).resolution===tier;}catch{return false;}
  }));
  if(!tiers.length || !aspectRatios.length)throw new JwsImageError("图片模型缺少可用的尺寸配置",422,false);
  return {qualities:tiers,aspectRatios,defaultQuality:tiers[0],defaultAspectRatio:aspectRatios.includes("1:1")?"1:1":aspectRatios[0]};
}

/** Use the exact priced upstream SKU inventory, never a public model-name guess. */
export function jwsReferenceImageInputSlots(
  model: any, upstreamModel: string, qualities: readonly string[], aspectRatios: readonly string[],
): Array<Record<string, unknown>> {
  const maximum = model?.capabilities?.maxInputImages;
  if (model?.name !== upstreamModel || model?.id !== `image:${upstreamModel}`
    || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16
    || !qualities.length || !aspectRatios.length || !Array.isArray(model.skus)) return [];
  // A shared input slot promises editing for every exposed tier/ratio. Do not
  // promote a model's global maxInputImages when a selected SKU is text-only.
  for (const quality of qualities) for (const ratio of aspectRatios) {
    const size = (VOLCENGINE_IMAGE_SIZE_PRESETS as Record<string, Record<string, string>>)[quality]?.[ratio];
    if (!size) return [];
    try {
      const sku = selectJwsSku(model, {model: upstreamModel, prompt: "reference capability", size, image: "reference"}, 1);
      if (sku.mode !== "image-to-image" || sku.resolution !== quality) return [];
    } catch { return []; }
  }
  return [{id: "reference_images", label: "参考图片", accepts: ["image"],
    roles: ["subject", "style", "storyboard", "first_frame", "last_frame"], min: 0, max: maximum}];
}
