import { LoaderCircle, Workflow, X } from "lucide-react";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import type { WorkflowTemplate } from "./canvasDataTypes";

export function CanvasWorkflowTemplatePanel({ workflows, loading, error, canDelete, onClose, onReload, onRemove, onApply }: {
  workflows: WorkflowTemplate[];
  loading: boolean;
  error: string;
  canDelete: boolean;
  onClose: () => void;
  onReload: () => void;
  onRemove: (id: string) => void;
  onApply: (workflow: WorkflowTemplate) => void;
}) {
  return <div id="canvas-workflow-panel" data-workflow-panel data-canvas-dialog className="absolute bottom-[92px] left-1/2 z-[98] h-[470px] w-[500px] max-w-[calc(100vw-48px)] -translate-x-1/2 overflow-hidden rounded-[22px] border border-[#3e4045] bg-[#282828] shadow-[0_30px_90px_rgba(0,0,0,0.5)]">
    <div className="flex h-full flex-col">
      <div data-workflow-panel-header className="flex items-center justify-between border-b border-[#3b3c40] px-5 py-4">
        <div className="flex items-center gap-3 text-[14px] text-[#a7a8ad]"><span className="text-[18px] font-semibold text-white">我的工具箱</span><span data-workflow-current-tab>{loading ? "加载中" : error ? "加载失败" : `${workflows.length} 个工作流`}</span></div>
        <button type="button" aria-label="关闭工作流模板" className="text-[#b5b6bb]" onClick={onClose}><X className="h-5 w-5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {loading ? <div className="flex h-full min-h-[320px] flex-col items-center justify-center px-8 text-center"><LoaderCircle className="h-7 w-7 animate-spin text-[#a7a8ad] motion-reduce:animate-none" aria-label="正在加载工作流" /><div className="mt-4 text-[14px] text-[#9da1aa]">正在读取云端工作流…</div></div> : error ? <div role="alert" className="flex h-full min-h-[320px] flex-col items-center justify-center px-8 text-center"><Workflow className="h-9 w-9 text-[#d18b62]" aria-hidden="true" /><div className="mt-4 text-[16px] font-medium text-white">工作流加载失败</div><div className="mt-2 max-w-[340px] text-[13px] leading-6 text-[#c7a58f]">{error}</div><button type="button" className="mt-5 rounded-[10px] border border-[#55575d] px-4 py-2 text-[13px] font-medium text-white transition hover:bg-[#34353a]" onClick={onReload}>重新加载</button></div> : workflows.length === 0 ? <div className="flex h-full min-h-[320px] flex-col items-center justify-center px-8 text-center"><Workflow className="h-9 w-9 text-[#737780]" aria-hidden="true" /><div className="mt-4 text-[16px] font-medium text-white">还没有工作流</div><div className="mt-2 max-w-[320px] text-[13px] leading-6 text-[#9da1aa]">先在看板中选择并创建分组，再把真实节点保存为可复用工作流。</div></div> : <div className="grid grid-cols-3 gap-4">{workflows.map((workflow, index) => <div key={workflow.id} className="group"><div className="relative overflow-hidden rounded-[14px] bg-[#1f2023]"><div className="aspect-[0.95] w-full">{workflow.coverUrl ? <ReferencePreviewImage src={workflow.coverUrl} alt={workflow.name} className="h-full w-full object-cover" /> : <div className="h-full w-full" style={{ background: ["linear-gradient(150deg,#24150c,#5b3922)", "linear-gradient(150deg,#0f172a,#475569)", "linear-gradient(150deg,#3f2a19,#b08968)", "linear-gradient(150deg,#7c3aed,#db2777)"][index % 4] }} />}</div><button type="button" aria-label={`删除工作流 ${workflow.name}`} disabled={!canDelete} data-workflow-card-action className="disabled:cursor-not-allowed disabled:text-white/40 pointer-events-none absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100" onClick={() => onRemove(workflow.id)}><X className="h-4 w-4" /></button><button type="button" data-workflow-card-action className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white px-4 py-2 text-[14px] font-medium text-black opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100" onClick={() => onApply(workflow)}>使用</button></div><div className="mt-2 text-[15px] text-white">{workflow.name}</div></div>)}</div>}
      </div>
    </div>
  </div>;
}
