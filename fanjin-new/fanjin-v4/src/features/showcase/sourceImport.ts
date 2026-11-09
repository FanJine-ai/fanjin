import { isVideoModelAvailable, normalizeVideoDuration, resolveQuickCreateVideoReferences, type QuickCreateVideoModelOption } from "../quick-create/modelCatalog";
import { validateUploadFile } from "../quick-create/attachments/api";
import type { ArkSource } from "./catalog";

/** Only an exact source model may be presented as a same-model preset. Never substitute a value/fast model. */
export function sourceVideoSetup(source: ArkSource, models: QuickCreateVideoModelOption[]) {
  const model = models.find(item => item.id === source.model && isVideoModelAvailable(item));
  if (!model) throw new Error("当前工作区尚未开放原案例使用的 Seedance 2.5 模型。原片、提示词和素材已完整保留，可先预览或下载素材包；模型接入后即可一键带入。");
  const mode = source.ability === "VideoEdit" ? "video_edit" : "omni_reference";
  const resolution = model.resolutions.find(value => value.toLowerCase() === source.options.resolution.toLowerCase());
  const ratio = model.aspectRatios.find(value => value === source.options.ratio);
  if (!model.modes.includes(mode) || !resolution || !ratio || normalizeVideoDuration(source.options.duration, model.duration) !== source.options.duration || (source.options.generateAudio && !model.supportsGenerateAudio)) {
    throw new Error("当前模型尚不支持原案例的完整参数组合，未替换模型或缩短时长。可先下载素材包，待对应能力开放后带入。");
  }
  const references = source.references.map(ref => ({kind: ref.kind === "audio" ? "file" as const : ref.kind, assetVersionId: ref.id}));
  if (references.length > model.totalInputLimit) throw new Error(`原案例含 ${references.length} 份素材，当前模型最多支持 ${model.totalInputLimit} 份，已保留完整素材包。`);
  const resolved = resolveQuickCreateVideoReferences(model, mode, references);
  if (!resolved.ok) throw new Error(resolved.message);
  return { model, mode, resolution, ratio, duration: source.options.duration, audio: source.options.generateAudio };
}

/** Fetch only our bundled media. Validate every file before mutating the user's draft. */
export async function loadSourceReferenceFiles(source: ArkSource, signal?: AbortSignal): Promise<File[]> {
  const result: File[] = [];
  for (const ref of source.references) {
    if (!/^\/showcase\/ark\/media\/[a-f0-9]+\.(png|jpg|webp|mp3|wav|mp4|webm)$/.test(ref.src)) throw new Error("案例素材路径无效");
    const response = await fetch(ref.src, { signal });
    if (!response.ok) throw new Error(`${ref.label}读取失败，请重试`);
    const blob = await response.blob();
    const file = new File([blob], `${ref.label}.${ref.src.split(".").pop()}`, { type: blob.type });
    const error = validateUploadFile(file);
    if (error) throw new Error(`${ref.label}：${error}`);
    result.push(file);
  }
  return result;
}
