import type { CanvasNodeEditorPresentation } from "./CanvasCompactNodeEditorLauncher";
import type { CanvasCatalogVideoDuration } from "./canvasCatalogContract";
import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { type PromptEditorOptions } from "./canvasPromptEditor";
import type { CameraPresetKind, CameraSettings, NodeData, DraftLine, CreationMenuState, RatioPanelItem, ModelVisualMeta, CameraPresetOption } from "./canvasDataTypes";
import type { RatioKey, ImageOutpaintDraft, ImageCropDraft } from "./canvasMediaTypes";
import { AutoVideoDurationButton, videoDurationLabel } from "../../features/quick-create/AutoVideoDurationButton";
import { getCanvasCatalogImageQualities, normalizeCanvasCatalogVideoDuration, supportsCanvasCatalogVideoAudio, type CanvasCatalogVideoMode } from "./canvasCatalogContract";
import { isCanvasSourceVideoMode } from "./canvasVideoExtension";
import { Aperture, ArrowUp, Camera, ChevronDown, Image as ImageIcon, Link2, Minimize2, Music4, SlidersHorizontal, Square, X, Zap } from "lucide-react";
import { type AiModelOption } from "@/lib/api";
import { getModelDisplayName } from "./modelCatalog";

export interface CanvasNodeEditorDependencies {
  activeNode: NodeData | null;
  shouldHideCanvasPromptShell: (node: Pick<NodeData, "type" | "videoRenderMode">) => boolean;
  controlsPos: { uploadX: number; uploadY: number; promptX: number; promptY: number; } | null;
  draftLine: DraftLine | null;
  creationMenu: CreationMenuState;
  editingTextNodeId: string | null;
  activeNodeHasMedia: boolean;
  activeImageOutpaint: ImageOutpaintDraft | null;
  activeImageCrop: ImageCropDraft | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleUploadChange: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  nodeEditorPresentation: CanvasNodeEditorPresentation;
  nodeUploadIsActive: (node: NodeData) => boolean;
  renderCompactNodeEditorLauncher: () => ReactNode;
  renderCollapsedPromptShell: () => JSX.Element | null;
  renderVideoEnhancePanel: (node: NodeData) => ReactNode;
  renderImageEnhancePanel: (node: NodeData) => ReactNode;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  modelOpen: boolean;
  videoSettingsOpen: boolean;
  ratioOpen: boolean;
  quantityOpen: boolean;
  cameraOpen: boolean;
  referencePickerOpen: boolean;
  PROMPT_EXPANDED_WIDTH: 960;
  PROMPT_EXPANDED_HEIGHT: 600;
  PROMPT_PANEL_FONT_STACK: "\"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"Noto Sans SC\", sans-serif";
  renderUpstreamReferenceStrip: (options?: { showPickerButton?: boolean; compact?: boolean; marginClassName?: string; }) => JSX.Element | null;
  renderCanvasArtifactSourcePicker: (node: NodeData) => ReactNode;
  renderReferencePicker: () => JSX.Element | null;
  renderPromptEditor: (options: PromptEditorOptions) => JSX.Element;
  modelMenuOpenerRef: RefObject<HTMLButtonElement | null>;
  setModelOpen: Dispatch<SetStateAction<boolean>>;
  setRatioOpen: Dispatch<SetStateAction<boolean>>;
  setQuantityOpen: Dispatch<SetStateAction<boolean>>;
  setCameraOpen: Dispatch<SetStateAction<boolean>>;
  activePromptModelLabel: string;
  renderModelCatalogStatus: () => ReactNode;
  activeNodeModelOptions: AiModelOption[];
  getModelVisualMeta: (model: AiModelOption) => ModelVisualMeta;
  getAiModelUnavailableMessage: (model: AiModelOption) => string;
  setActiveNodeModel: (model: AiModelOption) => void;
  normalizeNodeResolution: (value: string | undefined) => "1K" | "2K" | "4K" | "720P" | "1080P";
  activeNodeModelOption: AiModelOption | undefined;
  setActiveNodeResolution: (next: "1K" | "2K" | "4K") => void;
  getCatalogRatioPanelItems: (model: AiModelOption | null | undefined, mode?: string) => RatioPanelItem[];
  setActiveNodeRatio: (nextRatio: RatioKey) => void;
  renderImageOutputCountSelector: () => ReactNode;
  openCameraPanel: () => void;
  activeNodeTotalPriceLabel: string;
  renderGenerateButton: (node: NodeData) => ReactNode;
  renderVideoPromptTabs: () => JSX.Element;
  renderStoryboardVideoPrompt: () => JSX.Element | null;
  activeStoryboardVideoInputs: { prompts: string[]; names: string[]; errors: string[]; };
  setVideoSettingsOpen: Dispatch<SetStateAction<boolean>>;
  videoSettingsTriggerRef: RefObject<HTMLButtonElement | null>;
  videoSettingsOpenerRef: RefObject<HTMLButtonElement | null>;
  buildVideoSettingsSummary: (node: NodeData, model?: AiModelOption) => string;
  getVideoResolutionOptions: (_modelId: string | undefined, model?: AiModelOption) => string[];
  normalizeVideoResolutionForModel: (modelId: string | undefined, value: string | undefined, model?: AiModelOption) => string;
  setActiveNodeResolutionGeneric: (next: string) => void;
  renderVideoOutputFormatPicker: () => ReactNode;
  parseDurationSeconds: (raw?: string) => number;
  activeNodeVideoDurationCapability: CanvasCatalogVideoDuration | null;
  setActiveNodeDuration: (nextSeconds: number) => void;
  activeNodeVideoDurationMode: "text_to_video" | "omni_reference" | "image_to_video" | "first_last_frame" | "image_reference" | "video_extension" | "video_edit" | null;
  setActiveNodeGenerateAudio: (enabled: boolean) => void;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  setStatus: Dispatch<SetStateAction<string>>;
  renderCanvasArtifactToolbar: (node: NodeData) => JSX.Element;
  cameraSemanticsEnabled: boolean;
  setCameraSemanticsEnabled: Dispatch<SetStateAction<boolean>>;
  findCameraPreset: (kind: CameraPresetKind, id: string) => CameraPresetOption;
  cameraDraft: CameraSettings;
  cycleCameraDraft: (kind: CameraPresetKind, direction: 1 | -1) => void;
  applyCameraDraft: () => void;
}

export function createCanvasNodeEditor(deps: CanvasNodeEditorDependencies) {
  const {
    activeNode,
    shouldHideCanvasPromptShell,
    controlsPos,
    draftLine,
    creationMenu,
    editingTextNodeId,
    activeNodeHasMedia,
    activeImageOutpaint,
    activeImageCrop,
    fileInputRef,
    handleUploadChange,
    nodeEditorPresentation,
    nodeUploadIsActive,
    renderCompactNodeEditorLauncher,
    renderCollapsedPromptShell,
    renderVideoEnhancePanel,
    renderImageEnhancePanel,
    setExpanded,
    modelOpen,
    videoSettingsOpen,
    ratioOpen,
    quantityOpen,
    cameraOpen,
    referencePickerOpen,
    PROMPT_EXPANDED_WIDTH,
    PROMPT_EXPANDED_HEIGHT,
    PROMPT_PANEL_FONT_STACK,
    renderUpstreamReferenceStrip,
    renderCanvasArtifactSourcePicker,
    renderReferencePicker,
    renderPromptEditor,
    modelMenuOpenerRef,
    setModelOpen,
    setRatioOpen,
    setQuantityOpen,
    setCameraOpen,
    activePromptModelLabel,
    renderModelCatalogStatus,
    activeNodeModelOptions,
    getModelVisualMeta,
    getAiModelUnavailableMessage,
    setActiveNodeModel,
    normalizeNodeResolution,
    activeNodeModelOption,
    setActiveNodeResolution,
    getCatalogRatioPanelItems,
    setActiveNodeRatio,
    renderImageOutputCountSelector,
    openCameraPanel,
    activeNodeTotalPriceLabel,
    renderGenerateButton,
    renderVideoPromptTabs,
    renderStoryboardVideoPrompt,
    activeStoryboardVideoInputs,
    setVideoSettingsOpen,
    videoSettingsTriggerRef,
    videoSettingsOpenerRef,
    buildVideoSettingsSummary,
    getVideoResolutionOptions,
    normalizeVideoResolutionForModel,
    setActiveNodeResolutionGeneric,
    renderVideoOutputFormatPicker,
    parseDurationSeconds,
    activeNodeVideoDurationCapability,
    setActiveNodeDuration,
    activeNodeVideoDurationMode,
    setActiveNodeGenerateAudio,
    setNodePatch,
    setStatus,
    renderCanvasArtifactToolbar,
    cameraSemanticsEnabled,
    setCameraSemanticsEnabled,
    findCameraPreset,
    cameraDraft,
    cycleCameraDraft,
    applyCameraDraft,
  } = deps;
  function renderCanvasNodeEditor() { return (activeNode && activeNode.type !== "script" && !shouldHideCanvasPromptShell(activeNode) && controlsPos && !draftLine && !(creationMenu.open && creationMenu.source === "connection") && !(activeNode.type === "text" && editingTextNodeId === activeNode.id) ? (
        <>
          {activeNode.type !== "text" && activeNode.type !== "image" && !activeNodeHasMedia && !activeNode.videoEnhanceMode && !activeNode.videoSubtitleEraseMode && !activeNode.imageEnhanceMode && !activeImageOutpaint && !activeImageCrop && !activeNode.imageTransformMode ? (
            <>
              <button
                data-fixed-ui
                className="absolute z-[80] -translate-x-1/2 rounded-md px-2 py-1 text-sm"
                style={{ left: controlsPos.uploadX, top: controlsPos.uploadY }}
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="inline-flex items-center gap-1">
                  <ArrowUp className="h-4 w-4" />
                  上传
                </span>
              </button>
            </>
          ) : null}
          {activeNode.type !== "text" ? (
            <input ref={fileInputRef} type="file" accept={activeNode.type === "video" ? "video/*" : activeNode.type === "audio" ? "audio/*" : "image/*"} className="hidden" onChange={handleUploadChange} />
          ) : null}
          {nodeEditorPresentation !== "expanded" ? (
            !nodeUploadIsActive(activeNode) ? (
              <>
                {!activeNode.imageEnhanceMode && !activeImageOutpaint && !activeImageCrop && !activeNode.imageTransformMode
                  ? nodeEditorPresentation === "compact"
                    ? renderCompactNodeEditorLauncher()
                    : renderCollapsedPromptShell()
                  : null}
                {renderVideoEnhancePanel(activeNode)}
                {renderImageEnhancePanel(activeNode)}
              </>
            ) : null
          ) : (
            <div
              data-node-expanded-editor-overlay
              className="absolute inset-0 z-[125] flex items-center justify-center bg-black/45"
              data-fixed-ui
              onMouseDown={() => setExpanded(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  // Floating menus are one layer below the expanded editor.
                  // Let the window handler close that layer and restore focus
                  // before a later Escape collapses the editor itself.
                  if (modelOpen || videoSettingsOpen || ratioOpen || quantityOpen || cameraOpen || referencePickerOpen) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setExpanded(false);
                }
              }}
            >
              <div
                data-node-prompt-panel
                data-node-id={activeNode.id}
                data-node-type={activeNode.type}
                data-node-editor-presentation="expanded"
                data-audio-prompt-panel={activeNode.type === "audio" ? "true" : undefined}
                className="relative overflow-hidden rounded-[16px] border border-[#343436] bg-[#282828] shadow-[0_30px_80px_rgba(0,0,0,0.52)]"
                style={{ width: PROMPT_EXPANDED_WIDTH, maxWidth: "calc(100vw - 120px)", height: PROMPT_EXPANDED_HEIGHT, maxHeight: "calc(100vh - 150px)", fontFamily: PROMPT_PANEL_FONT_STACK }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
              >
                <button
                  type="button"
                  aria-label="完成节点编辑"
                  title="完成并收起节点编辑器"
                  className="absolute right-4 top-4 z-30 inline-flex h-10 items-center justify-center gap-2 rounded-[10px] border border-[#55575b] bg-[#353538] px-3.5 text-[13px] font-semibold text-white shadow-[0_8px_20px_rgba(0,0,0,0.22)] transition hover:bg-[#414145] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8ed5f6]/45"
                  onClick={() => setExpanded(false)}
                >
                  <Minimize2 className="h-4 w-4" strokeWidth={2.1} aria-hidden="true" />
                  <span>完成</span>
                </button>

                {activeNode.type === "image" ? (
                  <div className="flex h-full flex-col px-5 pb-5 pt-5">
                    <div className="mb-4 flex items-start gap-3">
                      {renderUpstreamReferenceStrip({ showPickerButton: false, compact: true, marginClassName: "mb-0 ml-1" })}
                    </div>

                    {renderCanvasArtifactSourcePicker(activeNode)}
                    {renderReferencePicker()}
                    <div className="min-h-0 flex-1">
                      {renderPromptEditor({
                        value: activeNode.prompt,
                        placeholder: activeNode.textArtifactBindings?.some((binding) => activeNode.textArtifactSourceModes?.[binding.sourceNodeId] !== "body")
                          ? "补充画面要求（选填），例如：水墨风、全身像；留空按引用描述生成"
                          : activeNode.promptPlaceholder || "描述你想要生成的画面内容，按/呼出指令，@引用素材",
                        textareaClassName: "h-full min-h-[84px] w-full resize-none overflow-y-auto bg-transparent px-0 py-1 text-[24px] leading-[1.6] tracking-[0] outline-none",
                        previewClassName: "px-0 py-1 text-[24px] leading-[1.6] tracking-[0] text-[#9d9ea2]",
                      })}
                    </div>

                    <div className="mt-auto flex items-center pt-4 text-[12px] text-white">
                      <div className="relative mr-5">
                        <button
                          data-node-model-trigger
                          data-node-id={activeNode.id}
                          className={`inline-flex h-8 items-center gap-2 rounded-[9px] px-2.5 text-[12px] font-semibold transition ${modelOpen ? "bg-[#373739] text-white" : "text-white hover:bg-[#313133]"}`}
                          onClick={(event) => {
                            modelMenuOpenerRef.current = event.currentTarget;
                            setModelOpen((v) => !v);
                            setRatioOpen(false);
                            setQuantityOpen(false);
                            setCameraOpen(false);
                          }}
                        >
                          <X className="h-3.5 w-3.5" />
                          <span>{activePromptModelLabel}</span>
                          <ChevronDown className="h-3 w-3 text-[#9ea2a9]" />
                        </button>
                        {modelOpen ? (
                          <div data-node-floating-menu data-node-model-menu className="absolute bottom-[42px] left-0 z-[90] h-[392px] w-[372px] overflow-y-auto rounded-[18px] border border-[#494a4d] bg-[#282828] p-3 shadow-[0_26px_48px_rgba(0,0,0,0.48)]">
                            <div className="space-y-1.5">
                              {renderModelCatalogStatus()}
                              {activeNodeModelOptions
                                .filter((item) => item.type === "image")
                                .map((model) => {
                                  const meta = getModelVisualMeta(model);
                                  const unavailableMessage = getAiModelUnavailableMessage(model);
                                  return (
                                    <button
                                      key={model.id}
                                      data-node-model-item
                                      data-model-id={model.id}
                                      data-capability-status={model.capabilityStatus || "unverified"}
                                      data-selected={activeNode.model === model.id ? "true" : "false"}
                                      disabled={Boolean(unavailableMessage)}
                                      title={unavailableMessage || model.description}
                                      className={`flex w-full items-center justify-between rounded-[14px] px-3 py-2.5 text-left transition ${
                                        activeNode.model === model.id ? "bg-[#505052] text-white" : "text-[#f0f1f3] hover:bg-[#353537]"
                                      } ${unavailableMessage ? "cursor-not-allowed opacity-55 hover:bg-transparent" : ""}`}
                                      onClick={() => {
                          setActiveNodeModel(model);
                          setModelOpen(false);
                                      }}
                                    >
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-3">
                                          <div data-node-model-icon className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#3d3d40] text-[#e3e4e7]">
                                            {meta.icon === "image" ? <ImageIcon className="h-4 w-4" /> : meta.icon === "bars" ? <SlidersHorizontal className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                                          </div>
                                          <div className="min-w-0">
                                            <div className="truncate text-[15px] font-semibold">{getModelDisplayName(model)}</div>
                                            {unavailableMessage ? (
                                              <div className="truncate text-[12px] text-[#e6a45f]">{unavailableMessage}</div>
                                            ) : model.description ? (
                                              <div className="truncate text-[12px] text-[#a7aaaf]">{model.description}</div>
                                            ) : null}
                                          </div>
                                        </div>
                                      </div>
                                    </button>
                                  );
                                })}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="relative mr-5">
                        <button
                          data-node-image-settings-trigger
                          data-node-id={activeNode.id}
                          className={`inline-flex h-8 items-center gap-2 rounded-[9px] px-2 text-[12px] transition ${ratioOpen ? "bg-[#373739] text-white" : "text-white hover:bg-[#313133]"}`}
                          onClick={() => {
                            setRatioOpen((v) => !v);
                            setModelOpen(false);
                            setQuantityOpen(false);
                            setCameraOpen(false);
                          }}
                        >
                          <Square className="h-3.5 w-3.5 text-[#d8d8dc]" />
                          <span>{activeNode.ratio === "auto" ? "自适应" : activeNode.ratio} · {normalizeNodeResolution(activeNode.resolution)}</span>
                          <ChevronDown className="h-3 w-3 text-[#9ea2a9]" />
                        </button>
                        {ratioOpen ? (
                          <div className="absolute bottom-[42px] left-0 z-[90] w-[362px] rounded-[18px] border border-[#4d4e51] bg-[#282828] px-4 pb-4 pt-3 shadow-[0_26px_48px_rgba(0,0,0,0.48)]">
                            <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-white">
                              <ImageIcon className="h-3.5 w-3.5" />
                              图生图
                            </div>
                            <div className="mb-2 text-[13px] text-[#bbbcc0]">分辨率</div>
                            <div className={`mb-4 grid gap-2.5 ${getCanvasCatalogImageQualities(activeNodeModelOption).length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
                              {getCanvasCatalogImageQualities(activeNodeModelOption).map((res) => (
                                <button
                                  key={res}
                                  data-node-image-quality={res.toLowerCase()}
                                  className={`h-8 rounded-[10px] border text-[13px] transition ${
                                    normalizeNodeResolution(activeNode.resolution) === res ? "border-[#ededee] text-white" : "border-[#56575a] text-[#8f939a] hover:border-[#6a6b70] hover:text-[#d8dade]"
                                  }`}
                                  onClick={() => setActiveNodeResolution(res)}
                                >
                                  {res}
                                </button>
                              ))}
                            </div>
                            <div className="mb-2 text-[13px] text-[#bbbcc0]">比例</div>
                            <div className="grid grid-cols-5 gap-2.5">
                              {getCatalogRatioPanelItems(activeNodeModelOption).map((ratio) => {
                                const isActive = activeNode.ratio === ratio.key;
                                return (
                                  <button
                                    key={ratio.key}
                                    data-node-image-ratio={ratio.key}
                                    className={`flex h-[62px] flex-col items-center justify-center rounded-[10px] border transition ${
                                      isActive ? "border-[#f0f1f3] text-white" : "border-[#55565a] text-[#a4a7ae] hover:border-[#6d6e73] hover:text-[#dde0e4]"
                                    }`}
                                    onClick={() => setActiveNodeRatio(ratio.key)}
                                  >
                                    <span className="mb-2 block rounded-[2px] border border-current opacity-90" style={{ width: ratio.glyphWidth, height: ratio.glyphHeight }} />
                                    <span className="text-[12px]">{ratio.label}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      {renderImageOutputCountSelector()}

                      <button className={`inline-flex h-8 items-center gap-2 rounded-[9px] px-2 text-[12px] font-medium transition ${cameraOpen ? "bg-[#424245] text-white" : "text-white hover:bg-[#313133]"}`} onClick={openCameraPanel}>
                        <Aperture className="h-3.5 w-3.5" />
                        <span className={`h-1.5 w-1.5 rounded-full ${activeNode?.cameraControl ? "bg-[#3d9f6e]" : "bg-[#6b7280]"}`} aria-hidden="true" />
                        镜头语义
                      </button>

                      <div className="ml-auto flex items-center gap-3">
                        <div className="flex items-center gap-1 text-[12px] text-[#9a9ea7]">
                          <Zap className="h-3 w-3" />
                          <span>{activeNodeTotalPriceLabel}</span>
                        </div>
                        {renderGenerateButton(activeNode)}
                      </div>
                    </div>
                  </div>
                ) : activeNode.type === "video" ? (
                  <div className="flex h-full flex-col px-5 pb-5 pt-5">
                    {renderVideoPromptTabs()}

                    <div className="mb-4 flex items-start gap-3">
                      {renderUpstreamReferenceStrip({ showPickerButton: false, compact: true, marginClassName: "mb-0 ml-1" })}
                    </div>

                    {renderReferencePicker()}
                    {renderStoryboardVideoPrompt()}
                    <div className="min-h-0 flex-1">
                      {renderPromptEditor({
                        value: activeNode.prompt,
                        placeholder: activeStoryboardVideoInputs.prompts.length ? "补充视频要求（选填），留空按分镜中的动作、运镜和对白生成" : "描述你想要生成的画面内容，@引用素材",
                        textareaClassName: "h-full min-h-[84px] w-full resize-none overflow-y-auto bg-transparent px-0 py-1 text-[24px] leading-[1.6] tracking-[0] outline-none",
                        previewClassName: "px-0 py-1 text-[24px] leading-[1.6] tracking-[0] text-[#9d9ea2]",
                      })}
                    </div>

                    <div className="mt-auto flex items-center pt-4 text-[12px] text-white">
                      <div className="relative">
                        <button
                          data-node-model-trigger
                          data-node-id={activeNode.id}
                          className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] px-1 text-[12px] font-medium transition ${modelOpen ? "bg-[#3a3a3c]" : "text-white hover:bg-[#313133]"}`}
                          onClick={(event) => {
                            modelMenuOpenerRef.current = event.currentTarget;
                            setModelOpen((v) => !v);
                            setVideoSettingsOpen(false);
                            setQuantityOpen(false);
                            setCameraOpen(false);
                          }}
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                          <span>{activePromptModelLabel}</span>
                          <Zap className="h-3 w-3 text-[#e9b950]" />
                          <ChevronDown className="h-3 w-3 text-[#9ea2a9]" />
                        </button>
                        {modelOpen ? (
                          <div data-node-floating-menu data-node-model-menu className="absolute bottom-[44px] left-0 z-[90] h-[408px] w-[388px] overflow-y-auto rounded-[18px] border border-[#494a4d] bg-[#282828] p-3 shadow-[0_26px_48px_rgba(0,0,0,0.48)]">
                            <div className="space-y-2">
                              {renderModelCatalogStatus()}
                              {activeNodeModelOptions.map((model) => {
                                const meta = getModelVisualMeta(model);
                                const unavailableMessage = getAiModelUnavailableMessage(model);
                                const active = activeNode.model === model.id;
                                return (
                                  <button
                                    key={model.id}
                                    data-node-model-item
                                    data-model-id={model.id}
                                    data-capability-status={model.capabilityStatus || "unverified"}
                                    data-selected={active ? "true" : "false"}
                                    disabled={Boolean(unavailableMessage)}
                                    title={unavailableMessage || model.description}
                                    className={`flex w-full items-center justify-between rounded-[14px] px-3 py-2.5 text-left transition ${active ? "bg-[#505052] text-white" : "text-[#f0f1f3] hover:bg-[#353537]"} ${unavailableMessage ? "cursor-not-allowed opacity-55 hover:bg-transparent" : ""}`}
                                    onClick={() => {
                                      setActiveNodeModel(model);
                                      setModelOpen(false);
                                    }}
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-3">
                                        <div data-node-model-icon className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#3d3d40] text-[#e3e4e7]">
                                          {meta.icon === "image" ? <ImageIcon className="h-4 w-4" /> : meta.icon === "bars" ? <SlidersHorizontal className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                                        </div>
                                        <div className="min-w-0">
                                          <div className="flex items-center gap-2">
                                            <div className="truncate text-[15px] font-semibold">{getModelDisplayName(model)}</div>
                                          </div>
                                          {unavailableMessage ? (
                                            <div className="truncate text-[12px] text-[#e6a45f]">{unavailableMessage}</div>
                                          ) : model.description ? (
                                            <div className="truncate text-[12px] text-[#a7aaaf]">{model.description}</div>
                                          ) : null}
                                        </div>
                                      </div>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="relative ml-4">
                        <button
                          ref={videoSettingsTriggerRef}
                          data-node-video-settings-trigger
                          data-node-id={activeNode.id}
                          aria-expanded={videoSettingsOpen}
                          aria-controls={`node-video-settings-${activeNode.id}`}
                          className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] px-2 text-[12px] transition ${videoSettingsOpen ? "bg-[#3a3a3c]" : "text-white hover:bg-[#313133]"}`}
                          onClick={(event) => {
                            videoSettingsOpenerRef.current = event.currentTarget;
                            setVideoSettingsOpen((v) => !v);
                            setModelOpen(false);
                            setQuantityOpen(false);
                            setCameraOpen(false);
                          }}
                        >
                          <Square className="h-3.5 w-3.5 text-[#d8d8dc]" />
                          <span>{buildVideoSettingsSummary(activeNode, activeNodeModelOption)}</span>
                          <ChevronDown className="h-3 w-3 text-[#9ea2a9]" />
                        </button>
                        {videoSettingsOpen ? (
                          <div id={`node-video-settings-${activeNode.id}`} role="dialog" aria-label="视频参数" data-node-floating-menu data-node-video-settings-menu className="absolute bottom-[44px] left-0 z-[90] w-[356px] rounded-[18px] border border-[#4d4e51] bg-[#282828] px-4 pb-4 pt-3 shadow-[0_26px_48px_rgba(0,0,0,0.48)]">
                            <div className="mb-3 text-[13px] text-[#bbbcc0]">比例</div>
                            {isCanvasSourceVideoMode(activeNode.videoMode) ? (
                  <div data-video-extension-ratio className="rounded-[10px] border border-[#56575a] px-3 py-2 text-[13px] text-[#bbbcc0]">跟随原片 · 自动匹配画幅</div>
                ) : (<div className="grid grid-cols-5 gap-2.5">
                              {getCatalogRatioPanelItems(activeNodeModelOption, activeNode.videoMode).map((ratio) => {
                                const isActive = activeNode.ratio === ratio.key;
                                return (
                                  <button
                                    key={ratio.key}
                                    data-selected={isActive ? "true" : "false"}
                                    aria-pressed={isActive}
                                    className={`flex h-[62px] flex-col items-center justify-center rounded-[10px] border transition ${isActive ? "border-[#f0f1f3] text-white" : "border-[#55565a] text-[#a4a7ae] hover:border-[#6d6e73] hover:text-[#dde0e4]"}`}
                                    onClick={() => setActiveNodeRatio(ratio.key)}
                                  >
                                    <span className="mb-2 block rounded-[2px] border border-current opacity-90" style={{ width: ratio.glyphWidth, height: ratio.glyphHeight }} />
                                    <span className="text-[12px]">{ratio.label}</span>
                                  </button>
                                );
                              })}
                            </div>)}
                            <div className="mb-3 mt-4 text-[13px] text-[#bbbcc0]">清晰度</div>
                            {(activeNode.videoRenderMode === "draft" ? ["480P"] : getVideoResolutionOptions(activeNode.model, activeNodeModelOption)).length > 0 ? (
                              <div className={`grid gap-2.5 ${(activeNode.videoRenderMode === "draft" ? ["480P"] : getVideoResolutionOptions(activeNode.model, activeNodeModelOption)).length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
                              {(activeNode.videoRenderMode === "draft" ? ["480P"] : getVideoResolutionOptions(activeNode.model, activeNodeModelOption)).map((res) => {
                                return (
                                    <button
                                    key={res}
                                    data-node-video-resolution={res.toLowerCase()}
                                    data-selected={(activeNode.videoRenderMode === "draft" ? "480P" : normalizeVideoResolutionForModel(activeNode.model, activeNode.resolution, activeNodeModelOption)) === res ? "true" : "false"}
                                    aria-pressed={(activeNode.videoRenderMode === "draft" ? "480P" : normalizeVideoResolutionForModel(activeNode.model, activeNode.resolution, activeNodeModelOption)) === res}
                                    aria-label={res}
                                      className={`flex h-11 flex-col items-center justify-center rounded-[10px] border text-[13px] leading-tight transition ${(activeNode.videoRenderMode === "draft" ? "480P" : normalizeVideoResolutionForModel(activeNode.model, activeNode.resolution, activeNodeModelOption)) === res ? "border-[#ededee] text-white" : "border-[#56575a] text-[#8f939a] hover:border-[#6a6b70] hover:text-[#d8dade]"}`}
                                      onClick={() => setActiveNodeResolutionGeneric(res)}
                                    >
                                    <span>{res}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            ) : (
                              <div data-canvas-alert role="alert" className="rounded-[10px] border border-[#6c4d35] bg-[#39291f] px-3 py-2 text-[12px] leading-5 text-[#e0b28e]">
                                模型目录未声明可用清晰度，无法提交
                              </div>
                            )}
                            {renderVideoOutputFormatPicker()}
                            <div className="mb-2 mt-4 flex items-center justify-between text-[13px] text-[#bbbcc0]">
                              <span>视频时长</span>
                              <span>{activeNode.videoMode === "video_edit" ? "跟随原片" : videoDurationLabel(parseDurationSeconds(activeNode.duration))}</span>
                            </div>
                            <AutoVideoDurationButton supported={activeNode.videoMode !== "video_edit" && activeNodeVideoDurationCapability?.auto} selected={parseDurationSeconds(activeNode.duration) === -1} onSelect={() => setActiveNodeDuration(-1)} />
                {activeNode.videoMode === "video_edit" ? (<p className="mb-4 text-[13px]">时长跟随原片</p>) : activeNodeVideoDurationCapability ? (
                              <input
                                data-node-video-duration
                                type="range"
                                min={activeNodeVideoDurationCapability.min}
                                max={activeNodeVideoDurationCapability.max}
                                step={activeNodeVideoDurationCapability.step}
                                value={parseDurationSeconds(activeNode.duration) === -1 ? (activeNodeVideoDurationCapability?.min ?? 5) : normalizeCanvasCatalogVideoDuration(
                                  activeNodeModelOption,
                                  activeNodeVideoDurationMode as CanvasCatalogVideoMode,
                                  parseDurationSeconds(activeNode.duration),
                                ) ?? activeNodeVideoDurationCapability.default}
                                onChange={(event) => setActiveNodeDuration(Number(event.target.value))}
                                className="mb-4 h-1.5 w-full accent-[#2f84ff]"
                              />
                            ) : (
                              <div data-canvas-alert role="alert" className="mb-4 rounded-[10px] border border-[#6c4d35] bg-[#39291f] px-3 py-2 text-[12px] leading-5 text-[#e0b28e]">
                                模型目录未声明当前模式的可用时长
                              </div>
                            )}
                            <div className="mb-2 flex items-center gap-1 text-[13px] text-[#bbbcc0]">
                              <span>生成音频</span>
                              {!supportsCanvasCatalogVideoAudio(activeNodeModelOption) && <span className="text-[11px] text-[#81858c]">当前模型仅支持静音</span>}
                              <span className="text-[#81858c]">ⓘ</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2.5">
                              <button data-node-video-audio="on" disabled={!supportsCanvasCatalogVideoAudio(activeNodeModelOption)} title={supportsCanvasCatalogVideoAudio(activeNodeModelOption) ? undefined : "当前模型不支持生成音频"} data-selected={activeNode.videoGenerateAudio !== false ? "true" : "false"} aria-pressed={activeNode.videoGenerateAudio !== false} className={`h-8 rounded-[10px] border text-[13px] transition disabled:cursor-not-allowed disabled:opacity-40 ${activeNode.videoGenerateAudio !== false ? "border-[#ededee] text-white" : "border-[#56575a] text-[#8f939a]"}`} onClick={() => setActiveNodeGenerateAudio(true)}>
                                开启
                              </button>
                              <button data-node-video-audio="off" data-selected={activeNode.videoGenerateAudio === false ? "true" : "false"} aria-pressed={activeNode.videoGenerateAudio === false} className={`h-8 rounded-[10px] border text-[13px] transition ${activeNode.videoGenerateAudio === false ? "border-[#ededee] text-white" : "border-[#56575a] text-[#8f939a]"}`} onClick={() => setActiveNodeGenerateAudio(false)}>
                                关闭
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <button className="ml-5 inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] px-2 text-[12px] text-white hover:bg-[#313133]" onClick={openCameraPanel}>
                        <Aperture className="h-3.5 w-3.5" />
                        <span className={`h-1.5 w-1.5 rounded-full ${activeNode?.cameraControl ? "bg-[#3d9f6e]" : "bg-[#6b7280]"}`} aria-hidden="true" />
                        镜头语义
                      </button>

                      <div className="ml-auto flex items-center gap-4">
                        <button className={`inline-flex h-8 w-8 items-center justify-center rounded-[9px] ${videoSettingsOpen ? "bg-[#3a3a3c]" : "hover:bg-[#313133]"}`} onClick={() => {
                          setVideoSettingsOpen((v) => !v);
                          setModelOpen(false);
                          setQuantityOpen(false);
                          setCameraOpen(false);
                        }}>
                          <SlidersHorizontal className="h-4 w-4 text-[#e0e1e5]" />
                        </button>
                        <div className="flex items-center gap-1 text-[12px] text-[#9a9ea7]">
                          <Zap className="h-3 w-3" />
                          <span>{activeNodeTotalPriceLabel}</span>
                        </div>
                        {renderGenerateButton(activeNode)}
                      </div>
                    </div>
                  </div>
                ) : activeNode.type === "audio" ? (
                  <div data-audio-prompt-body className="flex h-full flex-col px-5 pb-5 pt-5">
                    <div className="min-h-0 flex-1">
                      <textarea
                        className="h-full w-full resize-none bg-transparent text-[30px] font-medium leading-[1.5] tracking-[0.01em] text-[#eef1f4] outline-none placeholder:text-[#8e939b]"
                        placeholder="输入要合成的文本"
                        value={activeNode.prompt}
                        onChange={(e) => setNodePatch(activeNode.id, { prompt: e.target.value })}
                      />
                    </div>
                    <div className="mt-4 flex items-center justify-between text-[12px] text-white">
                      <div className="flex items-center gap-2">
                        <button type="button" data-audio-chip className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] bg-[#353538] px-2.5 text-[12px] font-medium text-white">
                          <span>&lt;#&gt;</span>
                          停顿
                        </button>
                        <div className="text-[12px] text-[#f2f3f5]">0 语气词</div>
                      </div>
                    </div>
                    <div className="mt-auto flex items-center pt-4 text-[12px] text-white">
                      <button type="button" data-audio-model-control className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] px-1 text-[12px] font-medium text-white hover:bg-[#313133]">
                        <Music4 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{activePromptModelLabel}</span>
                        <ChevronDown className="h-3 w-3 text-[#9ea2a9]" />
                      </button>
                      <button
                        type="button"
                        data-audio-voice-control
                        data-selected="true"
                        aria-label={`当前音色：${activeNode.audioVoice || "少女音色"}`}
                        className="ml-4 inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] border border-transparent bg-[#343436] px-3 py-2 text-[12px] text-white transition-colors duration-150"
                        onClick={() => setStatus(`当前版本使用${activeNode.audioVoice || "少女音色"}`)}
                      >
                        <Music4 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{activeNode.audioVoice || "少女音色"}</span>
                        <ChevronDown className="h-3 w-3 text-[#b9bcc4]" aria-hidden="true" />
                      </button>
                      <div className="ml-auto flex items-center gap-4">
                        <button type="button" aria-label="音频设置" className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] hover:bg-[#313133]">
                          <SlidersHorizontal className="h-4 w-4 text-[#e0e1e5]" aria-hidden="true" />
                        </button>
                        <div className="shrink-0 whitespace-nowrap text-[12px] text-[#9a9ea7]">0/50000</div>
                        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] text-[#9a9ea7]">
                          <Zap className="h-3 w-3" />
                          <span>{activeNodeTotalPriceLabel}</span>
                        </div>
                        {renderGenerateButton(activeNode)}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full flex-col px-5 pb-5 pt-5">
                    {renderUpstreamReferenceStrip()}
                    {renderReferencePicker()}
                    {activeNode.type === "text" ? renderCanvasArtifactToolbar(activeNode) : null}
                    {renderPromptEditor({
                      value: activeNode.prompt,
                      placeholder: "写下你想讲的故事、场景或角色设定。例如：一个来自未来的机器人，在城市屋顶看星星。",
                      textareaClassName: "min-h-0 flex-1 w-full resize-none bg-transparent text-[14px] leading-[1.8] tracking-[0.01em] outline-none",
                      previewClassName: "text-[14px] leading-[1.8] tracking-[0.01em] text-[#d5d6da]",
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {cameraOpen && activeNode.type !== "text" ? (
            <div data-node-camera-overlay className="absolute inset-0 z-[130] flex items-center justify-center bg-black/40" data-fixed-ui>
              <div
                data-node-camera-panel
                className="relative w-[676px] rounded-[10px] border border-[#464646] bg-[#292929] pb-4 pt-3 shadow-[0_30px_60px_rgba(0,0,0,0.45)]"
                style={{ fontFamily: PROMPT_PANEL_FONT_STACK }}
              >
                <div className="flex items-center justify-between border-b border-[#3c3c3d] px-4 pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-[13px] font-semibold text-white">镜头语义</div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={cameraSemanticsEnabled}
                        aria-label="镜头语义开关"
                        onClick={() => setCameraSemanticsEnabled((value) => !value)}
                        className={`relative h-[18px] w-[32px] rounded-full transition ${cameraSemanticsEnabled ? "bg-[#3d9f6e]" : "bg-[#4a4a4c]"}`}
                      >
                        <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${cameraSemanticsEnabled ? "left-[16px]" : "left-[2px]"}`} />
                      </button>
                      <span className="text-[11px] text-[#8f9298]">{cameraSemanticsEnabled ? "已开启 · 会写入提示词" : "已关闭 · 不写入提示词"}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-[#8f9298]">作为提示词发送，最终效果取决于模型理解能力</div>
                  </div>
                  <button className="flex h-7 w-7 items-center justify-center rounded-md text-[#97979b] transition hover:bg-[#353537]" onClick={() => setCameraOpen(false)}>
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="grid grid-cols-4 px-6 pb-6 pt-8">
                  {([
                    { kind: "camera", title: "相机" },
                    { kind: "lens", title: "镜头" },
                    { kind: "focalLength", title: "焦距" },
                    { kind: "aperture", title: "光圈" },
                  ] as Array<{ kind: CameraPresetKind; title: string }>).map((column, index, list) => {
                    const preset = findCameraPreset(column.kind, cameraDraft[column.kind]);
                    return (
                      <div key={column.kind} className={`relative flex flex-col items-center ${index < list.length - 1 ? "border-r border-[#3f3f41]" : ""}`}>
                        <button
                          data-node-camera-control
                          className="mb-3 flex h-10 w-10 items-center justify-center rounded-full text-[#9c9ca0] transition hover:bg-[#353537] hover:text-white"
                          onClick={() => cycleCameraDraft(column.kind, -1)}
                        >
                          <ChevronDown className="h-3.5 w-3.5 rotate-180" />
                        </button>
                        <div data-node-camera-card className="flex h-[94px] w-[88px] flex-col items-center justify-center rounded-[14px] border border-[#545457] bg-[#2d2d2f] text-[#d4d5d8] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                          <div className="mb-2 text-[12px] text-[#babcc0]">{column.title}</div>
                          {column.kind === "camera" ? (
                            <Camera className="h-9 w-9 text-[#d8dade]" />
                          ) : column.kind === "lens" ? (
                            <div className="flex h-7 w-11 items-center justify-center rounded-full border border-[#66686d] bg-[radial-gradient(circle_at_center,#5d6067_0%,#2f3135_68%,#26282b_100%)] text-[10px] text-[#cfd1d7]">
                              lens
                            </div>
                          ) : column.kind === "focalLength" ? (
                            <div className="text-[18px] font-semibold text-white">{preset.heroText || preset.label}</div>
                          ) : (
                            <Aperture className="h-10 w-10 text-[#d0d2d6]" />
                          )}
                        </div>
                        <button
                          data-node-camera-control
                          className="mt-4 flex h-10 w-10 items-center justify-center rounded-full text-[#9c9ca0] transition hover:bg-[#353537] hover:text-white"
                          onClick={() => cycleCameraDraft(column.kind, 1)}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                        <div className="mt-4 text-center">
                          <div className="max-w-[118px] text-[12px] text-[#b8bbc0]">{preset.label}</div>
                          <div className="mt-2 text-[11px] text-[#8f9298]">{preset.sublabel}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex justify-end px-5">
                  <button
                    data-node-camera-apply
                    className="min-h-10 rounded-[10px] bg-white px-5 py-2 text-[13px] font-semibold text-black transition hover:bg-[#eaeaea]"
                    onClick={applyCameraDraft}
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null); }
  return renderCanvasNodeEditor;
}
