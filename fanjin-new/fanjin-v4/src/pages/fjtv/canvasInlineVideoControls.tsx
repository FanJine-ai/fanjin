import type React from "react";
import { Pause, Play, VolumeX, Volume2, Expand, Camera } from "lucide-react";
import type { NodeData } from "./canvasDataTypes";

interface InlineVideoControlsDependencies {
  patchLooksActivelyGenerating: (node: NodeData) => boolean;
  nodeHasSubmittingSession: (id: string) => boolean;
  videoNodeDurations: Record<string, number>;
  videoNodeCurrentTimes: Record<string, number>;
  videoNodePlaying: Record<string, boolean>;
  videoNodeMuted: Record<string, boolean>;
  videoFrameMenuNodeId: string | null;
  setNodePatch: (id: string, patch: Partial<NodeData>) => void;
  nodeVideoRefs: React.MutableRefObject<Record<string, HTMLVideoElement | null>>;
  setVideoNodeMuted: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setVideoFrameMenuNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  submitVideoFrameExtract: (node: NodeData, mode: "current" | "first" | "last") => unknown;
  setVideoNodeCurrentTimes: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  formatVideoClock: (time: number) => string;
}

export function renderInlineVideoControlsExternal(node: NodeData, deps: InlineVideoControlsDependencies) {
    const { patchLooksActivelyGenerating, nodeHasSubmittingSession, videoNodeDurations, videoNodeCurrentTimes, videoNodePlaying, videoNodeMuted, videoFrameMenuNodeId, setNodePatch, nodeVideoRefs, setVideoNodeMuted, setVideoFrameMenuNodeId, submitVideoFrameExtract, setVideoNodeCurrentTimes, formatVideoClock } = deps;
    if (patchLooksActivelyGenerating(node) || nodeHasSubmittingSession(node.id)) return null;
    const versions = (node.generationVersions || []).filter((item) => item.kind === "video" && item.url);
    const showVersions = versions.length > 1;
    const trimStart = typeof node.videoTrimStart === "number" ? node.videoTrimStart : 0;
    const rawDuration = videoNodeDurations[node.id] || Number(node.duration) || 5;
    const total = typeof node.videoTrimEnd === "number" ? Math.max(0.1, node.videoTrimEnd - trimStart) : Math.max(0.1, rawDuration);
    const currentAbsolute = videoNodeCurrentTimes[node.id] ?? trimStart;
    const current = typeof node.videoTrimEnd === "number"
      ? Math.max(0, Math.min(total, currentAbsolute - trimStart))
      : Math.max(0, Math.min(total, currentAbsolute));
    const progress = Math.max(0, Math.min(100, (current / total) * 100));
    const playing = Boolean(videoNodePlaying[node.id]);
    const muted = Boolean(videoNodeMuted[node.id]);
    const isMenuOpen = videoFrameMenuNodeId === node.id;

    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-2">
        {showVersions ? (
          <div className="pointer-events-auto mb-1 flex flex-wrap items-center gap-1">
            {versions.map((item) => {
              const active = (node.activeGenerationVersion ?? versions.at(-1)?.version) === item.version;
              return (
                <button
                  key={item.version}
                  type="button"
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold transition ${active ? "bg-white text-black" : "bg-black/55 text-white/85 hover:bg-black/75"}`}
                  title={`切换到 ${item.label || `v${item.version}`}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setNodePatch(node.id, {
                      videoUrl: item.url,
                      videoPosterUrl: item.posterUrl,
                      activeGenerationVersion: item.version,
                      videoDraftTaskId: item.draftTaskId, videoDraftExpiresAt: item.draftExpiresAt,
                      videoRenderMode: item.draftTaskId ? "draft" : node.videoRenderMode === "finalize" ? "finalize" : undefined,
                    });
                  }}
                >
                  {item.label || `v${item.version}`}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="rounded-[10px] bg-[linear-gradient(180deg,rgba(0,0,0,0.04)_0%,rgba(0,0,0,0.52)_100%)] px-2.5 pb-2 pt-6">
          <div className="pointer-events-auto mb-2 flex items-center gap-2 text-[11px] text-white">
            <button
              className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-white/15"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const video = nodeVideoRefs.current[node.id];
                if (!video) return;
                if (video.paused) {
                  if (typeof node.videoTrimStart === "number" && typeof node.videoTrimEnd === "number" && (video.currentTime < trimStart || video.currentTime > node.videoTrimEnd)) {
                    video.currentTime = trimStart;
                  }
                  void video.play().catch(() => undefined);
                } else {
                  video.pause();
                }
              }}
            >
              {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
            </button>
            <span>{formatVideoClock(current)}</span>
            <span>/</span>
            <span>{formatVideoClock(total)}</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                className="flex h-5 w-5 items-center justify-center"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const video = nodeVideoRefs.current[node.id];
                  if (!video) return;
                  video.muted = !video.muted;
                  setVideoNodeMuted((prev) => ({ ...prev, [node.id]: video.muted || video.volume <= 0 }));
                }}
              >
                {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </button>
              <button
                className="flex h-5 w-5 items-center justify-center"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void nodeVideoRefs.current[node.id]?.requestFullscreen?.().catch(() => undefined);
                }}
              >
                <Expand className="h-6 w-6" strokeWidth={2.1} />
              </button>
              <div
                className="relative"
                onMouseEnter={() => setVideoFrameMenuNodeId(node.id)}
                onMouseLeave={() => setVideoFrameMenuNodeId((prev) => (prev === node.id ? null : prev))}
              >
                <button
                  title="点击截取当前帧"
                  className="flex h-6 w-6 items-center justify-center rounded-[8px] bg-black/35 text-white transition hover:bg-black/55"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setVideoFrameMenuNodeId(null);
                    void submitVideoFrameExtract(node, "current");
                  }}
                >
                  <Camera className="h-3.5 w-3.5" />
                </button>
                {isMenuOpen ? (
                  <>
                    <div className="pointer-events-none absolute bottom-[-28px] right-0 whitespace-nowrap rounded-[8px] bg-black/70 px-2 py-1 text-[11px] text-white">
                      点击截取当前帧
                    </div>
                    <div className="absolute bottom-[34px] right-0 w-[108px] overflow-hidden rounded-[12px] border border-[#414247] bg-[#232325] py-1 shadow-[0_18px_36px_rgba(0,0,0,0.42)]">
                      <button
                        className="block h-10 w-full px-4 text-left text-[14px] text-white transition hover:bg-[#343437]"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void submitVideoFrameExtract(node, "first");
                          setVideoFrameMenuNodeId(null);
                        }}
                      >
                        截取首帧
                      </button>
                      <button
                        className="block h-10 w-full px-4 text-left text-[14px] text-white transition hover:bg-[#343437]"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void submitVideoFrameExtract(node, "last");
                          setVideoFrameMenuNodeId(null);
                        }}
                      >
                        截取尾帧
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </div>
          <div
            className="pointer-events-auto relative h-[3px] rounded-full bg-white/30"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
              const video = nodeVideoRefs.current[node.id];
              if (!video) return;
              video.currentTime = trimStart + ratio * total;
              setVideoNodeCurrentTimes((prev) => ({ ...prev, [node.id]: video.currentTime }));
            }}
          >
            <div className="absolute left-0 top-0 h-full rounded-full bg-white" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>
    );
  }
