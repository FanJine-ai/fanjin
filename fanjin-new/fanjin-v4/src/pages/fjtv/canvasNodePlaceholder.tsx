import { CanvasRedrawPlaceholder } from "./CanvasRedrawProvider";
import type * as React from "react";
import { patchLooksActivelyGenerating } from "./canvasTaskState";
import type { NodeData, EdgeData } from "./canvasDataTypes";
import { ReferencePreviewAudio } from "@/features/quick-create/attachments/AuthenticatedReferenceMedia";
import { canvasTextContent } from "./canvasInteraction";
import { CanvasArtifactTabs, CanvasArtifactCards } from "./CanvasTextArtifactPanel";
import { type CanvasArtifactKind, type CanvasArtifactCard } from "./canvasTextArtifacts";
import { isCanvasSourceVideoMode } from "./canvasVideoExtension";
import { FileAudio, Pause, Play, Plus, ReceiptText, Scissors, Upload, Video } from "lucide-react";
import { AUDIO_WAVEFORM_BARS, formatVideoClock, getAudioWaveformFillCount, getNodeTextContent } from "./canvasAssetPresentation";
import { canvasGenerationProgressLabel } from "./canvasGenerationProgress";

export interface CanvasNodePlaceholderDependencies {
  edges: EdgeData[];
  setSelectedNodeIds: React.Dispatch<React.SetStateAction<string[]>>;
  setActiveGroupId: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  imageToImageUploadPresetRef: React.RefObject<string | null>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  setStoryboardSlotMenuPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number; } | null>>;
  setStoryboardSlotMenuNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  renderCanvasNodeGlyph: (type: NodeData["type"], variant?: "node" | "header") => React.JSX.Element;
  textNodeBackground: (node: NodeData) => string;
  textNodeFontSize: (node: NodeData) => number;
  textNodeLineHeight: (node: NodeData) => 1.38 | 1.28 | 1.35 | 1.5;
  editingTextNodeId: string | null;
  textEditorDraft: string;
  commitTextNodeEditing: () => void;
  textEditorTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setTextEditorDraft: React.Dispatch<React.SetStateAction<string>>;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  getCanvasArtifactImages: () => { nodeId: string; title: string; assetVersionId: number; imageUrl: string; referenceAssetUri: string | undefined; }[];
  editCanvasArtifact: (nodeId: string, kind: CanvasArtifactKind, cardId: string, patch: Partial<CanvasArtifactCard>) => void;
  deleteCanvasArtifact: (nodeId: string, kind: CanvasArtifactKind, cardId: string) => void;
  createImageFromCanvasArtifact: (sourceNodeId: string, cardId: string) => void;
  TEXT_TRY_ACTIONS: ({ key: string; label: string; icon: "text"; } | { key: string; label: string; icon: "video"; })[];
  startTextNodeEditing: (node: NodeData) => void;
  createTextVideoPresetGroup: (sourceNodeId: string) => void;
  cancelGenerationConfirmNodeId: string | null;
  requestCancelNodeGeneration: (nodeId: string) => void;
  audioNodeCurrentTimes: Record<string, number>;
  audioNodeDurations: Record<string, number>;
  audioNodePlaying: Record<string, boolean>;
  nodeAudioRefs: React.RefObject<Record<string, HTMLAudioElement | null>>;
  setAudioNodeDurations: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setAudioNodeCurrentTimes: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setAudioNodePlaying: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  toggleAudioNodePlayback: (nodeId: string) => void;
  isEphemeralLocalUrl: (value: string | undefined | null) => boolean;
  nodeMap: Map<string, NodeData>;
  openComposeEditor: (nodeId: string) => Promise<void>;
  nodeHasSubmittingSession: (nodeId: string) => boolean;
  submitDraftFinalNode: (node: NodeData) => Promise<boolean>;
  canvasColorMode: import("@/ui/theme").ThemeMode;
  VIDEO_TRY_ACTIONS: ({ key: string; label: string; icon: "boxes"; } | { key: string; label: string; icon: "spark"; })[];
  createVideoFramePresetGroup: (sourceNodeId: string, mode: "first" | "firstLast") => void;
  renderNodeTryIcon: (kind: "text" | "video" | "image" | "audio" | "boxes" | "spark") => React.JSX.Element;
}

export function createCanvasNodePlaceholder({
  edges,
  setSelectedNodeIds,
  setActiveGroupId,
  setActiveNodeId,
  imageToImageUploadPresetRef,
  setStatus,
  fileInputRef,
  setStoryboardSlotMenuPosition,
  setStoryboardSlotMenuNodeId,
  renderCanvasNodeGlyph,
  textNodeBackground,
  textNodeFontSize,
  textNodeLineHeight,
  editingTextNodeId,
  textEditorDraft,
  commitTextNodeEditing,
  textEditorTextareaRef,
  setTextEditorDraft,
  setNodePatch,
  getCanvasArtifactImages,
  editCanvasArtifact,
  deleteCanvasArtifact,
  createImageFromCanvasArtifact,
  TEXT_TRY_ACTIONS,
  startTextNodeEditing,
  createTextVideoPresetGroup,
  cancelGenerationConfirmNodeId,
  requestCancelNodeGeneration,
  audioNodeCurrentTimes,
  audioNodeDurations,
  audioNodePlaying,
  nodeAudioRefs,
  setAudioNodeDurations,
  setAudioNodeCurrentTimes,
  setAudioNodePlaying,
  toggleAudioNodePlayback,
  isEphemeralLocalUrl,
  nodeMap,
  openComposeEditor,
  nodeHasSubmittingSession,
  submitDraftFinalNode,
  canvasColorMode,
  VIDEO_TRY_ACTIONS,
  createVideoFramePresetGroup,
  renderNodeTryIcon,
}: CanvasNodePlaceholderDependencies) {
  function renderNodePlaceholder(node: NodeData) {
    if (node.videoWorkflow === "redraw" || node.videoRedrawSourceNodeId) return <CanvasRedrawPlaceholder node={node}/>;
    const isLinkedNode = edges.some((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id);
    if (node.type === "image") {
      const isReferenceInputNode = edges.some((edge) => edge.fromNodeId === node.id);
      const isCharacterReferenceInput = node.title === "角色参考图";
      const requiresDirectUpload = isReferenceInputNode || isCharacterReferenceInput;
      const requestImageUpload = (createImageToImage: boolean, statusText: string) => {
        setSelectedNodeIds([node.id]);
        setActiveGroupId(null);
        setActiveNodeId(node.id);
        imageToImageUploadPresetRef.current = createImageToImage ? node.id : null;
        setStatus(statusText);
        window.setTimeout(() => fileInputRef.current?.click(), 0);
      };
      if (node.storyboardSlotPlaceholder) {
        return (
          <button
            type="button"
            className="flex h-full w-full items-center justify-center rounded-[10px] border border-[#37383c] bg-[#262628] text-[#c7ced8] transition hover:bg-[#2d2d30]"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSelectedNodeIds([node.id]);
              setActiveNodeId(node.id);
              setStoryboardSlotMenuPosition({
                x: node.x + Math.max(24, node.width * 0.48),
                y: node.y + 24,
              });
              setStoryboardSlotMenuNodeId((prev) => (prev === node.id ? null : node.id));
            }}
          >
            <Plus className="h-6 w-6" />
          </button>
        );
      }
      const hasImageMedia = Boolean(node.imageUrl || node.localPreviewUrl || node.primaryImageUrl);
      if (!hasImageMedia && (!isLinkedNode || isReferenceInputNode)) {
        return (
          <div className="relative flex h-full w-full items-center justify-center rounded-[16px] bg-[#292929] text-[#555557]">
            {renderCanvasNodeGlyph("image")}
            <div className="absolute bottom-[15%] left-[8%] text-left">
              <div className="mb-3 text-[15px] text-[#8f9198]">{requiresDirectUpload ? "需要真实素材:" : "尝试:"}</div>
              <div className="space-y-3">
                <button
                  type="button"
                  className="flex items-center gap-3 text-[16px] font-semibold text-white transition hover:text-[#dfe6f2]"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    requestImageUpload(!requiresDirectUpload, isCharacterReferenceInput ? "请选择真实角色参考图" : requiresDirectUpload ? "请选择真实图片素材" : "请选择图生图参考素材");
                  }}
                >
                  <Upload className="h-4 w-4" />
                  <span>{isCharacterReferenceInput ? "上传角色参考图" : requiresDirectUpload ? "上传图片" : "图生图"}</span>
                </button>
              </div>
            </div>
          </div>
        );
      }
      return (
        <div className="flex h-full w-full items-center justify-center rounded-[16px] bg-[#292929] text-[#555557]">
          {renderCanvasNodeGlyph("image")}
        </div>
      );
    }

    if (node.type === "text") {
      const textBackground = textNodeBackground(node);
      const textTypographyStyle = {
        fontSize: textNodeFontSize(node),
        lineHeight: textNodeLineHeight(node),
        fontWeight: node.textBold ? 700 : 500,
        fontStyle: node.textItalic ? "italic" : "normal",
      } as const;
      if (editingTextNodeId === node.id && (!node.textArtifactTab || node.textArtifactTab === "body")) {
        return (
          <div className="relative flex h-full w-full flex-col rounded-[16px] px-0 py-0 text-white" style={{ backgroundColor: textBackground }}>
            {!textEditorDraft.trim() ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-hidden p-3 text-center">
                <div className="text-[18px] font-medium text-[#9fa1a6]">请编写内容，开始你的创作。</div>
                <div className="text-[#5b5b5d]">{renderCanvasNodeGlyph("text")}</div>
              </div>
            ) : null}
            <button
              type="button"
              aria-label="完成文本编辑"
              className="absolute right-3 top-3 z-20 rounded-lg border border-white/12 bg-black/45 px-3 py-1.5 text-[13px] font-semibold text-white shadow-lg backdrop-blur-sm transition hover:bg-black/65"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                commitTextNodeEditing();
              }}
            >
              完成
            </button>
            <textarea
              ref={textEditorTextareaRef}
              aria-label="编辑文本内容"
              className="h-full w-full resize-none rounded-[16px] bg-transparent px-7 py-6 text-[#f3f5f8] outline-none placeholder:text-[#5a5d64]"
              style={textTypographyStyle}
              placeholder=""
              value={textEditorDraft}
              onChange={(event) => setTextEditorDraft(event.target.value)}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  commitTextNodeEditing();
                }
              }}
            />
          </div>
        );
      }

      if (node.textArtifactTab && node.textArtifactTab !== "body") {
        const kind = node.textArtifactTab;
        return <div className="flex h-full min-h-0 w-full flex-col rounded-[16px] px-4 py-4 text-white" style={{ backgroundColor: textBackground }}>
          <CanvasArtifactTabs artifacts={node.textArtifacts} tab={kind} onTab={(textArtifactTab) => setNodePatch(node.id, { textArtifactTab })} />
          <CanvasArtifactCards kind={kind} artifacts={node.textArtifacts} currentText={getNodeTextContent(node)} disabled={patchLooksActivelyGenerating(node)} images={getCanvasArtifactImages()}
            onEdit={(cardId, patch) => editCanvasArtifact(node.id, kind, cardId, patch)}
            onDelete={(cardId) => deleteCanvasArtifact(node.id, kind, cardId)}
            onCreateImage={(cardId) => createImageFromCanvasArtifact(node.id, cardId)} />
        </div>;
      }
      const hasTextContent = Boolean(canvasTextContent(node).trim());
      const showTextTryActions = !isLinkedNode && !hasTextContent && !node.textVisited;
      if (showTextTryActions) {
        const displayTextTryActions = node.height >= 220;
        const compactTextTryActions = node.height < 300;
        const renderTryIcon = (icon: (typeof TEXT_TRY_ACTIONS)[number]["icon"]) => {
          if (icon === "video") return <Play className="h-4 w-4 fill-current" />;
          return <ReceiptText className="h-4 w-4 fill-current" />;
        };
        const handleTryAction = (key: string) => {
          if (key === "write") {
            setSelectedNodeIds([node.id]);
            setActiveGroupId(null);
            setActiveNodeId(node.id);
            startTextNodeEditing(node);
            return;
          }
          if (key === "video") createTextVideoPresetGroup(node.id);
        };
        return (
          <div
            data-empty-text-node
            data-empty-text-node-layout={displayTextTryActions ? (compactTextTryActions ? "compact" : "full") : "minimal"}
            className={`relative flex h-full w-full min-h-0 flex-col overflow-hidden rounded-[16px] bg-[#292929] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] ${compactTextTryActions ? "px-5 py-4" : "px-7 py-7"}`}
          >
            <div className={`flex min-h-0 flex-1 items-center justify-center text-[#5e5e60] ${displayTextTryActions ? "pt-1" : "p-2"}`}>
              {renderCanvasNodeGlyph("text")}
            </div>
            {displayTextTryActions ? <div className={`${compactTextTryActions ? "pb-1" : "pb-5"} shrink-0 text-left`}>
              <div className="mb-4 text-[15px] font-medium text-[#9a9ca3]">尝试:</div>
              <div className={compactTextTryActions ? "space-y-2" : "space-y-5"}>
                {TEXT_TRY_ACTIONS.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className={`flex max-w-full items-center text-left font-semibold text-white transition hover:text-[#dfe6f2] ${compactTextTryActions ? "gap-2 text-[14px]" : "gap-3 text-[16px]"}`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleTryAction(action.key);
                    }}
                  >
                    {renderTryIcon(action.icon)}
                    <span className="min-w-0 truncate">{action.label}</span>
                  </button>
                ))}
              </div>
            </div> : null}
          </div>
        );
      }

      return (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-[16px] px-5 py-5 text-white" style={{ backgroundColor: textBackground }}>
          <CanvasArtifactTabs artifacts={node.textArtifacts} tab="body" onTab={(textArtifactTab) => setNodePatch(node.id, { textArtifactTab })} />
          {hasTextContent ? (
            <div className="mh-prompt-scrollbar min-h-0 min-w-0 flex-1 overflow-auto p-1 text-[#f8fafc] whitespace-pre-wrap break-words" style={textTypographyStyle}>
              <div>{canvasTextContent(node)}</div>
              {node.textDivider ? <div className="mt-6 h-px w-full bg-white/18" /> : null}
            </div>
          ) : node.textVisited ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 overflow-hidden p-3 text-center">
              <div className="text-[18px] font-medium text-[#9fa1a6]">请编写内容，开始你的创作。</div>
              <div className="text-[#5b5b5d]">{renderCanvasNodeGlyph("text")}</div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[#555557]">
              {renderCanvasNodeGlyph("text")}
            </div>
          )}
        </div>
      );
    }

    if (node.type === "audio") {
      const hasAudio = Boolean(node.localAudioUrl || node.audioUrl);
      const isAudioGenerating = Boolean(node.isGenerating);
      if (isAudioGenerating) {
        const generationLabel = canvasGenerationProgressLabel(node);
        return (
          <div className="flex h-full w-full flex-col rounded-[16px] bg-[#2a2a2a] px-4 py-4 text-white">
            <div className="flex flex-1 flex-col justify-center">
              <div className="rounded-[14px] border border-[#3d4046] bg-[linear-gradient(180deg,#38393d_0%,#303135_100%)] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <div className="flex min-h-[60px] items-center justify-center rounded-[10px] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.02)_45%,rgba(0,0,0,0)_75%)]">
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={cancelGenerationConfirmNodeId === node.id}
                    aria-controls="canvas-cancel-generation-dialog"
                    className="pointer-events-auto inline-flex items-center gap-2 rounded-[8px] border border-[#5a5c61] bg-[#2f3033] px-3 py-1.5 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(0,0,0,0.18)]"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      requestCancelNodeGeneration(node.id);
                    }}
                  >
                    <span>{generationLabel}</span>
                    <span className="text-[#9fa4ad]">取消</span>
                  </button>
                </div>
              </div>
              <div className="mt-4 flex justify-center">
                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#4d5056] bg-[#303135] text-[#71757d]">
                  <Play className="ml-[1px] h-4 w-4 fill-current" />
                </div>
              </div>
            </div>
          </div>
        );
      }
      if (!hasAudio) {
        const hasIncomingContent = edges.some((edge) => edge.toNodeId === node.id);
        if (hasIncomingContent) {
          return <div className="h-full w-full rounded-[16px] bg-[#2a2a2a]" />;
        }
        return (
          <div className="flex h-full w-full flex-col rounded-[16px] bg-[#2a2a2a] px-6 py-6 text-white">
            <div className="flex flex-1 flex-col items-center justify-center text-center">
              <FileAudio className="h-10 w-10 text-[#64676d]" />
              <div className="mt-4 text-[15px] font-semibold text-[#f2f4f8]">请先上传真实音频</div>
              <div className="mt-2 text-[12px] leading-5 text-[#9ca1aa]">可从资产库拖入，或使用节点上传入口。</div>
            </div>
          </div>
        );
      }

      const audioSrc = node.audioUrl || node.localAudioUrl || "";
      const current = audioNodeCurrentTimes[node.id] || 0;
      const total = Math.max(0.1, audioNodeDurations[node.id] || 1);
      const playing = Boolean(audioNodePlaying[node.id]);
      const filledBars = getAudioWaveformFillCount(current, total);
      return (
        <div className="flex h-full w-full flex-col rounded-[16px] bg-[#2a2a2a] px-4 py-4 text-white">
          <div className="rounded-[14px] border border-[#3c4047] bg-[linear-gradient(180deg,#38393d_0%,#303135_100%)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <ReferencePreviewAudio
              ref={(element) => {
                nodeAudioRefs.current[node.id] = element;
              }}
              src={audioSrc}
              preload="metadata"
              onLoadedMetadata={(event) => {
                const audioElement = nodeAudioRefs.current[node.id] || event.currentTarget || null;
                const duration = audioElement && Number.isFinite(audioElement.duration) ? audioElement.duration : 1;
                setAudioNodeDurations((prev) => ({ ...prev, [node.id]: duration }));
              }}
              onTimeUpdate={(event) => {
                const audioElement = nodeAudioRefs.current[node.id] || event.currentTarget || null;
                const currentTime = audioElement && Number.isFinite(audioElement.currentTime) ? audioElement.currentTime : 0;
                setAudioNodeCurrentTimes((prev) => ({ ...prev, [node.id]: currentTime }));
              }}
              onPlay={() => setAudioNodePlaying((prev) => ({ ...prev, [node.id]: true }))}
              onPause={() => setAudioNodePlaying((prev) => ({ ...prev, [node.id]: false }))}
              onEnded={(event) => {
                const audioElement = nodeAudioRefs.current[node.id] || event.currentTarget || null;
                setAudioNodePlaying((prev) => ({ ...prev, [node.id]: false }));
                setAudioNodeCurrentTimes((prev) => ({ ...prev, [node.id]: 0 }));
                if (audioElement) {
                  audioElement.currentTime = 0;
                }
              }}
              className="hidden"
            />
            <div className="rounded-[10px] bg-[#404144] px-3 py-3">
              <div className="flex h-[54px] items-center gap-[4px] overflow-hidden rounded-[8px] bg-[#38393c] px-3">
                <div className="h-full w-[3px] rounded-full bg-[#e35f5c]" />
                <div className="flex flex-1 items-center gap-[4px]">
                  {AUDIO_WAVEFORM_BARS.map((bar, index) => (
                    <div
                      key={index}
                      className={`w-[3px] rounded-full transition-colors ${index < filledBars ? "bg-[#6f7278]" : "bg-[#575a61]"}`}
                      style={{ height: `${bar}px`, opacity: index < filledBars ? 0.95 : 0.55 }}
                    />
                  ))}
                  <div className="ml-1 h-px flex-1 border-t border-dashed border-[#666970]" />
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between text-[10px] text-[#d2d6dd]">
              <span>{`${formatVideoClock(current)} / ${formatVideoClock(total)}`}</span>
              <div className="flex items-center gap-2">
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-[#2f3338] text-white transition hover:bg-[#393d43]"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => toggleAudioNodePlayback(node.id)}
                >
                  {playing ? <Pause className="h-3 w-3 fill-current" /> : <Play className="ml-[1px] h-3 w-3 fill-current" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (node.type === "video" && isEphemeralLocalUrl(node.localVideoUrl) && !node.videoUrl) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center rounded-[16px] bg-[#2a2a2a] px-6 py-6 text-center text-white">
          <Video className="h-[54px] w-[54px] text-[#62656d]" strokeWidth={1.6} />
          <div className="mt-5 text-[15px] font-semibold text-[#f2f4f8]">本地视频已失效</div>
          <div className="mt-2 max-w-[240px] text-[12px] leading-5 text-[#9ca1aa]">这个节点保存的是浏览器临时地址，刷新后无法恢复，请重新上传视频。</div>
        </div>
      );
    }

    if (node.type === "compose") {
      const upstreamVideos = edges
        .filter((edge) => edge.toNodeId === node.id)
        .map((edge) => nodeMap.get(edge.fromNodeId))
        .filter((item): item is NodeData => Boolean(item && item.type === "video"));
      return (
        <div className="flex h-full w-full flex-col items-center justify-center rounded-[16px] bg-[#2a2a2a] px-6 py-6 text-white">
          <Scissors className="h-[68px] w-[68px] text-[#5c5d61]" strokeWidth={1.6} />
          {upstreamVideos.length === 0 ? (
            <div className="mt-6 text-center text-[18px] text-[#8f9198]">空空如也，请连接视频节点后操作</div>
          ) : (
            <>
              <div className="mt-6 text-center text-[15px] text-[#8f9198]">已连接 {upstreamVideos.length} 个视频节点</div>
              <button
                className="mt-5 rounded-[8px] border border-[#4a4d53] bg-[#313236] px-4 py-2 text-[12px] text-[#d8dbe0] transition hover:border-[#63666d] hover:bg-[#3a3b40]"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => void openComposeEditor(node.id)}
              >
                打开视频合成
              </button>
            </>
          )}
        </div>
      );
    }

    if (node.videoEnhanceMode) {
      return (
        <div className="flex h-full w-full items-center justify-center rounded-[16px] bg-[#292929] text-[#555557]">
          {renderCanvasNodeGlyph("video")}
        </div>
      );
    }

    if (node.videoSubtitleEraseMode) {
      return (
        <div className="flex h-full w-full flex-col rounded-[16px] bg-[#2a2a2a] px-6 py-6 text-white">
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 text-[16px] font-semibold text-[#f3f5f8]">
              {node.videoSubtitleEraseType === "region" ? "框选区域擦除" : "配置参数生成去字幕视频"}
            </div>
            <div className="text-[13px] text-[#8f9198]">
              {node.videoSubtitleEraseType === "region" ? "将按选中区域擦除文字或字幕" : "将自动识别并擦除字幕内容"}
            </div>
          </div>
        </div>
      );
    }

    if (node.type === "video" && (patchLooksActivelyGenerating(node) || nodeHasSubmittingSession(node.id))) {
      return <div className="h-full w-full rounded-[16px] bg-[#292929]" />;
    }

    if (node.videoRenderMode === "finalize" && !node.videoUrl && !node.localVideoUrl) {
      return <div data-video-draft-final-node className="flex h-full flex-col justify-center gap-4 rounded-2xl bg-slate-100 p-6 text-slate-700">
        <span className="text-lg font-semibold">1080p 正式片</span><p className="text-sm leading-6">沿用样片的构图、动作、素材与声音。独立报价，结果保存在此节点。</p>
        <button type="button" className="rounded-xl bg-[#117794] px-4 py-3 text-sm font-medium text-white" onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void submitDraftFinalNode(node); }}>查看报价并生成</button>
      </div>;
    }
    if (node.type === "video" && !node.videoUrl && !node.localVideoUrl && node.suppressEmptyTryActions) {
      return (
        <div className="flex h-full w-full items-center justify-center rounded-[16px] bg-[#292929] text-[#555557]">
          {renderCanvasNodeGlyph("video")}
        </div>
      );
    }

    if (node.type === "video" && !node.videoUrl && !node.localVideoUrl) {
      return (
        <div
          className="relative flex h-full w-full flex-col rounded-[16px] px-8 py-8 text-white"
          style={{
            background: canvasColorMode === "light"
              ? "linear-gradient(165deg,#f3f6fa 0%,#d9e0ea 100%)"
              : "linear-gradient(165deg,#2b2d31 0%,#1c1d20 100%)",
          }}
        >
          <div className="flex flex-1 items-center justify-center text-[#8b93a1]">
            {renderCanvasNodeGlyph("video")}
          </div>
          {isCanvasSourceVideoMode(node.videoMode) ? <p className="pb-10 text-[15px] text-[#6b7280]">{node.videoMode === "video_edit" ? "连接原片和替换参考图，填写修改要求" : "连接原片，填写接续剧情"}</p> : <div className="pb-10 text-left">
            <div className="mb-4 text-[15px] text-[#6b7280]">尝试:</div>
            <div className="space-y-3">
              {VIDEO_TRY_ACTIONS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="flex items-center gap-3 text-[15px] font-semibold text-[#3b4552] transition hover:text-[#0f6f92]"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    createVideoFramePresetGroup(node.id, item.key === "firstLastFrame" ? "firstLast" : "first");
                  }}
                >
                  <span className="text-[#5c6b7a]">{renderNodeTryIcon(item.icon)}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>}
        </div>
      );
    }

    return (
      <div className="flex h-full w-full items-center justify-center rounded-[16px] bg-[#292929] text-[#555557]">
        {renderCanvasNodeGlyph("video")}
      </div>
    );
  }
  return renderNodePlaceholder;
}
