export type RedrawAsset = { id: string; name: string; imageUrl: string };
export type RedrawMapping = { id: string; kind: "character" | "scene" | "prop"; source: string; assetId: string };
export type RedrawDraft = {
  version: 1;
  mappings: RedrawMapping[];
  style: "original" | "cinema" | "anime" | "ink";
  instruction: string;
  preserve: { action: boolean; camera: boolean; cuts: boolean; audio: boolean };
  modelId: string;
};
export type RedrawShot = { id: string; title: string; start: number; end: number; description: string; poster?: string };
export type RedrawSource = { id: string; title: string; url: string; poster?: string; duration: number; shots: RedrawShot[] };
export const REDRAW_STYLES = [
  { id: "original", name: "保留原片质感", description: "只修改指定对象" },
  { id: "cinema", name: "写实电影", description: "自然光影与电影质感" },
  { id: "anime", name: "日系动画", description: "统一线条与动画色彩" },
  { id: "ink", name: "东方水墨", description: "水墨笔触与留白" },
] as const;
export function createRedrawDraft(modelId = ""): RedrawDraft {
  return { version: 1, modelId, style: "original", instruction: "", preserve: { action: true, camera: true, cuts: true, audio: true }, mappings: [
    { id: "character-a", kind: "character", source: "原片人物 A", assetId: "" },
    { id: "character-b", kind: "character", source: "原片人物 B", assetId: "" },
    { id: "scene-a", kind: "scene", source: "原片场景", assetId: "" },
  ] };
}
/** Reference numbers must agree with deduplicated graph edges, including when one asset replaces several entities. */
export function buildRedrawPlan(draft: RedrawDraft, assets: RedrawAsset[]) {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const mapped = draft.mappings.filter(mapping => mapping.assetId);
  if (mapped.some(mapping => !byId.has(mapping.assetId))) throw new Error("有替换资产已从画布移除，请重新选择。");
  if (mapped.some(mapping => !mapping.source.trim())) throw new Error("请填写每项替换对应的原片对象。");
  if (!mapped.length && draft.style === "original" && !draft.instruction.trim()) throw new Error("请选择替换资产、调整画风，或填写修改要求。");
  const referenceIds = [...new Set(mapped.map(mapping => mapping.assetId))];
  const replacements = mapped.map(mapping => `${mapping.source.trim()}替换为@图片${referenceIds.indexOf(mapping.assetId) + 1}（${byId.get(mapping.assetId)!.name}），只替换这一对象，不与其他角色或物件串用。`);
  const keeps = [draft.preserve.action && "人物动作、肢体轨迹、站位与表演过程", draft.preserve.camera && "机位、景别与运镜", draft.preserve.cuts && "原片时长、镜头顺序、切点与节奏", draft.preserve.audio && "原片对白、音乐与音效"].filter(Boolean);
  const style = REDRAW_STYLES.find(item => item.id === draft.style);
  if (!style) throw new Error("画风配置无效，请重新选择。");
  const prompt = ["编辑@视频1，输出原视频的修改版本，不续写、不延长。", ...replacements,
    draft.style !== "original" ? `全片画风：${style.name}，${style.description}，所有镜头保持同一风格。` : "保留原片整体画面质感。",
    keeps.length ? `尽量保留：${keeps.join("；")}。` : "", draft.instruction.trim() ? `补充要求：${draft.instruction.trim()}` : ""].filter(Boolean).join("\n");
  return { prompt, referenceIds, mode: "video_edit" as const, duration: "-1" as const };
}
export function redrawTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${Math.floor(safe % 60).toString().padStart(2, "0")}`;
}
