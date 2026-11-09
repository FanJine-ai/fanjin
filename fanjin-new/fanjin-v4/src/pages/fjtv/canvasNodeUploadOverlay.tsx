import type * as React from "react";

export function renderNodeUploadOverlay(node: any, deps: any): React.ReactNode {
  const { nodeUploadIsActive, nodeUploadSingleFlightRef, retryNodeUpload, cancelNodeTransferOrGeneration } = deps;
  const isActive = nodeUploadIsActive(node), isFailed = node.uploadState === "failed";
  const retryInFlight = nodeUploadSingleFlightRef.current.isRunning(node.id);
  if (!isActive && !isFailed) return null;
  const uploadPercent = Math.max(1, Math.min(99, Math.round(node.uploadProgress || 1)));
  const stop = (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
  return <div className="pointer-events-auto absolute inset-[3px] z-20 overflow-hidden rounded-[13px] bg-black/22 backdrop-blur-[13px]" onMouseDown={stop} onClick={(event) => event.stopPropagation()}>
    <div className="absolute inset-0 bg-[#555]/42 opacity-75" style={{ animation: "node-upload-soft-breathe 1.8s ease-in-out infinite" }} />
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_74%_8%,rgba(0,0,0,0.32),transparent_12%),radial-gradient(circle_at_50%_36%,rgba(0,0,0,0.20),transparent_12%)] opacity-70" />
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-3 px-5 text-center text-[15px] font-semibold text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)]"><span>{isFailed ? (node.uploadError || "上传失败") : `上传中（${uploadPercent}%）...`}</span>
      {isFailed ? <div className="flex items-center gap-2"><button type="button" disabled={retryInFlight} className="rounded-md border border-white/70 bg-black/35 px-3 py-1.5 text-[13px] hover:bg-black/55 disabled:cursor-not-allowed disabled:opacity-55" onClick={(event) => { stop(event); void retryNodeUpload(node.id); }}>{retryInFlight ? "重试中…" : "重试上传"}</button><button type="button" className="rounded-md border border-white/50 bg-black/25 px-3 py-1.5 text-[13px] hover:bg-black/55" onClick={(event) => { stop(event); void cancelNodeTransferOrGeneration(node.id); }}>移除素材</button></div> : <button type="button" className="rounded-md border border-white/70 bg-black/35 px-3 py-1.5 text-[13px] hover:bg-black/55" onClick={(event) => { stop(event); void cancelNodeTransferOrGeneration(node.id); }}>取消上传</button>}
    </div></div>;
}
