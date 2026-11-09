import { CanvasRedrawButton } from "./CanvasRedrawProvider";
import { IMAGE_GRID_PRESETS, STORYBOARD_RATIO_ITEMS, STORYBOARD_STITCH_RESOLUTIONS, IMAGE_GRID_CUSTOM_MAX, IMAGE_NINE_GRID_MENU_ITEMS, OPEN_IMAGE_NINE_GRID_MENU_ITEMS, IMAGE_HD_MENU_ITEMS, OPEN_IMAGE_HD_MENU_ITEMS, IMAGE_TRANSFORM_MENU_ITEMS, OPEN_IMAGE_TRANSFORM_MENU_ITEMS } from "./canvasMediaMenuConfig";
import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { NodeData, ImageGridSplitEditorState } from "./canvasDataTypes";
import { draftExpiryLabel } from "./canvasVideoDraft";
import { type CanvasRealCapabilities } from "./canvasCapabilities";
import { ArrowUp, Boxes, ChevronDown, Download, Expand, LayoutGrid, LoaderCircle, NotebookTabs, Repeat2, Scissors, Sparkles, Undo2 } from "lucide-react";

export interface CanvasNodeMediaToolbarDependencies {
  imageGridSplitEditor: ImageGridSplitEditorState | null;
  getCanvasToolbarTop: (targetTop: number, visualOffset?: number) => number;
  getCanvasToolbarScale: (multiplier?: number) => number;
  setImageNineGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageHdMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomPreview: Dispatch<SetStateAction<{ nodeId: string; rows: number; cols: number; } | null>>;
  setImageTransformMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setVideoEnhanceResolutionOpen: Dispatch<SetStateAction<boolean>>;
  imageNineGridMenuNodeId: string | null;
  handleNineGridMenuAction: (node: NodeData, item: (typeof IMAGE_NINE_GRID_MENU_ITEMS)[number]) => void;
  renderNineGridMenuIcon: (kind: (typeof IMAGE_NINE_GRID_MENU_ITEMS)[number]["icon"]) => JSX.Element;
  imageHdMenuNodeId: string | null;
  handleImageHdMenuAction: (node: NodeData, item: (typeof IMAGE_HD_MENU_ITEMS)[number]) => void;
  imageGridMenuNodeId: string | null;
  openImageGridSplitEditor: (node: NodeData, rows: number, cols: number) => void;
  imageGridCustomMenuNodeId: string | null;
  imageGridCustomPreview: { nodeId: string; rows: number; cols: number; } | null;
  imageTransformMenuNodeId: string | null;
  handleImageTransformMenuAction: (node: NodeData, item: (typeof IMAGE_TRANSFORM_MENU_ITEMS)[number]) => void;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  downloadNodeMedia: (node: NodeData) => Promise<void>;
  openMediaViewer: (node: NodeData | null | undefined) => void;
  createDraftFinalNode: (source: NodeData) => void;
  canvasCapabilities: CanvasRealCapabilities;
  submitVideoClipRewrite: (node: NodeData) => Promise<boolean>;
  showVideoRewriteVersion: (node: NodeData, viewing: "source" | "output") => void;
  restoreVideoRewriteSource: (node: NodeData) => void;
  submitVideoStoryAnalysis: (sourceNode: NodeData, retryOfTaskId?: number) => Promise<void>;
  openVideoEnhanceEditor: (node: NodeData) => Promise<void>;
}

export function createCanvasNodeMediaToolbar(deps: CanvasNodeMediaToolbarDependencies) {
  const {
    imageGridSplitEditor,
    getCanvasToolbarTop,
    getCanvasToolbarScale,
    setImageNineGridMenuNodeId,
    setImageHdMenuNodeId,
    setImageGridMenuNodeId,
    setImageGridCustomMenuNodeId,
    setImageGridCustomPreview,
    setImageTransformMenuNodeId,
    setVideoEnhanceResolutionOpen,
    imageNineGridMenuNodeId,
    handleNineGridMenuAction,
    renderNineGridMenuIcon,
    imageHdMenuNodeId,
    handleImageHdMenuAction,
    imageGridMenuNodeId,
    openImageGridSplitEditor,
    imageGridCustomMenuNodeId,
    imageGridCustomPreview,
    imageTransformMenuNodeId,
    handleImageTransformMenuAction,
    setActiveNodeId,
    fileInputRef,
    downloadNodeMedia,
    openMediaViewer,
    createDraftFinalNode,
    canvasCapabilities,
    submitVideoClipRewrite,
    showVideoRewriteVersion,
    restoreVideoRewriteSource,
    submitVideoStoryAnalysis,
    openVideoEnhanceEditor,
  } = deps;
  function renderNodeMediaToolbar(node: NodeData) {
    const commonButton = "inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap px-3.5 text-[13px] text-white/95 transition hover:text-white";
    if (node.type === "image") {
      if (imageGridSplitEditor?.nodeId === node.id) return null;
      return (
        <div
          data-node-toolbar
          className="absolute z-30 flex items-center rounded-[16px] border border-[#4a4b50] bg-[#2a2a2b] px-4 py-2 shadow-[0_20px_42px_rgba(0,0,0,0.38)]"
          style={{ left: node.x + node.width / 2, top: getCanvasToolbarTop(node.y, 74), transform: `translateX(-50%) scale(${getCanvasToolbarScale()})`, transformOrigin: "center top" }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="relative">
            <button
              className={commonButton}
              onClick={() => {
                setImageNineGridMenuNodeId((prev) => (prev === node.id ? null : node.id));
                setImageHdMenuNodeId(null);
                setImageGridMenuNodeId(null);
                setImageGridCustomMenuNodeId(null);
                setImageGridCustomPreview(null);
                setImageTransformMenuNodeId(null);
                setVideoEnhanceResolutionOpen(false);
              }}
            >
              <LayoutGrid className="h-4 w-4" />
              <span>九宫格</span>
              <ChevronDown className="h-3 w-3 text-[#a5a8ae]" />
            </button>
            {imageNineGridMenuNodeId === node.id ? (
              <div data-node-floating-menu className="absolute left-0 top-[calc(100%+10px)] z-[90] w-[224px] overflow-hidden rounded-[16px] border border-white/10 bg-[#343537] shadow-[0_24px_64px_rgba(0,0,0,0.4)]">
                <div className="max-h-[360px] overflow-y-auto px-2 py-2">
                {OPEN_IMAGE_NINE_GRID_MENU_ITEMS.map((item) => (
                    <button
                      key={item.key}
                      className="flex w-full items-center gap-3 rounded-[10px] px-3 py-3 text-left text-[14px] text-white/88 transition hover:bg-white/8 hover:text-white"
                      onClick={() => handleNineGridMenuAction(node, item)}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-white/82">{renderNineGridMenuIcon(item.icon)}</span>
                      <span className="leading-none">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <div className="relative">
            <button
              className={commonButton}
              onClick={() => {
                setImageHdMenuNodeId((prev) => (prev === node.id ? null : node.id));
                setImageNineGridMenuNodeId(null);
                setImageGridMenuNodeId(null);
                setImageGridCustomMenuNodeId(null);
                setImageGridCustomPreview(null);
                setImageTransformMenuNodeId(null);
                setVideoEnhanceResolutionOpen(false);
              }}
            >
              <Scissors className="h-4 w-4" />
              <span>裁剪</span>
              <ChevronDown className="h-3 w-3 text-[#a5a8ae]" />
            </button>
            {imageHdMenuNodeId === node.id ? (
              <div data-node-floating-menu className="absolute left-0 top-[calc(100%+10px)] z-[90] min-w-[134px] overflow-hidden rounded-[16px] border border-white/10 bg-[#343537] px-2 py-2 shadow-[0_24px_64px_rgba(0,0,0,0.4)]">
                {OPEN_IMAGE_HD_MENU_ITEMS.map((item) => (
                  <button
                    key={item.key}
                    className="block h-11 w-full rounded-[10px] px-3 text-left text-[14px] text-white/88 transition hover:bg-white/8 hover:text-white"
                    onClick={() => handleImageHdMenuAction(node, item)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="relative">
            <button
              className={commonButton}
              onClick={() => {
                setImageGridMenuNodeId((prev) => (prev === node.id ? null : node.id));
                setImageNineGridMenuNodeId(null);
                setImageHdMenuNodeId(null);
                setImageGridCustomMenuNodeId(null);
                setImageGridCustomPreview(null);
                setImageTransformMenuNodeId(null);
                setVideoEnhanceResolutionOpen(false);
              }}
            >
              <Boxes className="h-4 w-4" />
              <span>宫格切分</span>
              <ChevronDown className="h-3 w-3 text-[#a5a8ae]" />
            </button>
            {imageGridMenuNodeId === node.id ? (
              <>
                <div data-node-floating-menu className="absolute left-0 top-[calc(100%+10px)] z-[90] w-[198px] overflow-hidden rounded-[16px] border border-white/10 bg-[#343537] shadow-[0_24px_64px_rgba(0,0,0,0.4)]">
                  <div className="max-h-[360px] overflow-y-auto px-2 py-2">
                    {IMAGE_GRID_PRESETS.map((preset) => (
                      <button
                        key={preset.key}
                        className="flex w-full items-center justify-between rounded-[10px] px-3 py-3 text-left text-[14px] text-white/88 transition hover:bg-white/8 hover:text-white"
                        onClick={() => openImageGridSplitEditor(node, preset.rows, preset.cols)}
                      >
                        <span>{preset.label}</span>
                      </button>
                    ))}
                    <div className="my-1 h-px bg-white/8" />
                    <button
                      className="flex w-full items-center justify-between rounded-[10px] px-3 py-3 text-left text-[14px] text-white/88 transition hover:bg-white/8 hover:text-white"
                      onClick={() => {
                        setImageGridCustomMenuNodeId((prev) => {
                          const nextOpen = prev === node.id ? null : node.id;
                          setImageGridCustomPreview(nextOpen ? { nodeId: node.id, rows: 2, cols: 2 } : null);
                          return nextOpen;
                        });
                      }}
                    >
                      <span>自定义</span>
                      <ChevronDown className="h-4 w-4 -rotate-90 text-white/55" />
                    </button>
                  </div>
                </div>
                {imageGridCustomMenuNodeId === node.id && imageGridCustomPreview ? (
                  <div data-node-floating-menu className="absolute left-[calc(100%+14px)] top-[calc(100%+10px)] z-[91] w-[214px] rounded-[18px] border border-white/10 bg-[#333436] p-[10px] shadow-[0_24px_64px_rgba(0,0,0,0.42)]">
                    <div className="rounded-[14px] bg-[#3a3b3d] px-[14px] pb-[14px] pt-[12px]">
                      <div className="mb-[14px] flex items-center justify-between text-[12px] font-medium text-white/72">
                        <span>自定义宫格</span>
                        <span>{imageGridCustomPreview.nodeId === node.id ? `${imageGridCustomPreview.rows} x ${imageGridCustomPreview.cols}` : "2 x 2"}</span>
                      </div>
                      <div className="grid grid-cols-5 gap-[8px]">
                        {Array.from({ length: IMAGE_GRID_CUSTOM_MAX * IMAGE_GRID_CUSTOM_MAX }, (_, index) => {
                          const row = Math.floor(index / IMAGE_GRID_CUSTOM_MAX);
                          const col = index % IMAGE_GRID_CUSTOM_MAX;
                          const preview = imageGridCustomPreview.nodeId === node.id ? imageGridCustomPreview : { nodeId: node.id, rows: 2, cols: 2 };
                          const active = row < preview.rows && col < preview.cols;
                          return (
                            <button
                              key={`${row}-${col}`}
                              className={`h-[28px] w-[28px] rounded-[5px] border transition ${active ? "border-[#6ea7ff] bg-[#4f83ff]" : "border-white/6 bg-[#55575a] hover:border-white/16 hover:bg-[#66686c]"}`}
                              onMouseEnter={() => setImageGridCustomPreview({ nodeId: node.id, rows: row + 1, cols: col + 1 })}
                              onClick={() => {
                                openImageGridSplitEditor(node, row + 1, col + 1);
                                setImageGridCustomMenuNodeId(null);
                                setImageGridCustomPreview(null);
                              }}
                              title={`${row + 1} x ${col + 1}`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="mx-1 h-6 w-px bg-[#3e3f43]" />
          <div className="relative">
            <button
              className="inline-flex h-9 w-9 items-center justify-center text-white/95 hover:text-white"
              onClick={() => {
                setImageTransformMenuNodeId((prev) => (prev === node.id ? null : node.id));
                setImageNineGridMenuNodeId(null);
                setImageHdMenuNodeId(null);
                setImageGridMenuNodeId(null);
                setImageGridCustomMenuNodeId(null);
                setImageGridCustomPreview(null);
              }}
            >
              <Sparkles className="h-4 w-4" />
            </button>
            {imageTransformMenuNodeId === node.id ? (
              <div data-node-floating-menu className="absolute right-0 top-[calc(100%+10px)] z-[90] min-w-[188px] overflow-hidden rounded-[16px] border border-white/10 bg-[#343537] px-2 py-2 shadow-[0_24px_64px_rgba(0,0,0,0.4)]">
                {OPEN_IMAGE_TRANSFORM_MENU_ITEMS.map((item) => (
                  <button
                    key={item.key}
                    className="block h-11 w-full rounded-[10px] px-3 text-left text-[14px] text-white/88 transition hover:bg-white/8 hover:text-white"
                    onClick={() => handleImageTransformMenuAction(node, item)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            className="inline-flex h-9 w-9 items-center justify-center text-white/95 hover:text-white"
            onClick={() => {
              setActiveNodeId(node.id);
              fileInputRef.current?.click();
            }}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
          <button className="inline-flex h-9 w-9 items-center justify-center text-white/95 hover:text-white" onClick={() => void downloadNodeMedia(node)}>
            <Download className="h-4 w-4" />
          </button>
          <button className="inline-flex h-9 w-9 items-center justify-center text-white/95 hover:text-white" onClick={() => openMediaViewer(node)}>
            <Expand className="h-4 w-4" />
          </button>
        </div>
      );
    }

    if (node.type === "video") {
      return (
        <div
          data-node-toolbar
          className="absolute z-30 flex items-center rounded-[16px] border border-[#4a4b50] bg-[#2a2a2b] px-4 py-2 shadow-[0_20px_42px_rgba(0,0,0,0.38)]"
          style={{ left: node.x + node.width / 2, top: getCanvasToolbarTop(node.y, 74), transform: `translateX(-50%) scale(${getCanvasToolbarScale()})`, transformOrigin: "center top" }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {(node.videoUrl || node.localVideoUrl || node.videoWorkflow === "redraw") ? <CanvasRedrawButton node={node} className={commonButton}/> : null}
          {node.videoRenderMode === "draft" && node.videoDraftTaskId ? <>
            <button data-video-draft-finalize className={`${commonButton} disabled:opacity-45`} disabled={Boolean(node.isGenerating || node.videoDraftExpiresAt && Date.now() >= node.videoDraftExpiresAt)}
              title={draftExpiryLabel(node.videoDraftExpiresAt)} onClick={() => createDraftFinalNode(node)}><Sparkles className="h-4 w-4" /><span>生成 1080p 正式片</span></button>
            <div className="mx-1 h-6 w-px bg-[#3e3f43]" />
          </> : null}
          {canvasCapabilities.videoClipRewrite ? (
            <>
              <button
                data-video-clip-rewrite-button
                className={`${commonButton} pl-1 disabled:cursor-not-allowed disabled:opacity-45`}
                disabled={Boolean(node.isGenerating || node.videoRewritePending)}
                onClick={() => void submitVideoClipRewrite(node)}
              >
                <Sparkles className="h-4 w-4" />
                <span>局部重绘</span>
              </button>
              <div className="mx-1 h-6 w-px bg-[#3e3f43]" />
            </>
          ) : null}
          {node.videoRewriteSourceVideoUrl && node.videoRewriteOutputVideoUrl ? (
            <>
              <button
                data-video-rewrite-compare-button
                className={`${commonButton} pl-1`}
                onClick={() => showVideoRewriteVersion(
                  node,
                  node.videoRewriteViewing === "source" ? "output" : "source",
                )}
              >
                <Repeat2 className="h-4 w-4" />
                <span>{node.videoRewriteViewing === "source" ? "查看重绘" : "对比原片"}</span>
              </button>
              {node.videoRewriteViewing !== "source" ? (
                <button
                  data-video-rewrite-restore-button
                  className={`${commonButton} pl-1`}
                  onClick={() => restoreVideoRewriteSource(node)}
                >
                  <Undo2 className="h-4 w-4" />
                  <span>恢复原片</span>
                </button>
              ) : null}
              <div className="mx-1 h-6 w-px bg-[#3e3f43]" />
            </>
          ) : null}
          {canvasCapabilities.videoStoryAnalysis ? (
            <>
              <button
                data-video-story-analysis-button
                className={`${commonButton} pl-1 disabled:cursor-not-allowed disabled:opacity-45`}
                disabled={Boolean(node.videoStoryAnalyzing)}
                onClick={() => void submitVideoStoryAnalysis(node)}
              >
                {node.videoStoryAnalyzing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <NotebookTabs className="h-4 w-4" />}
                <span>{node.videoStoryAnalysis ? "重新拉片" : "逐帧拉片"}</span>
              </button>
              <div className="mx-1 h-6 w-px bg-[#3e3f43]" />
            </>
          ) : null}
          {canvasCapabilities.videoEnhance ? (
            <>
              <button className={`${commonButton} pl-1`} onClick={() => void openVideoEnhanceEditor(node)}>
                <span className="rounded border border-white/55 px-1 text-[11px] leading-4">HD</span>
                <span>高清</span>
              </button>
              <div className="mx-1 h-6 w-px bg-[#3e3f43]" />
            </>
          ) : null}
          <button className="inline-flex h-9 w-9 items-center justify-center text-white/95 hover:text-white" onClick={() => void downloadNodeMedia(node)}>
            <Download className="h-4 w-4" />
          </button>
          <button className="inline-flex h-9 w-9 items-center justify-center text-white/95 hover:text-white" onClick={() => openMediaViewer(node)}>
            <Expand className="h-4 w-4" />
          </button>
        </div>
      );
    }

    return null;
  }
  return renderNodeMediaToolbar;
}
