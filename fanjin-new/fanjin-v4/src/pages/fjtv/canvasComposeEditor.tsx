import type React from "react";
import { ChevronDown, Download, Plus, X, Clock3, Pause, Play, Expand, ZoomOut, ZoomIn, VolumeX, Volume2 } from "lucide-react";
import { ReferencePreviewVideo } from "@/features/quick-create/attachments/AuthenticatedReferenceMedia";
import { composeSegmentLength, formatComposeTime, type ComposeClip } from "./canvasComposeTimeline";
import { getCanvasImagePreviewUrl } from "./canvasAssetPresentation";

export interface ComposeEditorDependencies {
  composeEditorNodeId: string | null;
  composeTotalDuration: number;
  composeScale: number;
  composeCurrentTime: number;
  composeExporting: boolean;
  composeClips: ComposeClip[];
  composeExportOpen: boolean;
  composeExportError: string | null;
  composePreviewFullscreen: boolean;
  composeLoading: boolean;
  composeMuted: boolean;
  composeCanCrop: boolean;
  composePlaying: boolean;
  composeInspectorOpen: boolean;
  composeSelectedClip: ComposeClip | null | undefined;
  composePreviewRef: React.RefObject<HTMLVideoElement | null>;
  composeTimelineRef: React.RefObject<HTMLDivElement | null>;
  setComposeExportOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setComposePlaying: React.Dispatch<React.SetStateAction<boolean>>;
  setComposeInspectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setComposeTimelineDragging: React.Dispatch<React.SetStateAction<boolean>>;
  setComposeScale: React.Dispatch<React.SetStateAction<number>>;
  exportComposeToLocal: () => Promise<void>;
  exportComposeToCanvas: () => Promise<void>;
  closeComposeEditor: () => void;
  jumpComposeToPreviousClip: () => void;
  jumpComposeToNextClip: () => void;
  splitComposeClip: () => void;
  trimComposeClipLeft: () => void;
  trimComposeClipRight: () => void;
  toggleComposeMuted: () => void;
  seekComposeTime: (value: number) => void;
  setComposeClipSpeed: (value: number) => void;
  setComposeClipDuration: (value: number) => void;
  selectComposeClip: (id: string) => void;
}

export function renderComposeEditorExternal(deps: ComposeEditorDependencies) {
  const {
    composeEditorNodeId,
    composeTotalDuration,
    composeScale,
    composeCurrentTime,
    composeExporting,
    composeClips,
    composeExportOpen,
    composeExportError,
    composePreviewFullscreen,
    composeLoading,
    composeMuted,
    composeCanCrop,
    composePlaying,
    composeInspectorOpen,
    composeSelectedClip,
    composePreviewRef,
    composeTimelineRef,
    setComposeExportOpen,
    setComposePlaying,
    setComposeInspectorOpen,
    setComposeTimelineDragging,
    setComposeScale,
    exportComposeToLocal,
    exportComposeToCanvas,
    closeComposeEditor,
    jumpComposeToPreviousClip,
    jumpComposeToNextClip,
    splitComposeClip,
    trimComposeClipLeft,
    trimComposeClipRight,
    toggleComposeMuted,
    seekComposeTime,
    setComposeClipSpeed,
    setComposeClipDuration,
    selectComposeClip,
  } = deps;
    if (!composeEditorNodeId) return null;
    const trackWidth = Math.max(1180, composeTotalDuration * 158 * composeScale);
    const playheadPercent = (Math.min(composeCurrentTime, composeTotalDuration) / Math.max(0.01, composeTotalDuration)) * 100;
    const speedOptions = [0.5, 0.62, 0.8, 1, 1.25, 1.5, 2];
    return (
      <div data-fixed-ui className="absolute inset-0 z-[120] bg-[#141414] text-white">
        <div className="flex h-[74px] items-center justify-between px-4">
          <div className="text-[25px] font-semibold">视频合成</div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <button
                className="inline-flex h-[50px] items-center gap-2 rounded-[12px] bg-white px-5 text-[18px] font-medium text-black disabled:cursor-wait disabled:opacity-70"
                disabled={composeExporting || composeClips.length === 0}
                onClick={() => setComposeExportOpen((prev) => !prev)}
              >
                {composeExporting ? "正在真实合成..." : "导出"}
                <ChevronDown className="h-4 w-4" />
              </button>
              {composeExportOpen ? (
                <div className="absolute right-0 top-14 w-[200px] rounded-[18px] bg-[#232323] p-3 text-[15px] text-white shadow-[0_18px_42px_rgba(0,0,0,0.38)]">
                  <div className="mb-2 px-2 text-[#8d8f95]">导出位置</div>
                  <button className="flex w-full items-center gap-2 rounded-[12px] px-3 py-3 text-left hover:bg-[#2f2f31] disabled:cursor-wait disabled:opacity-55" disabled={composeExporting} onClick={() => void exportComposeToLocal()}>
                    <Download className="h-4 w-4" />
                    导出到本地
                  </button>
                  <button className="mt-1 flex w-full items-center gap-2 rounded-[12px] px-3 py-3 text-left hover:bg-[#2f2f31] disabled:cursor-wait disabled:opacity-55" disabled={composeExporting} onClick={() => void exportComposeToCanvas()}>
                    <Plus className="h-4 w-4" />
                    导出到画布
                  </button>
                  {composeExportError ? (
                    <div className="mt-2 rounded-[10px] border border-red-400/20 bg-red-500/10 px-3 py-2 text-[12px] leading-5 text-red-100">
                      {composeExportError}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <button className="flex h-10 w-10 items-center justify-center rounded-full text-[#dadce2] hover:bg-[#262628]" onClick={closeComposeEditor}>
              <X className="h-6 w-6" />
            </button>
          </div>
        </div>

        <div className={`px-3 ${composePreviewFullscreen ? "fixed inset-0 z-[130] bg-[#141414] pt-12" : ""}`}>
          <div className="overflow-hidden rounded-[18px] bg-[#202020]">
            <div className="flex h-[calc(100vh-412px)] min-h-[420px] items-center justify-center bg-[#202020]">
              {composeLoading ? (
                <div className="text-[20px] text-[#a7aab1]">加载时间线中...</div>
              ) : composeClips.length === 0 ? (
                <div className="max-w-[420px] px-6 text-center text-[16px] leading-7 text-[#a7aab1]">
                  已连接视频节点，但当前没有可编辑的媒体文件。请等待视频生成完成，或回到画布上传视频。
                </div>
              ) : (
                <ReferencePreviewVideo
                  ref={composePreviewRef}
                  className="h-full max-h-full max-w-full object-contain"
                  muted={composeMuted}
                  controls={false}
                  playsInline
                />
              )}
            </div>
          </div>
        </div>

        <div className="absolute bottom-[22px] left-3 h-[390px] w-[calc(100%_-_24px)] max-w-[2024px] rounded-[18px] border border-[#303030] bg-[#1b1b1b] px-0 pb-0 pt-0">
          <div className="flex h-[76px] items-center gap-8 border-b border-[#303030] px-6 text-[#8d8f95]">
            <button className="hover:text-white" onClick={jumpComposeToPreviousClip}>↶</button>
            <button className="hover:text-white" onClick={jumpComposeToNextClip}>↷</button>
            <button
              className={`flex h-10 w-10 items-center justify-center ${composeCanCrop ? "text-[#d5d7dc] hover:text-white" : "cursor-not-allowed text-[#55575d]"}`}
              onClick={splitComposeClip}
              disabled={!composeCanCrop}
              title="分割"
            >
              <span className="relative block h-6 w-6">
                <span className="absolute left-[6px] top-[3px] h-[18px] w-[2px] rounded bg-current" />
                <span className="absolute right-[6px] top-[3px] h-[18px] w-[2px] rounded bg-current" />
                <span className="absolute left-[3px] top-[3px] h-[2px] w-[5px] rounded bg-current" />
                <span className="absolute left-[3px] bottom-[3px] h-[2px] w-[5px] rounded bg-current" />
                <span className="absolute right-[3px] top-[3px] h-[2px] w-[5px] rounded bg-current" />
                <span className="absolute right-[3px] bottom-[3px] h-[2px] w-[5px] rounded bg-current" />
              </span>
            </button>
            <button
              className={`flex h-10 w-10 items-center justify-center ${composeCanCrop ? "text-[#d5d7dc] hover:text-white" : "cursor-not-allowed text-[#55575d]"}`}
              onClick={trimComposeClipLeft}
              disabled={!composeCanCrop}
              title="裁左"
            >
              <span className="relative block h-6 w-6">
                <span className="absolute left-[6px] top-[3px] h-[18px] w-[2px] rounded bg-current" />
                <span className="absolute right-[6px] top-[3px] h-[18px] w-[2px] rounded bg-current opacity-60" />
                <span className="absolute left-[3px] top-[3px] h-[2px] w-[5px] rounded bg-current" />
                <span className="absolute left-[3px] bottom-[3px] h-[2px] w-[5px] rounded bg-current" />
              </span>
            </button>
            <button
              className={`flex h-10 w-10 items-center justify-center ${composeCanCrop ? "text-[#d5d7dc] hover:text-white" : "cursor-not-allowed text-[#55575d]"}`}
              onClick={trimComposeClipRight}
              disabled={!composeCanCrop}
              title="裁右"
            >
              <span className="relative block h-6 w-6">
                <span className="absolute left-[6px] top-[3px] h-[18px] w-[2px] rounded bg-current opacity-60" />
                <span className="absolute right-[6px] top-[3px] h-[18px] w-[2px] rounded bg-current" />
                <span className="absolute right-[3px] top-[3px] h-[2px] w-[5px] rounded bg-current" />
                <span className="absolute right-[3px] bottom-[3px] h-[2px] w-[5px] rounded bg-current" />
              </span>
            </button>
            <button className="hover:text-white" onClick={() => seekComposeTime(0)}>
              <Clock3 className="h-4 w-4" />
            </button>
            <div className="mx-auto flex items-center gap-5">
              <div className="text-[24px] font-semibold">{formatComposeTime(composeCurrentTime)}</div>
              <button
                className="flex h-[54px] w-[54px] items-center justify-center rounded-full bg-[#474747] text-white"
                onClick={() => {
                  if (composePlaying) {
                    setComposePlaying(false);
                    composePreviewRef.current?.pause();
                  } else {
                    if (composeCurrentTime >= composeTotalDuration) {
                      seekComposeTime(0);
                    }
                    setComposePlaying(true);
                  }
                }}
              >
                {composePlaying ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5 fill-current" />}
              </button>
              <div className="text-[24px] font-semibold text-[#8d8f95]">{formatComposeTime(composeTotalDuration)}</div>
              <button
                className={`flex h-10 w-10 items-center justify-center rounded-[10px] ${composePreviewFullscreen ? "bg-[#3b3b3d]" : "hover:bg-[#2a2a2d]"}`}
                onClick={async () => {
                  const preview = composePreviewRef.current;
                  if (!preview) return;
                  if (document.fullscreenElement) {
                    await document.exitFullscreen().catch(() => undefined);
                  } else {
                    await preview.requestFullscreen?.().catch(() => undefined);
                  }
                }}
              >
                <Expand className="h-5 w-5" />
              </button>
            </div>
            <div className="ml-auto flex items-center gap-5">
              <button className="hover:text-white" onClick={() => setComposeScale((prev) => Math.max(0.6, prev - 0.1))}>
                <ZoomOut className="h-4 w-4" />
              </button>
              <input type="range" min={0.6} max={1.8} step={0.1} value={composeScale} onChange={(e) => setComposeScale(Number(e.target.value))} />
              <button className="hover:text-white" onClick={() => setComposeScale((prev) => Math.min(1.8, prev + 0.1))}>
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                className="hover:text-white"
                onClick={async () => {
                  const preview = composePreviewRef.current;
                  if (!preview) return;
                  if (document.fullscreenElement) {
                    await document.exitFullscreen().catch(() => undefined);
                  } else {
                    await preview.requestFullscreen?.().catch(() => undefined);
                  }
                }}
              >
                <Expand className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="flex h-[313px] overflow-hidden rounded-b-[14px] bg-[#1b1b1b]">
            <div className="w-[148px] shrink-0 border-r border-[#303030]">
              <div className="h-[48px] border-b border-[#2c2c2c]" />
              <div className="flex h-[104px] items-center justify-center gap-7">
                <button
                  className={`flex h-8 w-8 items-center justify-center text-[#b9bdc5] ${composeSelectedClip ? "hover:text-white" : "text-[#5d6067]"}`}
                  onClick={() => composeSelectedClip && setComposeInspectorOpen((prev) => !prev)}
                  disabled={!composeSelectedClip}
                >
                  <Play className="h-6 w-6" />
                </button>
                <button className="flex h-8 w-8 items-center justify-center text-[#d8d8dc] hover:text-white" onClick={toggleComposeMuted}>
                  {composeMuted ? <VolumeX className="h-6 w-6" /> : <Volume2 className="h-6 w-6" />}
                </button>
              </div>
              {composeInspectorOpen && composeSelectedClip ? (
                <div className="absolute bottom-[152px] left-6 z-10 w-[340px] rounded-[18px] border border-[#2f3034] bg-[#18181a] p-4 shadow-[0_18px_42px_rgba(0,0,0,0.44)]">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-[18px] font-semibold text-white">变速</div>
                    <button className="text-[#b6b8be] hover:text-white" onClick={() => setComposeInspectorOpen(false)}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mb-2 text-[14px] text-[#d5d7dd]">倍数</div>
                  <div className="mb-4 flex flex-wrap gap-2">
                    {speedOptions.map((speed) => (
                      <button
                        key={speed}
                        className={`rounded-[10px] px-3 py-2 text-[14px] ${Math.abs((composeSelectedClip?.speed ?? 1) - speed) < 0.01 ? "bg-white text-black" : "bg-[#242427] text-[#d6d8de] hover:bg-[#2f2f33]"}`}
                        onClick={() => setComposeClipSpeed(speed)}
                      >
                        {speed.toFixed(speed === 1 ? 0 : 2)}x
                      </button>
                    ))}
                  </div>
                  <div className="mb-2 text-[14px] text-[#d5d7dd]">时长</div>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0.5}
                      max={Math.max(12, Math.ceil(composeSegmentLength(composeSelectedClip)))}
                      step={0.1}
                      value={Number(composeSelectedClip.duration.toFixed(1))}
                      onChange={(event) => setComposeClipDuration(Number(event.target.value))}
                      className="flex-1"
                    />
                    <input
                      type="number"
                      min={0.5}
                      step={0.1}
                      value={Number(composeSelectedClip.duration.toFixed(1))}
                      onChange={(event) => setComposeClipDuration(Number(event.target.value))}
                      className="w-[88px] rounded-[10px] border border-[#34363c] bg-[#202022] px-3 py-2 text-right text-white outline-none"
                    />
                    <span className="text-[14px] text-[#b9bcc3]">s</span>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-0" style={{ scrollbarWidth: "none" }}>
              <div className="relative" style={{ width: trackWidth }} ref={composeTimelineRef}>
                <div className="flex h-[48px] items-end border-b border-[#2c2c2c]">
                  {Array.from({ length: Math.max(1, Math.ceil(composeTotalDuration) + 1) }).map((_, index) => (
                    <div key={index} className="relative flex-1 text-[20px] text-[#686b72]">
                      <div className="absolute bottom-0 left-0 h-6 w-px bg-[#55575c]" />
                      {Array.from({ length: 9 }).map((__, tickIndex) => (
                        <div key={tickIndex} className="absolute bottom-0 h-3 w-px bg-[#3b3d42]" style={{ left: `${(tickIndex + 1) * 10}%` }} />
                      ))}
                      <span className="ml-1">{formatComposeTime(index)}</span>
                    </div>
                  ))}
                </div>
                <div
                  className="relative h-0 cursor-pointer"
                  onMouseDown={(event) => {
                    const rect = composeTimelineRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
                    seekComposeTime(ratio * composeTotalDuration);
                    setComposeTimelineDragging(true);
                  }}
                >
                  <div
                    className="absolute top-[-44px] z-30 h-[22px] w-[16px] -translate-x-1/2 rounded-[5px] bg-[#dce6ff] shadow-[0_0_0_1px_rgba(0,0,0,0.22)] after:absolute after:left-1/2 after:top-[18px] after:h-0 after:w-0 after:-translate-x-1/2 after:border-l-[6px] after:border-r-[6px] after:border-t-[7px] after:border-l-transparent after:border-r-transparent after:border-t-[#dce6ff]"
                    style={{ left: `${playheadPercent}%` }}
                  />
                </div>
                <div className="relative min-h-[265px] bg-[#1b1b1b]">
                  <div className="flex h-[104px] overflow-hidden rounded-[8px] border border-[#8dffff] bg-[#303030] shadow-[0_0_0_1px_rgba(255,255,255,0.18)]">
                    {composeClips.map((clip) => (
                      <div
                        key={clip.id}
                        className={`relative h-full overflow-hidden border-r border-[#2e2e31] bg-[#34363a] ${composeSelectedClip?.id === clip.id ? "ring-2 ring-[#bfffff] ring-inset" : ""}`}
                        style={{ width: `${Math.max(140, (clip.duration / Math.max(0.1, composeTotalDuration)) * trackWidth)}px` }}
                        onClick={() => selectComposeClip(clip.id)}
                      >
                        {clip.posterUrl ? (
                          <div
                            className="absolute inset-x-0 top-0 h-[76px] bg-repeat-x opacity-90"
                            style={{ backgroundImage: `url(${getCanvasImagePreviewUrl(clip.posterUrl, 360)})`, backgroundSize: "136px 76px" }}
                          />
                        ) : (
                          <ReferencePreviewVideo src={clip.url} className="absolute inset-x-0 top-0 h-[76px] w-full object-cover opacity-80" muted playsInline preload="metadata" />
                        )}
                        <div className="absolute left-2 top-2 rounded bg-black/35 px-2 py-0.5 text-[16px] text-white">
                          {clip.title} {formatComposeTime(clip.duration)}
                        </div>
                        <div className="absolute inset-x-0 bottom-0 h-[27px] bg-[#067f86]">
                          <div className="absolute inset-0 opacity-75">
                            {Array.from({ length: 42 }).map((_, index) => (
                              <span
                                key={index}
                                className="absolute bottom-0 w-[16px] rounded-t-full bg-[#21b8c1]"
                                style={{
                                  left: `${index * 2.5}%`,
                                  height: `${4 + ((index * 17) % 23)}px`,
                                }}
                              />
                            ))}
                          </div>
                        </div>
                        <div className="absolute inset-y-0 left-0 w-[2px] bg-white/50" />
                        <div className="absolute inset-y-0 right-0 w-[2px] bg-white/50" />
                        {composeSelectedClip?.id === clip.id ? (
                          <div className="absolute inset-0 border border-[#c5f2ff]/70" />
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <div className="mt-[-8px] h-[4px] rounded-full bg-[linear-gradient(90deg,#16bfd2,#1597a8)]" style={{ width: `${playheadPercent}%` }} />
                  <div
                    className="pointer-events-none absolute bottom-0 top-[-48px] z-20 w-[2px] bg-[#e9edf8]"
                    style={{ left: `${playheadPercent}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="pointer-events-none absolute bottom-[28px] right-[26px] top-[80px] flex w-[12px] flex-col items-center">
            <div className="mb-1 h-0 w-0 border-b-[7px] border-l-[5px] border-r-[5px] border-b-[#9aa3b0] border-l-transparent border-r-transparent" />
            <div className="relative flex-1">
              <div className="h-full w-[8px] rounded-full bg-[#8993a0]" />
            </div>
            <div className="mt-1 h-0 w-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent border-t-[#9aa3b0]" />
          </div>
        </div>
      </div>
    );
  }
