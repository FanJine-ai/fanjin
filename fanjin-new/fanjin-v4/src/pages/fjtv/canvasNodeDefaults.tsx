import { repairLegacyNodes as repairCanvasLegacyNodes } from "./canvasSnapshotCodec";
import type { ProductScriptStep, ProductScriptStage, ProductScriptAsset, ProductScriptWorkflow, NodeData, AssetTemplate } from "./canvasDataTypes";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import { ratioToNodeDimensions } from "./canvasMediaGeometry";
import { ASSET_TAGS, ASSET_CATEGORY_FALLBACK, PRODUCT_SCRIPT_ASSETS } from "./canvasPageConstants";
import { DEFAULT_CAMERA_SETTINGS, formatCameraControl } from "./canvasCameraDefinitions";

export function shouldHideCanvasPromptShell(node: Pick<NodeData, "type" | "videoRenderMode">): boolean {
  return node.type === "audio" || node.videoRenderMode === "finalize";
}

export function toTimestamp(value: unknown, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function normalizeAssetCategory(value: unknown): AssetTemplate["category"] {
  const raw = String(value || "").trim();
  if (!raw) return ASSET_CATEGORY_FALLBACK;
  if ((ASSET_TAGS as readonly string[]).includes(raw)) return raw as AssetTemplate["category"];
  if (raw === "浜虹墿") return "人物";
  if (raw === "鍦烘櫙") return "场景";
  if (raw === "鐗╁搧") return "物品";
  if (raw === "椋庢牸") return "风格";
  if (raw === "鍏朵粬") return "其它";
  return ASSET_CATEGORY_FALLBACK;
}

export function isAssetUri(value: string | undefined | null): value is string {
  return /^asset:\/\//i.test(String(value || "").trim());
}

export function buildPortraitReferenceNode(name: string, previewUrl: string, referenceAssetUri: string): NodeData {
  const ratio: RatioKey = "3:4";
  const dims = ratioToNodeDimensions(ratio, "image");
  const baseNode = createNode("asset_node_0", "image", dims.width / 2, dims.height / 2);
  return {
    ...baseNode,
    id: "asset_node_0",
    title: name,
    titleCustomized: true,
    x: 0,
    y: 0,
    width: dims.width,
    height: dims.height,
    ratio,
    imageUrl: previewUrl,
    referenceAssetUri,
    referenceAssetKind: "portrait",
    referenceAssetPreviewUrl: previewUrl,
  };
}

export function createDefaultProductScriptWorkflow(): ProductScriptWorkflow {
  return {
    step: 1,
    stage: "empty",
    progress: 0,
    productName: "我们的产品",
    productCategory: "美妆产品",
    assets: PRODUCT_SCRIPT_ASSETS.map((item) => ({ kind: item.kind, label: item.label })),
    generatedVideoNodeIds: [],
  };
}

export function normalizeProductScriptWorkflow(input?: Partial<ProductScriptWorkflow> | null): ProductScriptWorkflow {
  const base = createDefaultProductScriptWorkflow();
  const incomingAssets = Array.isArray(input?.assets) ? input?.assets || [] : [];
  const assets = PRODUCT_SCRIPT_ASSETS.map((def) => ({
    ...base.assets.find((item) => item.kind === def.kind),
    ...(incomingAssets.find((item) => item.kind === def.kind) || {}),
    kind: def.kind,
    label: def.label,
  })) as ProductScriptAsset[];
  return {
    ...base,
    ...(input || {}),
    step: (input?.step === 2 || input?.step === 3 ? input.step : 1) as ProductScriptStep,
    stage: (input?.stage || base.stage) as ProductScriptStage,
    progress: Math.max(0, Math.min(100, Number(input?.progress ?? base.progress) || 0)),
    productName: String(input?.productName || base.productName),
    productCategory: String(input?.productCategory || base.productCategory),
    assets,
    generatedVideoNodeIds: Array.isArray(input?.generatedVideoNodeIds) ? input?.generatedVideoNodeIds : [],
  };
}

export function baseModel(type: NodeType) {
  if (type === "compose") return "timeline-compose";
  return "";
}

export function createNode(id: string, type: NodeType, centerX: number, centerY: number): NodeData {
  const defaultRatio: RatioKey = type === "video" || type === "script" ? "9:16" : "1:1";
  // Video frames must follow the ratio (9:16 stays portrait) instead of a
  // hard-coded landscape box.
  const dims = type === "script"
    ? { width: 850, height: 480 }
    : ratioToNodeDimensions(defaultRatio, type);
  return {
    id,
    type,
    title: nodeTitle(type),
    titleCustomized: false,
    x: centerX - dims.width / 2,
    y: centerY - dims.height / 2,
    width: dims.width,
    height: dims.height,
    ratio: defaultRatio,
    prompt: "",
    model: baseModel(type),
    quality: "高",
    resolution: type === "video" || type === "compose" ? "720P" : "2K",
    cameraControl: formatCameraControl(DEFAULT_CAMERA_SETTINGS),
    cameraSettings: { ...DEFAULT_CAMERA_SETTINGS },
    panorama: "全景图",
    quantity: "1x",
    maxImages: 1,
    videoGenerateAudio: true,
    videoOutputFormat: "mp4",
    videoMode: type === "video" ? "text_to_video" : undefined,
    price: "",
    duration: "5",
    audioVoice: "少女音色",
    audioMood: "停顿",
    composeMuted: false,
    textVisited: false,
    isGenerating: false,
    generationState: "idle",
    taskStatus: "idle",
    scriptWorkflow: type === "script" ? createDefaultProductScriptWorkflow() : undefined,
  };
}

export function createCanvasBriefNode(brief: string): NodeData | null {
  const normalized = String(brief || "").trim();
  if (!normalized) return null;
  return {
    ...createNode(`brief_${Date.now()}_${Math.floor(Math.random() * 1000)}`, "text", 0, 0),
    title: "创作 Brief",
    titleCustomized: true,
    prompt: normalized,
    outputText: normalized,
    textVisited: true,
  };
}

export function repairLegacyNodes(rawNodes: any[]) {
  return repairCanvasLegacyNodes(rawNodes, createNode);
}

export function nodeTitle(type: NodeType) {
  if (type === "video") return "Video";
  if (type === "text") return "Text";
  if (type === "audio") return "Audio";
  if (type === "compose") return "Compose";
  if (type === "script") return "Script";
  return "Image";
}

export function nodeOptions(type: NodeType) {
  if (type === "video") return ["全能参考", "图生视频", "首尾帧生视频"];
  if (type === "text") return ["自己编写内容", "文字生视频"];
  if (type === "audio") return [];
  if (type === "compose") return ["打开视频合成"];
  if (type === "script") return ["上传爆款视频", "解析产品", "生成分镜", "生成视频"];
  return ["图生图", "图片高清"];
}
