import type { CanvasConflictState } from "./canvasDataTypes";

export function CanvasProjectGate({ activeProjectId, onCreateCanvas, onOpenProjects, onCreateProject }: { activeProjectId: string | number | null; onCreateCanvas: () => void; onOpenProjects: () => void; onCreateProject: () => void }) {
  return <div data-fixed-ui data-canvas-dialog data-canvas-project-gate role="alert" className="absolute left-1/2 top-1/2 z-[110] w-[min(460px,calc(100vw-40px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/15 bg-[#17191e]/95 p-6 text-white shadow-[0_24px_80px_rgba(0,0,0,.45)]">
    <h2 className="text-lg font-semibold">{activeProjectId ? "此项目还没有打开画布" : "请先选择真实项目"}</h2>
    <p className="mt-2 text-sm leading-6 text-white/70">{activeProjectId ? "创建画布后才能添加节点并保存，系统不会复用其他项目的画布。" : "看板内容必须归属于工作区中的真实项目，系统不会复用上一次打开的不相关项目。"}</p>
    <div className="mt-5 flex flex-wrap gap-3">{activeProjectId ? <button type="button" className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black" onClick={onCreateCanvas}>为此项目新建画布</button> : <><button type="button" className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black" onClick={onOpenProjects}>选择项目</button><button type="button" className="rounded-lg border border-white/20 px-4 py-2 text-sm text-white" onClick={onCreateProject}>新建项目</button></>}</div>
  </div>;
}

export function CanvasConflictGuard({ conflict, onReload }: { conflict: CanvasConflictState; onReload: () => void }) {
  return <div data-fixed-ui data-canvas-alert data-testid="canvas-cas-conflict" role="alertdialog" aria-modal="true" aria-labelledby="canvas-conflict-title" className="absolute left-1/2 top-1/2 z-[120] w-[min(500px,calc(100vw-40px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#f3b56d]/45 bg-[#201b18]/98 p-6 text-white shadow-[0_28px_90px_rgba(0,0,0,.55)]">
    <h2 id="canvas-conflict-title" className="text-lg font-semibold">检测到画布并发更新</h2>
    <p className="mt-2 text-sm leading-6 text-white/75">{conflict.message}。为避免覆盖其他标签页或 Agent 的修改，当前本地版本已停止自动保存。</p>
    <button type="button" className="mt-5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black" onClick={onReload}>加载服务器最新版本</button>
  </div>;
}

export function CanvasStatusToast({ status }: { status: string }) {
  const error = /阻止|失败|未就绪|不可用|请先|错误|待确认|暂未/.test(status);
  return <div data-fixed-ui data-canvas-status-tone={error ? "error" : "info"} role="status" aria-live="polite" className={`pointer-events-none absolute bottom-[76px] left-1/2 z-[95] max-w-[calc(100vw-40px)] -translate-x-1/2 rounded-md px-3 py-1 text-sm shadow-[0_8px_24px_rgba(0,0,0,0.22)] ${error ? "border border-[#9d4545]/60 bg-[#3b1d1d]/95 text-[#ffd0cb]" : "bg-[#1f232b] text-[#d5dae2]"}`}><span className="block truncate">{status}</span></div>;
}
