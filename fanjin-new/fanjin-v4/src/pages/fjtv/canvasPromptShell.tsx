import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { type PromptEditorOptions } from "./canvasPromptEditor";
import type { NodeData, ImageGridSplitEditorState, RatioPanelItem, ModelVisualMeta } from "./canvasDataTypes";
import type { RatioKey } from "./canvasMediaTypes";
import { AutoVideoDurationButton, videoDurationLabel } from "../../features/quick-create/AutoVideoDurationButton";
import { type CSSProperties } from "react";
import { getCanvasCatalogImageQualities, normalizeCanvasCatalogVideoDuration, supportsCanvasCatalogVideoAudio, type CanvasCatalogVideoDuration, type CanvasCatalogVideoMode } from "./canvasCatalogContract";
import { isCanvasSourceVideoMode } from "./canvasVideoExtension";
import { Aperture, Boxes, ChevronDown, Expand, Image as ImageIcon, Link2, Music4, SlidersHorizontal, Square, X, Zap } from "lucide-react";
import { type AiModelOption } from "@/lib/api";
import { getModelDisplayName } from "./modelCatalog";

export interface CanvasPromptShellDependencies {
  activeNode: NodeData | null;
  controlsPos: { uploadX: number; uploadY: number; promptX: number; promptY: number; } | null;
  shouldHideCanvasPromptShell: (node: Pick<NodeData, "type" | "videoRenderMode">) => boolean;
  activeVideoEditor: { nodeId: string; mode: "trim" | "erase-subtitle" | "erase-region"; } | null;
  imageGridSplitEditor: ImageGridSplitEditorState | null;
  getInlineNodeEditorStyle: (preferredWidth: number) => CSSProperties;
  renderNodeEditorPositionToggle: () => ReactNode;
  closePromptMenus: () => void;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  renderUpstreamReferenceStrip: (options?: { showPickerButton?: boolean; compact?: boolean; marginClassName?: string; }) => JSX.Element | null;
  renderCanvasArtifactSourcePicker: (node: NodeData) => ReactNode;
  renderReferencePicker: () => JSX.Element | null;
  renderPromptEditor: (options: PromptEditorOptions) => JSX.Element;
  modelOpen: boolean;
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
  ratioOpen: boolean;
  normalizeNodeResolution: (value: string | undefined) => "720P" | "1080P" | "2K" | "4K" | "1K";
  activeNodeModelOption: AiModelOption | undefined;
  setActiveNodeResolution: (next: "1K" | "2K" | "4K") => void;
  getCatalogRatioPanelItems: (model: AiModelOption | null | undefined, mode?: string) => RatioPanelItem[];
  setActiveNodeRatio: (nextRatio: RatioKey) => void;
  renderImageOutputCountSelector: () => ReactNode;
  cameraOpen: boolean;
  openCameraPanel: () => void;
  activeNodeTotalPriceLabel: string;
  renderGenerateButton: (node: NodeData) => ReactNode;
  renderCanvasArtifactToolbar: (node: NodeData) => JSX.Element;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  setStatus: Dispatch<SetStateAction<string>>;
  renderVideoPromptTabs: () => JSX.Element;
  renderStoryboardVideoPrompt: () => JSX.Element | null;
  activeStoryboardVideoInputs: { prompts: string[]; names: string[]; errors: string[]; };
  setVideoSettingsOpen: Dispatch<SetStateAction<boolean>>;
  videoSettingsTriggerRef: RefObject<HTMLButtonElement | null>;
  videoSettingsOpen: boolean;
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
}

export function createCanvasPromptShell(deps: CanvasPromptShellDependencies) {
  const {
    activeNode,
    controlsPos,
    shouldHideCanvasPromptShell,
    activeVideoEditor,
    imageGridSplitEditor,
    getInlineNodeEditorStyle,
    renderNodeEditorPositionToggle,
    closePromptMenus,
    setExpanded,
    renderUpstreamReferenceStrip,
    renderCanvasArtifactSourcePicker,
    renderReferencePicker,
    renderPromptEditor,
    modelOpen,
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
    ratioOpen,
    normalizeNodeResolution,
    activeNodeModelOption,
    setActiveNodeResolution,
    getCatalogRatioPanelItems,
    setActiveNodeRatio,
    renderImageOutputCountSelector,
    cameraOpen,
    openCameraPanel,
    activeNodeTotalPriceLabel,
    renderGenerateButton,
    renderCanvasArtifactToolbar,
    setNodePatch,
    setStatus,
    renderVideoPromptTabs,
    renderStoryboardVideoPrompt,
    activeStoryboardVideoInputs,
    setVideoSettingsOpen,
    videoSettingsTriggerRef,
    videoSettingsOpen,
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
  } = deps;
  function renderCollapsedPromptShell() {
    if (!activeNode || !controlsPos) return null;
    if (activeNode.type === "compose") return null;
    if (shouldHideCanvasPromptShell(activeNode)) return null;
    if (activeVideoEditor) return null;
    if (activeNode.type === "image" && imageGridSplitEditor?.nodeId === activeNode.id) return null;
    if (activeNode.videoEnhanceMode) return null;
    if (activeNode.videoSubtitleEraseMode) return null;

    if (activeNode.type === "image") {
      return (
        <div
          data-fixed-ui
          data-node-prompt-panel
          data-node-id={activeNode.id}
          data-node-type={activeNode.type}
          data-node-editor-presentation="inline"
          className="absolute z-[80] overflow-visible rounded-[16px] border border-[#3a3b3d] bg-[#282828] px-5 pb-4 pt-7 text-[#eceff5] shadow-[0_26px_52px_rgba(0,0,0,0.45)]"
          style={{
            ...getInlineNodeEditorStyle(940),
            minHeight: 250,
          }}
        >
          {renderNodeEditorPositionToggle()}
          <button
            className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center text-[#a1a3a7] transition hover:text-white"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closePromptMenus();
              setExpanded(true);
            }}
          >
            <Expand className="h-6 w-6" strokeWidth={2.1} />
          </button>

          <div className="mb-3 flex items-start gap-2.5">
            {renderUpstreamReferenceStrip({ showPickerButton: false, compact: true, marginClassName: "mb-0 ml-1" })}
          </div>

          {renderCanvasArtifactSourcePicker(activeNode)}
          {renderReferencePicker()}
          <div className="rounded-[14px] bg-transparent px-0 py-2.5">
            {renderPromptEditor({
              value: activeNode.prompt,
              placeholder: activeNode.textArtifactBindings?.some((binding) => activeNode.textArtifactSourceModes?.[binding.sourceNodeId] !== "body")
                ? "补充画面要求（选填），例如：水墨风、全身像；留空按引用描述生成"
                : activeNode.promptPlaceholder || "描述你想要生成的画面内容，按 / 呼出指令，@引用素材",
              textareaClassName: "min-h-[112px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0.5 text-[14px] font-normal leading-[1.8] tracking-[0.02em] outline-none",
              previewClassName: "px-0 py-0.5 text-[14px] font-normal leading-[1.8] tracking-[0.02em] text-[#cfd2d8]",
            })}
          </div>

          <div className="mt-3 flex items-center text-[12px] text-white">
            <div className="relative mr-5">
              <button
                data-node-model-trigger
                data-node-id={activeNode.id}
                className={`inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-[9px] px-2.5 text-[12px] font-semibold transition ${
                  modelOpen ? "bg-[#373739] text-white" : "text-white hover:bg-[#313133]"
                }`}
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
                className={`inline-flex h-8 items-center gap-2 rounded-[9px] px-2 text-[12px] transition ${
                  ratioOpen ? "bg-[#373739] text-white" : "text-white hover:bg-[#313133]"
                }`}
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
                <div data-node-floating-menu className="absolute bottom-[42px] left-0 z-[90] w-[362px] rounded-[18px] border border-[#4d4e51] bg-[#282828] px-4 pb-4 pt-3 shadow-[0_26px_48px_rgba(0,0,0,0.48)]">
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

            <button
              type="button"
              aria-pressed={Boolean(activeNode?.cameraControl)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-[9px] px-2 text-[12px] font-medium transition ${
                activeNode?.cameraControl
                  ? "bg-[#1f4d3a] text-[#8dffc4] ring-1 ring-[#3d9f6e]/60"
                  : "text-[#6b7280] hover:bg-[#313133] hover:text-[#c5c9d0]"
              } ${cameraOpen ? "ring-1 ring-[#8ed5f6]/50" : ""}`}
              onClick={openCameraPanel}
              title={activeNode?.cameraControl ? "镜头语义已开启 · 点击调整" : "镜头语义已关闭 · 点击打开并开启"}
            >
              <Aperture className={`h-4 w-4 ${activeNode?.cameraControl ? "" : "opacity-55"}`} />
              <span className="text-[11px]">{activeNode?.cameraControl ? "开" : "关"}</span>
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
      );
    }

    if (activeNode.type === "text") {
      return (
        <div
          data-fixed-ui
          data-node-prompt-panel
          data-node-id={activeNode.id}
          data-node-editor-presentation="inline"
          className="absolute z-[80] rounded-[16px] border border-[#454546] bg-[#2a2a2a] px-4 pb-3 pt-4 text-white shadow-[0_26px_52px_rgba(0,0,0,0.45)]"
          style={{ ...getInlineNodeEditorStyle(734), minHeight: 108 }}
        >
          {renderNodeEditorPositionToggle()}
          {renderUpstreamReferenceStrip()}
          {renderReferencePicker()}
          {renderCanvasArtifactToolbar(activeNode)}
          {renderPromptEditor({
            value: activeNode.prompt,
            placeholder: "写下你想讲的故事、场景或角色设定。例如：一个来自未来的机器人，在城市屋顶看星星。",
            textareaClassName: "h-[34px] w-full resize-none bg-transparent text-[14px] leading-[1.7] tracking-[0.01em] outline-none",
            previewClassName: "text-[14px] leading-[1.7] tracking-[0.01em] text-[#d5d6da]",
          })}
          <div className="mt-7 flex items-center text-[12px] text-white">
            <div className="relative">
              <button
                type="button"
                className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] px-1 text-[12px] font-medium transition ${modelOpen ? "bg-[#3a3a3c]" : "text-white hover:bg-[#313133]"}`}
                onClick={(event) => {
                  modelMenuOpenerRef.current = event.currentTarget;
                  setModelOpen((value) => !value);
                  setRatioOpen(false);
                  setQuantityOpen(false);
                  setCameraOpen(false);
                }}
              >
                <Boxes className="h-3.5 w-3.5" />
                <span>{activePromptModelLabel}</span>
                <ChevronDown className="h-3 w-3 text-[#9ea2a9]" />
              </button>
              {modelOpen ? (
                <div data-node-floating-menu data-node-model-menu className="absolute bottom-[42px] left-0 z-[90] max-h-[360px] w-[372px] overflow-y-auto rounded-[18px] border border-[#494a4d] bg-[#282828] p-3 shadow-[0_26px_48px_rgba(0,0,0,0.48)]">
                  <div className="space-y-1.5">
                    {renderModelCatalogStatus()}
                    {activeNodeModelOptions.map((model) => {
                      const unavailableMessage = getAiModelUnavailableMessage(model);
                      const selected = activeNode.model === model.id;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          data-node-model-item
                          data-capability-status={model.capabilityStatus || "unverified"}
                          data-selected={selected ? "true" : "false"}
                          disabled={Boolean(unavailableMessage)}
                          title={unavailableMessage || model.description}
                          className={`flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition ${selected ? "bg-[#505052] text-white" : "text-[#f0f1f3] hover:bg-[#353537]"} ${unavailableMessage ? "cursor-not-allowed opacity-55 hover:bg-transparent" : ""}`}
                          onClick={() => {
                            setActiveNodeModel(model);
                            setModelOpen(false);
                          }}
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#3d3d40] text-[#e3e4e7]">
                            <Boxes className="h-4 w-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-[15px] font-semibold">{getModelDisplayName(model)}</span>
                            <span className={`block truncate text-[12px] ${unavailableMessage ? "text-[#e6a45f]" : "text-[#a7aaaf]"}`}>
                              {unavailableMessage || model.description || "对话与脚本生成"}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="ml-auto flex items-center gap-4">
              <div className="flex items-center gap-1 text-[12px] text-[#9a9ea7]">
                <Zap className="h-3 w-3" />
                <span>{activeNodeTotalPriceLabel}</span>
              </div>
              {renderGenerateButton(activeNode)}
            </div>
          </div>
        </div>
      );
    }

    if (activeNode.type === "audio") {
      return (
        <div
          data-fixed-ui
          data-node-prompt-panel
          data-audio-prompt-panel
          className="absolute z-[80] overflow-visible rounded-[16px] border border-[#3f4042] bg-[#2a2a2a] px-4 pb-4 pt-10 text-white shadow-[0_26px_52px_rgba(0,0,0,0.45)]"
          style={{ ...getInlineNodeEditorStyle(740), minHeight: 212 }}
        >
          {renderNodeEditorPositionToggle()}
          <button type="button" aria-label="展开音频编辑器" className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center text-[#a1a3a7] transition hover:text-white" onClick={() => setExpanded(true)}>
            <Expand className="h-6 w-6" strokeWidth={2.1} aria-hidden="true" />
          </button>

          <textarea
            className="h-[132px] w-full resize-none bg-transparent text-[28px] font-medium leading-[1.5] tracking-[0.01em] text-[#d3d4d7] outline-none placeholder:text-[#8e939b]"
            placeholder="输入要合成的文本"
            value={activeNode.prompt}
            onChange={(e) => setNodePatch(activeNode.id, { prompt: e.target.value })}
          />

          <div className="mt-4 flex items-center justify-between text-[12px] text-white">
            <div className="flex items-center gap-2">
              <button type="button" data-audio-chip className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] bg-[#353538] px-2.5 text-[12px] font-medium text-white">
                <span>&lt;#&gt;</span>
                停顿
              </button>
              <div className="text-[12px] text-[#f2f3f5]">0 语气词</div>
            </div>
          </div>

          <div className="mt-4 flex items-center text-[12px] text-white">
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
      );
    }

    return (
      <div
        data-fixed-ui
        data-node-prompt-panel
        data-node-id={activeNode.id}
        data-node-type={activeNode.type}
        data-node-editor-presentation="inline"
        className="absolute z-[80] overflow-visible rounded-[16px] border border-[#3f4042] bg-[#2a2a2a] px-5 pb-4 pt-7 text-white shadow-[0_26px_52px_rgba(0,0,0,0.45)]"
        style={{ ...getInlineNodeEditorStyle(940), minHeight: 260 }}
      >
          {renderNodeEditorPositionToggle()}
        <button
          className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center text-[#a1a3a7] transition hover:text-white"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            closePromptMenus();
            setExpanded(true);
          }}
        >
          <Expand className="h-6 w-6" strokeWidth={2.1} />
        </button>

        {renderVideoPromptTabs()}

        <div className="mb-3 flex items-start gap-2.5">
          {renderUpstreamReferenceStrip({ showPickerButton: false, compact: true, marginClassName: "mb-0 ml-1" })}
        </div>

        {renderReferencePicker()}
        {renderStoryboardVideoPrompt()}
        <div className="rounded-[14px] bg-transparent px-0 py-2.5">
          {renderPromptEditor({
            value: activeNode.prompt,
            placeholder: activeStoryboardVideoInputs.prompts.length ? "补充视频要求（选填），留空按分镜中的动作、运镜和对白生成" : "描述你想要生成的画面内容，@引用素材",
            textareaClassName: "min-h-[112px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0.5 text-[14px] font-normal leading-[1.8] tracking-[0.02em] outline-none",
            previewClassName: "px-0 py-0.5 text-[14px] font-normal leading-[1.8] tracking-[0.02em] text-[#cfd2d8]",
          })}
        </div>

        <div className="mt-6 flex items-center text-[12px] text-white">
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
                  <button
                    data-node-video-audio="on"
                    disabled={!supportsCanvasCatalogVideoAudio(activeNodeModelOption)}
                    title={supportsCanvasCatalogVideoAudio(activeNodeModelOption) ? undefined : "当前模型不支持生成音频"}
                    data-selected={activeNode.videoGenerateAudio !== false ? "true" : "false"}
                    aria-pressed={activeNode.videoGenerateAudio !== false}
                    className={`h-8 rounded-[10px] border text-[13px] transition disabled:cursor-not-allowed disabled:opacity-40 ${activeNode.videoGenerateAudio !== false ? "border-[#ededee] text-white" : "border-[#56575a] text-[#8f939a]"}`}
                    onClick={() => setActiveNodeGenerateAudio(true)}
                  >
                    开启
                  </button>
                  <button
                    data-node-video-audio="off"
                    data-selected={activeNode.videoGenerateAudio === false ? "true" : "false"}
                    aria-pressed={activeNode.videoGenerateAudio === false}
                    className={`h-8 rounded-[10px] border text-[13px] transition ${activeNode.videoGenerateAudio === false ? "border-[#ededee] text-white" : "border-[#56575a] text-[#8f939a]"}`}
                    onClick={() => setActiveNodeGenerateAudio(false)}
                  >
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
            <button
              type="button"
              aria-label="视频参数快捷设置"
              aria-expanded={videoSettingsOpen}
              aria-controls={`node-video-settings-${activeNode.id}`}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-[9px] ${videoSettingsOpen ? "bg-[#3a3a3c]" : "hover:bg-[#313133]"}`}
              onClick={(event) => {
                videoSettingsOpenerRef.current = event.currentTarget;
                setVideoSettingsOpen((v) => !v);
                setModelOpen(false);
                setQuantityOpen(false);
                setCameraOpen(false);
              }}
            >
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
    );
  }
  return renderCollapsedPromptShell;
}
