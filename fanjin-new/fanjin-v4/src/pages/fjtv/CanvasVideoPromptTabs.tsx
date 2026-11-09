import type { Dispatch, SetStateAction } from "react";
import type { NodeData, EdgeData, GroupData } from "./canvasDataTypes";
import { VIDEO_PROMPT_TABS, isVideoPromptTabEnabled, getVideoPromptTabAvailability, getVideoTabForMode, getVideoModeForTab } from "./canvasModelDefinitions";
import { supportsCanvasVideoDraft } from "./canvasVideoDraft";
import { isCanvasSourceVideoMode } from "./canvasVideoExtension";
import { isCanvasCatalogVideoModeSupported, getCanvasCatalogVideoTotalInputLimit, getCanvasCatalogModeInputLimit } from "./canvasCatalogContract";
import ReferenceRequirementsHint from "../../features/quick-create/ReferenceRequirementsHint";

type VideoPromptTab = (typeof VIDEO_PROMPT_TABS)[number];
interface VideoPromptTabsInput {
  videoPromptTab: VideoPromptTab;
  activeNodeVideoReferenceSummary: Parameters<typeof isVideoPromptTabEnabled>[1];
  activeNode: NodeData | null;
  activeNodeModelOption: Parameters<typeof isVideoPromptTabEnabled>[3];
  setNodePatch: (id: string, patch: Partial<NodeData>) => void;
  hoveredVideoPromptTab: VideoPromptTab | null;
  setHoveredVideoPromptTab: Dispatch<SetStateAction<VideoPromptTab | null>>;
  setStatus: (message: string) => void;
  showNodeStatusChip: (id: string, message: string, tone: "neutral", duration: number) => void;
  setVideoPromptTab: (tab: VideoPromptTab) => void;
  nodes: NodeData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  persistCanvas: (nodes: NodeData[], edges: EdgeData[], name: string, groups: GroupData[]) => unknown;
  edges: EdgeData[];
  canvasMeta: { name: string };
  groups: GroupData[];
}

export function renderCanvasVideoPromptTabs(input: VideoPromptTabsInput) {
    const { videoPromptTab, activeNodeVideoReferenceSummary, activeNode, activeNodeModelOption, setNodePatch, hoveredVideoPromptTab, setHoveredVideoPromptTab, setStatus, showNodeStatusChip, setVideoPromptTab, nodes, setNodes, persistCanvas, edges, canvasMeta, groups } = input;
    const activeDisabled = !isVideoPromptTabEnabled(
      videoPromptTab,
      activeNodeVideoReferenceSummary,
      activeNode?.model,
      activeNodeModelOption,
    );
    return (
      <div data-node-video-tabs className="mb-4 flex flex-wrap items-center gap-2">
        {supportsCanvasVideoDraft(activeNodeModelOption) && activeNode ? <button type="button" aria-pressed={activeNode.videoRenderMode === "draft"} data-video-draft-toggle
          className="rounded-lg border border-current/20 px-3 py-2 text-[13px] text-[#3995b3] focus-visible:outline focus-visible:outline-2"
          onClick={() => setNodePatch(activeNode.id, { videoRenderMode: activeNode.videoRenderMode === "draft" ? undefined : "draft", resolution: activeNode.videoRenderMode === "draft" ? "720P" : "480P", videoDraftTaskId: undefined, videoDraftExpiresAt: undefined })}>
          {activeNode.videoRenderMode === "draft" ? "样片 · 480p" : "先出样片"}</button> : null}
        {VIDEO_PROMPT_TABS
          .filter((tab) => isCanvasSourceVideoMode(activeNode?.videoMode) ? tab === getVideoTabForMode(activeNode?.videoMode) : tab !== "延长视频" && tab !== "修改视频" && isCanvasCatalogVideoModeSupported(activeNodeModelOption, getVideoModeForTab(tab)))
          .map((tab) => {
          const availability = getVideoPromptTabAvailability(
            tab,
            activeNodeVideoReferenceSummary,
            activeNode?.model,
            activeNodeModelOption,
          );
          const enabled = availability.enabled;
          const isActive = videoPromptTab === tab;
          const showHint = hoveredVideoPromptTab === tab && availability.hintLines.length > 0;
          const hintId = `node-video-tab-hint-${getVideoModeForTab(tab)}`;
          return (
            <div key={tab} className="relative">
              <button
                data-node-video-tab
                data-node-id={activeNode?.id}
                data-video-mode={getVideoModeForTab(tab)}
                data-selected={isActive ? "true" : "false"}
                data-enabled={enabled ? "true" : "false"}
                aria-pressed={isActive}
                aria-disabled={!enabled}
                aria-describedby={showHint ? hintId : undefined}
                className={`shrink-0 whitespace-nowrap rounded-[10px] border px-3 py-1 text-[13px] transition ${
                  isActive && enabled
                    ? "border-[#6d6e73] bg-[#3a3a3c] text-white"
                    : isActive && activeDisabled
                      ? "border-[#55565a] bg-transparent text-[#6f737b]"
                      : enabled
                        ? "border-[#55565a] text-[#8f9299] hover:border-[#67686c] hover:text-[#d8dade]"
                        : "cursor-not-allowed border-[#4d4f54] text-[#6f737b]"
                }`}
                onMouseEnter={() => setHoveredVideoPromptTab(tab)}
                onMouseLeave={() => setHoveredVideoPromptTab((prev) => (prev === tab ? null : prev))}
                onFocus={() => setHoveredVideoPromptTab(tab)}
                onBlur={() => setHoveredVideoPromptTab((prev) => (prev === tab ? null : prev))}
                onClick={() => {
                  if (!enabled) {
                    const message = availability.hintLines[0] || `${tab}当前不可用`;
                    setStatus(message);
                    if (activeNode) showNodeStatusChip(activeNode.id, message, "neutral", 2600);
                    return;
                  }
                  setVideoPromptTab(tab);
                  if (activeNode?.type === "video") {
                    const nextVideoMode = getVideoModeForTab(tab);
                    const nextNodes = nodes.map((node) => (node.id === activeNode.id ? { ...node, videoMode: nextVideoMode } : node));
                    setNodes(nextNodes);
                    void persistCanvas(nextNodes, edges, canvasMeta.name, groups);
                    setStatus(`已切换为${tab}`);
                  }
                }}
              >
                <span>{tab}</span>
                {!enabled && tab !== "文生视频" ? <span data-node-video-tab-requirement>需素材</span> : null}
              </button>
              {showHint ? (
                <div
                  id={hintId}
                  role="tooltip"
                  data-node-video-tab-tooltip
                  className="pointer-events-none absolute bottom-[calc(100%+10px)] left-1/2 z-[110] w-max max-w-[min(280px,calc(100vw-32px))] -translate-x-1/2 rounded-[10px] border border-white/10 bg-[#111827] px-3 py-2 text-[12px] leading-5 text-[#f8fafc] shadow-[0_10px_24px_rgba(0,0,0,0.32)]"
                >
                  {availability.hintLines.map((line, index) => (
                    <div key={`${tab}-hint-${index}`}>{line}</div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {activeNode?.videoMode === "video_edit" ? <p className="w-full text-[12px] leading-5 text-[#8f939a]">连接 1 段 4–30 秒原片和替换参考图，写明修改与保留要求。画幅和时长跟随原片，结果另存为新视频。</p> : null}
        {activeNode?.videoMode === "video_extension" ? <p className="w-full text-[12px] leading-5 text-[#8f939a]">连接 1 段原片，填写接续剧情。画幅跟随原片，生成结果保存为新视频。</p> : null}
        {activeNodeModelOption ? <ReferenceRequirementsHint modelId={activeNodeModelOption.id} mode={getVideoModeForTab(videoPromptTab)} totalLimit={getCanvasCatalogVideoTotalInputLimit(activeNodeModelOption)} limits={{
          image: getCanvasCatalogModeInputLimit(activeNodeModelOption, getVideoModeForTab(videoPromptTab), "image")?.max ?? 0,
          video: videoPromptTab === "延长视频" || videoPromptTab === "修改视频" ? 1 : getCanvasCatalogModeInputLimit(activeNodeModelOption, getVideoModeForTab(videoPromptTab), "video")?.max ?? 0,
          file: getCanvasCatalogModeInputLimit(activeNodeModelOption, getVideoModeForTab(videoPromptTab), "file")?.max ?? 0,
        }} /> : null}
      </div>
    );
  }
