import type { WorkbenchModelCatalog } from "@/lib/workbenchModelCatalog";
import type { WorkbenchTextModel } from "@/lib/workbenchTextModelCatalog";

export const WORKBENCH_CANVAS_CAPABILITY_DIRECTORY_VERSION =
  "fanjin.workbench-canvas-capabilities/v1" as const;

export type WorkbenchCanvasActionStatus = "available" | "unavailable";
export type WorkbenchCanvasActionExecution = "browser" | "server";

export type WorkbenchCanvasActionPort = Readonly<{
  id: string;
  mediaType: "text" | "image" | "video" | "audio" | "canvas" | "document";
  required: boolean;
  min: number;
  max: number;
}>;

export type WorkbenchCanvasActionDescriptor = Readonly<{
  id: string;
  version: string;
  label: string;
  category: "create" | "image" | "video" | "audio" | "understand" | "publish";
  nodeType: "text" | "image" | "video" | "audio" | "compose" | "script";
  execution: WorkbenchCanvasActionExecution;
  endpoint: string | null;
  status: WorkbenchCanvasActionStatus;
  unavailableReason: string | null;
  requiresProject: boolean;
  requiresQuote: boolean;
  requiresApproval: boolean;
  offerSource: "model_catalog" | "runtime_quote" | "local" | "none";
  inputPorts: readonly WorkbenchCanvasActionPort[];
  outputPorts: readonly WorkbenchCanvasActionPort[];
  parameterSchema: Readonly<Record<string, unknown>>;
}>;

export type WorkbenchCanvasCapabilityDirectory = Readonly<{
  version: typeof WORKBENCH_CANVAS_CAPABILITY_DIRECTORY_VERSION;
  modelCatalogVersion: string;
  modelCatalogPath: "/api/workbench/models/catalog";
  actions: readonly WorkbenchCanvasActionDescriptor[];
}>;

type CatalogInput = Readonly<{
  modelCatalog: Pick<WorkbenchModelCatalog, "catalogVersion" | "imageModels" | "videoModels">;
  textModels: readonly WorkbenchTextModel[];
  videoStoryAnalyzer?: Readonly<{ available: boolean; reason: string | null }>;
}>;

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const stringSchema = (extra: Record<string, unknown> = {}) => ({ type: "string", ...extra });
const numberSchema = (extra: Record<string, unknown> = {}) => ({ type: "number", ...extra });

const input = (
  id: string,
  mediaType: WorkbenchCanvasActionPort["mediaType"],
  required = true,
  min = required ? 1 : 0,
  max = 1,
): WorkbenchCanvasActionPort => ({ id, mediaType, required, min, max });

const output = (
  id: string,
  mediaType: WorkbenchCanvasActionPort["mediaType"],
  max = 1,
): WorkbenchCanvasActionPort => ({ id, mediaType, required: true, min: 1, max });

function availableModelCount(models: readonly { canSubmit?: boolean }[]): number {
  return models.filter((model) => model.canSubmit === true).length;
}

function availableTimeRangeVideoEditModelCount(
  models: WorkbenchModelCatalog["videoModels"],
): number {
  return models.filter((model) => (
    model.canSubmit === true
    && model.videoGeneration?.dispatchable === true
    && model.videoGeneration.supportsTimeRange === true
    && model.videoGeneration.operations.some((operation) => (
      operation.operation === "edit" && operation.enabled === true
    ))
  )).length;
}

function modelAction(inputAction: Omit<WorkbenchCanvasActionDescriptor, "status" | "unavailableReason"> & {
  availableModels: number;
}): WorkbenchCanvasActionDescriptor {
  const { availableModels, ...descriptor } = inputAction;
  return {
    ...descriptor,
    status: availableModels > 0 ? "available" : "unavailable",
    unavailableReason: availableModels > 0 ? null : "当前工作区没有已认证、可计费且可提交的模型 offer",
  };
}

function unavailableAction(
  inputAction: Omit<WorkbenchCanvasActionDescriptor, "status" | "unavailableReason">,
  unavailableReason: string,
): WorkbenchCanvasActionDescriptor {
  return { ...inputAction, status: "unavailable", unavailableReason };
}

/**
 * Server-owned action directory.  It deliberately describes executors rather
 * than inventing model/resolution offers: every model-specific option remains
 * sourced from /api/workbench/models/catalog and is revalidated by submit.
 */
export function buildWorkbenchCanvasCapabilityDirectory(
  catalog: CatalogInput,
): WorkbenchCanvasCapabilityDirectory {
  const imageModels = availableModelCount(catalog.modelCatalog.imageModels);
  const videoModels = availableModelCount(catalog.modelCatalog.videoModels);
  const timeRangeVideoEditModels = availableTimeRangeVideoEditModelCount(
    catalog.modelCatalog.videoModels,
  );
  const textModels = catalog.textModels.length;
  const shared = {
    requiresProject: true,
    requiresQuote: false,
    requiresApproval: false,
  } as const;

  const actions: WorkbenchCanvasActionDescriptor[] = [
    {
      id: "canvas.text.create",
      version: "1.0.0",
      label: "文本节点",
      category: "create",
      nodeType: "text",
      execution: "browser",
      endpoint: null,
      status: "available",
      unavailableReason: null,
      ...shared,
      offerSource: "local",
      inputPorts: [],
      outputPorts: [output("text", "text")],
      parameterSchema: objectSchema({ text: stringSchema({ maxLength: 100_000 }) }),
    },
    {
      id: "canvas.media.upload",
      version: "1.0.0",
      label: "上传媒体",
      category: "create",
      nodeType: "image",
      execution: "server",
      endpoint: "/api/assets/upload-reference",
      status: "available",
      unavailableReason: null,
      ...shared,
      offerSource: "local",
      inputPorts: [],
      outputPorts: [
        output("image", "image"),
        output("video", "video"),
        output("audio", "audio"),
      ],
      parameterSchema: objectSchema({ file: { type: "binary" } }, ["file"]),
    },
    modelAction({
      id: "canvas.director.plan",
      version: "1.0.0",
      label: "创意导演",
      category: "create",
      nodeType: "script",
      execution: "server",
      endpoint: "/api/workbench/create/directorPlan",
      ...shared,
      requiresQuote: true,
      requiresApproval: true,
      offerSource: "model_catalog",
      inputPorts: [input("brief", "text")],
      outputPorts: [output("plan", "text")],
      parameterSchema: objectSchema({
        brief: stringSchema({ minLength: 1, maxLength: 100_000 }),
        ratio: stringSchema(),
        duration: numberSchema({ minimum: 1 }),
        shotCount: numberSchema({ minimum: 1, maximum: 100 }),
      }, ["brief"]),
      availableModels: textModels,
    }),
    modelAction({
      id: "canvas.image.generate",
      version: "1.0.0",
      label: "图片生成",
      category: "create",
      nodeType: "image",
      execution: "server",
      endpoint: "/api/workbench/create/images",
      ...shared,
      requiresQuote: true,
      requiresApproval: true,
      offerSource: "model_catalog",
      inputPorts: [input("prompt", "text"), input("references", "image", false, 0, 50)],
      outputPorts: [output("images", "image", 4)],
      parameterSchema: objectSchema({
        model: stringSchema({ source: "model_offer" }),
        quality: stringSchema({ source: "model_offer" }),
        ratio: stringSchema({ source: "model_offer" }),
        count: numberSchema({ integer: true, minimum: 1, source: "model_offer.maxOutputs" }),
      }, ["model", "quality", "ratio", "count"]),
      availableModels: imageModels,
    }),
    modelAction({
      id: "canvas.video.generate",
      version: "1.0.0",
      label: "视频生成",
      category: "create",
      nodeType: "video",
      execution: "server",
      endpoint: "/api/workbench/canvas/generate",
      ...shared,
      requiresQuote: true,
      requiresApproval: true,
      offerSource: "model_catalog",
      inputPorts: [
        input("prompt", "text"),
        input("images", "image", false, 0, 30),
        input("videos", "video", false, 0, 10),
        input("audios", "audio", false, 0, 10),
      ],
      outputPorts: [output("video", "video")],
      parameterSchema: objectSchema({
        model: stringSchema({ source: "model_offer" }),
        operation: stringSchema({ source: "model_offer.videoGeneration.operations" }),
        resolution: stringSchema({ source: "model_offer.resolutions" }),
        duration: numberSchema({ source: "model_offer.duration" }),
        generateAudio: { type: "boolean", source: "model_offer.supportsGenerateAudio" },
      }, ["model", "resolution", "duration"]),
      availableModels: videoModels,
    }),
    ...(["draft", "finalize"] as const).map(phase => modelAction({
      id: `canvas.video.${phase}`, version: "1.0.0", label: phase === "draft" ? "视频样片" : "样片转正式片",
      category: "video", nodeType: "video", execution: "server", endpoint: "/api/workbench/canvas/draft",
      ...shared, requiresQuote: true, requiresApproval: true, offerSource: "runtime_quote",
      inputPorts: phase === "draft" ? [input("prompt", "text")] : [], outputPorts: [output("video", "video")],
      parameterSchema: objectSchema(phase === "draft" ? { renderMode: { const: "draft" }, resolution: { const: "480p" } }
        : { renderMode: { const: "finalize" }, draftTaskId: stringSchema({ description: "已成功的繁境样片任务编号，7 天内有效；不是视频 URL" }) }, phase === "draft" ? ["renderMode", "resolution"] : ["renderMode", "draftTaskId"]),
      availableModels: catalog.modelCatalog.videoModels.filter(model => model.canSubmit && model.videoGeneration?.draft?.enabled).length,
    })),
    modelAction({
      id: "canvas.video.extend",
      version: "1.0.0",
      label: "延长视频",
      category: "video",
      nodeType: "video",
      execution: "server",
      endpoint: "/api/workbench/canvas/generate",
      ...shared,
      requiresQuote: true,
      requiresApproval: true,
      offerSource: "model_catalog",
      inputPorts: [input("source", "video"), input("prompt", "text")],
      outputPorts: [output("video", "video")],
      parameterSchema: objectSchema({
        model: stringSchema({ source: "model_offer" }),
        mode: { const: "video_extension" },
        operation: { const: "extend" },
        ratio: { const: "adaptive", description: "画幅跟随原片，不接受固定画幅" },
        source: objectSchema({ assetVersionId: stringSchema({ source: "controlled_asset", description: "必须同时作为 video 参考素材提交" }) }, ["assetVersionId"]),
        resolution: stringSchema({ source: "model_offer.videoGeneration.operations.extend.nativeResolutions" }),
        duration: numberSchema({ source: "model_offer.videoGeneration.operations.extend.duration" }),
      }, ["model", "mode", "operation", "ratio", "source", "resolution", "duration"]),
      availableModels: catalog.modelCatalog.videoModels.filter((model) => model.canSubmit && model.videoGeneration?.dispatchable
        && model.videoGeneration.operations.some((operation) => operation.operation === "extend" && operation.enabled)).length,
    }),
    modelAction({
      id: "canvas.video.edit", version: "1.0.0", label: "修改视频", category: "video", nodeType: "video",
      execution: "server", endpoint: "/api/workbench/canvas/generate", ...shared,
      requiresQuote: true, requiresApproval: true, offerSource: "model_catalog",
      inputPorts: [input("source", "video"), input("prompt", "text"), input("references", "image", false, 0, 30)],
      outputPorts: [output("video", "video")],
      parameterSchema: objectSchema({
        model: stringSchema({ source: "model_offer" }), mode: { const: "video_edit" }, operation: { const: "edit" },
        ratio: { const: "adaptive" }, duration: { const: -1, description: "画幅和时长跟随 4–30 秒原片" },
        source: objectSchema({ assetVersionId: stringSchema({ source: "controlled_asset" }) }, ["assetVersionId"]),
        edit: objectSchema({ instruction: stringSchema({ description: "与 prompt 相同，包含完整修改与保留要求" }), preserve: { type: "array", maxItems: 0 } }, ["instruction"]),
        resolution: stringSchema({ source: "model_offer.videoGeneration.operations.edit.nativeResolutions" }),
      }, ["model", "mode", "operation", "ratio", "duration", "source", "edit", "resolution"]),
      availableModels: catalog.modelCatalog.videoModels.filter(model => model.canSubmit && model.videoGeneration?.dispatchable
        && model.videoGeneration.contractFamily === "seedance-2.5"
        && model.videoGeneration.operations.some(operation => operation.operation === "edit" && operation.enabled)).length,
    }),
    modelAction({
      id: "canvas.video.clip-rewrite",
      version: "1.0.0",
      label: "片段局部重绘",
      category: "video",
      nodeType: "video",
      execution: "server",
      endpoint: "/api/workbench/canvas/generate",
      ...shared,
      requiresQuote: true,
      requiresApproval: true,
      offerSource: "model_catalog",
      inputPorts: [input("source", "video")],
      outputPorts: [output("video", "video")],
      parameterSchema: objectSchema({
        model: stringSchema({ source: "model_offer" }),
        operation: { const: "edit" },
        sourceAssetVersionId: stringSchema({ source: "controlled_asset" }),
        startMs: numberSchema({ integer: true, minimum: 0 }),
        endMs: numberSchema({ integer: true, minimum: 1 }),
        instruction: stringSchema({ minLength: 1, maxLength: 8_000 }),
      }, ["model", "sourceAssetVersionId", "startMs", "endMs", "instruction"]),
      availableModels: timeRangeVideoEditModels,
    }),
    {
      id: "canvas.image.crop",
      version: "1.0.0",
      label: "图片裁剪",
      category: "image",
      nodeType: "image",
      execution: "browser",
      endpoint: null,
      status: "available",
      unavailableReason: null,
      ...shared,
      offerSource: "local",
      inputPorts: [input("image", "image")],
      outputPorts: [output("image", "image")],
      parameterSchema: objectSchema({ crop: { type: "object" } }, ["crop"]),
    },
    {
      id: "canvas.video.frame-extract",
      version: "1.0.0",
      label: "视频截帧",
      category: "video",
      nodeType: "image",
      execution: "browser",
      endpoint: null,
      status: "available",
      unavailableReason: null,
      ...shared,
      offerSource: "local",
      inputPorts: [input("video", "video")],
      outputPorts: [output("image", "image")],
      parameterSchema: objectSchema({ timeSeconds: numberSchema({ minimum: 0 }) }),
    },
    {
      id: "canvas.video.compose",
      version: "1.0.0",
      label: "成片合成",
      category: "video",
      nodeType: "compose",
      execution: "server",
      endpoint: "/api/workbench/canvas/composeVideo",
      status: "available",
      unavailableReason: null,
      ...shared,
      requiresQuote: true,
      requiresApproval: true,
      offerSource: "runtime_quote",
      inputPorts: [input("videos", "video", true, 1, 100), input("audios", "audio", false, 0, 100)],
      outputPorts: [output("video", "video")],
      parameterSchema: objectSchema({ timeline: { type: "array", maxItems: 200 } }, ["timeline"]),
    },
    {
      id: "canvas.video.enhance",
      version: "1.0.0",
      label: "视频超分",
      category: "video",
      nodeType: "video",
      execution: "server",
      endpoint: "/api/workbench/video/enhance/quote",
      status: "available",
      unavailableReason: null,
      ...shared,
      requiresQuote: true,
      requiresApproval: true,
      offerSource: "runtime_quote",
      inputPorts: [input("video", "video")],
      outputPorts: [output("video", "video")],
      parameterSchema: objectSchema({
        sourceResolution: stringSchema({ source: "asset_metadata" }),
        targetResolution: stringSchema({ source: "runtime_quote" }),
      }, ["sourceResolution", "targetResolution"]),
    },
    {
      id: "canvas.share.create",
      version: "1.0.0",
      label: "画布分享",
      category: "publish",
      nodeType: "text",
      execution: "server",
      endpoint: "/api/canvas/publication/shares",
      status: "available",
      unavailableReason: null,
      ...shared,
      offerSource: "none",
      inputPorts: [input("canvas", "canvas")],
      outputPorts: [output("publicLink", "text")],
      parameterSchema: objectSchema({
        expectedRevision: numberSchema({ integer: true, minimum: 1 }),
        expiresAt: numberSchema({ integer: true, minimum: 1 }),
      }, ["expectedRevision"]),
    },
    {
      id: "canvas.fjtv.publish",
      version: "1.0.0",
      label: "FJTV 投稿",
      category: "publish",
      nodeType: "video",
      execution: "server",
      endpoint: "/api/canvas/publication/fjtv",
      status: "available",
      unavailableReason: null,
      ...shared,
      requiresApproval: true,
      offerSource: "none",
      inputPorts: [input("canvas", "canvas")],
      outputPorts: [output("publication", "text")],
      parameterSchema: objectSchema({
        expectedRevision: numberSchema({ integer: true, minimum: 1 }),
        title: stringSchema({ maxLength: 500 }),
        description: stringSchema({ maxLength: 5_000 }),
      }, ["expectedRevision"]),
    },
    {
      id: "canvas.video.story-analysis",
      version: "1.0.0",
      label: "逐帧拉片",
      category: "understand",
      nodeType: "video",
      execution: "server",
      endpoint: "/api/workbench/canvas/videoStoryAnalysis",
      status: catalog.videoStoryAnalyzer?.available ? "available" : "unavailable",
      unavailableReason: catalog.videoStoryAnalyzer?.available
        ? null
        : "当前服务未配置 FFmpeg/ffprobe，本地逐帧拉片保持关闭",
      ...shared,
      offerSource: "local",
      inputPorts: [input("video", "video")],
      outputPorts: [output("analysis", "text")],
      parameterSchema: objectSchema({
        projectId: numberSchema({ integer: true, minimum: 1 }),
        assetVersionId: numberSchema({ integer: true, minimum: 1 }),
        maximumShots: numberSchema({ integer: true, minimum: 1, maximum: 40 }),
        rightsConfirmed: { const: true },
      }, ["projectId", "assetVersionId", "rightsConfirmed"]),
    },
  ];

  const unavailable = [
    ["canvas.audio.generate", "音频生成", "audio", "audio"],
    ["canvas.audio.transcribe", "音频识别", "audio", "text"],
    ["canvas.image.enhance", "图片高清", "image", "image"],
    ["canvas.image.outpaint", "图片扩图", "image", "image"],
    ["canvas.image.inpaint", "局部重绘", "image", "image"],
    ["canvas.image.erase", "图片擦除", "image", "image"],
    ["canvas.image.remove-background", "图片抠图", "image", "image"],
    ["canvas.image.reverse-prompt", "图片反推提示词", "understand", "text"],
    ["canvas.document.extract-text", "文档转文本", "understand", "text"],
    ["canvas.video.erase-subtitle", "视频去字幕", "video", "video"],
    ["canvas.video.separate-audio", "音频分离", "video", "audio"],
    ["canvas.audio.to-video", "音频转视频", "video", "video"],
  ] as const;
  for (const [id, label, category, outputMediaType] of unavailable) {
    actions.push(unavailableAction({
      id,
      version: "1.0.0",
      label,
      category,
      nodeType: outputMediaType === "audio" ? "audio" : outputMediaType === "video" ? "video" : "text",
      execution: "server",
      endpoint: null,
      ...shared,
      requiresQuote: true,
      requiresApproval: true,
      offerSource: "none",
      inputPorts: [],
      outputPorts: [output("result", outputMediaType)],
      parameterSchema: objectSchema({}),
    }, "尚无已发布的服务端执行合同；入口保持关闭"));
  }

  return {
    version: WORKBENCH_CANVAS_CAPABILITY_DIRECTORY_VERSION,
    modelCatalogVersion: String(catalog.modelCatalog.catalogVersion),
    modelCatalogPath: "/api/workbench/models/catalog",
    actions,
  };
}
