import React from "react";
import { Check, Magnet, Repeat2, X } from "lucide-react";
import { ReferencePreviewVideo } from "@/features/quick-create/attachments/AuthenticatedReferenceMedia";

export function renderVideoTrimEditorExternal(node: any, deps: any) {
  if (deps.activeVideoEditor?.nodeId !== node.id || deps.activeVideoEditor.mode !== "trim" || !deps.videoTrimDraft) return null;
  const draft = deps.videoTrimDraft;
  const duration = Math.max(0.5, draft.duration);
  const trimWidth = Math.max(280, node.width + 260);
  const leftPercent = (draft.start / duration) * 100;
  const selectedPercent = ((draft.end - draft.start) / duration) * 100;
  const displayDuration = draft.end - draft.start;
  const currentAbsolute = deps.videoNodeCurrentTimes[node.id] ?? draft.start;
  const currentPercent = (Math.max(0, Math.min(duration, currentAbsolute)) / duration) * 100;
  return (
    <div data-fixed-ui data-node-toolbar className="absolute z-40 flex items-center gap-4 rounded-[20px] border border-[#3f4044] bg-[#232325] px-5 py-3 shadow-[0_22px_52px_rgba(0,0,0,0.42)]" style={{ left: node.x + node.width / 2, top: node.y + node.height + 18, width: trimWidth, transform: "translateX(-50%)" }} onMouseDown={(event) => event.stopPropagation()}>
      <button className="flex h-10 w-10 items-center justify-center rounded-[12px] text-white/88 hover:bg-[#2f3033]" onClick={deps.closeVideoEditor}><X className="h-5 w-5" /></button>
      <div className="h-10 w-px bg-[#3b3c40]" />
      <div className="relative flex-1"><div className="relative h-[66px] overflow-hidden rounded-[14px] bg-[#1b1b1d]">
        <ReferencePreviewVideo src={node.videoUrl || node.localVideoUrl} className="h-full w-full object-cover opacity-45" muted playsInline />
        <div className="absolute inset-y-0 left-0 bg-black/50" style={{ width: `${leftPercent}%` }} /><div className="absolute inset-y-0 right-0 bg-black/50" style={{ width: `${Math.max(0, 100 - leftPercent - selectedPercent)}%` }} />
        <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-[#7fd4ff]" style={{ left: `${currentPercent}%` }} />
        <div className="absolute inset-y-[8px] z-10 rounded-[12px] border border-white bg-white/10 shadow-[0_0_0_1px_rgba(255,255,255,0.15)]" style={{ left: `${leftPercent}%`, width: `${selectedPercent}%` }} onMouseDown={(event) => { event.stopPropagation(); deps.setVideoTrimDragging({ type: "move", pointerStart: event.clientX, initialStart: draft.start, initialEnd: draft.end }); }}>
          <button className="absolute inset-y-0 left-0 w-3 cursor-ew-resize rounded-l-[12px] bg-white" onMouseDown={(event) => { event.stopPropagation(); deps.setVideoTrimDragging({ type: "start", pointerStart: event.clientX, initialStart: draft.start, initialEnd: draft.end }); }} />
          <button className="absolute inset-y-0 right-0 w-3 cursor-ew-resize rounded-r-[12px] bg-white" onMouseDown={(event) => { event.stopPropagation(); deps.setVideoTrimDragging({ type: "end", pointerStart: event.clientX, initialStart: draft.start, initialEnd: draft.end }); }} />
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[12px] bg-[#2e3137] px-3 py-2 text-[14px] font-semibold text-white">{displayDuration.toFixed(2)} s</div>
        </div>
      </div></div>
      <button title={draft.snapToWholeSecond ? "关闭整秒吸附" : "开启整秒吸附"} className={`flex h-10 w-10 items-center justify-center rounded-[12px] ${draft.snapToWholeSecond ? "bg-[#34373d] text-white" : "text-white/78 hover:bg-[#2f3033]"}`} onClick={() => deps.setVideoTrimDraft((prev: any) => (prev ? { ...prev, snapToWholeSecond: !prev.snapToWholeSecond } : prev))}><span className="relative flex h-4.5 w-4.5 items-center justify-center"><Magnet className="h-4.5 w-4.5" />{!draft.snapToWholeSecond ? <span className="absolute h-[2px] w-5 rotate-[-45deg] rounded-full bg-current" /> : null}</span></button>
      <button title={draft.loopSelection ? "关闭选区循环播放" : "开启选区循环播放"} className={`flex h-10 w-10 items-center justify-center rounded-[12px] ${draft.loopSelection ? "bg-[#34373d] text-white" : "text-white/78 hover:bg-[#2f3033]"}`} onClick={() => deps.setVideoTrimDraft((prev: any) => (prev ? { ...prev, loopSelection: !prev.loopSelection } : prev))}><Repeat2 className="h-4.5 w-4.5" /></button>
      <button className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-white text-[#161719]" onClick={() => void deps.confirmVideoTrim()}><Check className="h-6 w-6" /></button>
    </div>
  );
}
