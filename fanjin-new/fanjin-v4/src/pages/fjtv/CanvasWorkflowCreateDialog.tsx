import { ImageIcon, X } from "lucide-react";
import type { ChangeEvent } from "react";
import type { NodeData } from "./canvasDataTypes";
import { getCanvasImagePreviewUrl } from "./canvasAssetPresentation";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";

interface CanvasWorkflowCreateDialogProps {
  candidates: NodeData[];
  coverNodeId: string | null;
  name: string;
  note: string;
  onClose: () => void;
  onCoverChange: (nodeId: string) => void;
  onNameChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onNoteChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onCreate: () => void;
}

export function CanvasWorkflowCreateDialog({ candidates, coverNodeId, name, note, onClose, onCoverChange, onNameChange, onNoteChange, onCreate }: CanvasWorkflowCreateDialogProps) {
  const coverNode = candidates.find((node) => node.id === coverNodeId) ?? candidates[0] ?? null;
  const coverSrc = coverNode ? coverNode.type === "video" ? coverNode.videoUrl || coverNode.localVideoUrl || "" : coverNode.imageUrl || coverNode.localPreviewUrl || "" : "";
  return (
    <div data-fixed-ui className="absolute inset-0 z-[99] flex items-center justify-center bg-black/55">
      <div data-canvas-dialog role="dialog" aria-modal="true" aria-labelledby="canvas-workflow-dialog-title" className="relative w-[800px] max-w-[calc(100vw-48px)] rounded-[18px] border border-[#434448] bg-[#2a2a2b] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
        <button type="button" aria-label="关闭工作流编辑" className="absolute right-5 top-4 text-[#9aa2b1]" onClick={onClose}><X className="h-7 w-7" /></button>
        <div className="border-b border-[#3b3c40] px-6 py-5"><div className="flex items-center gap-6 text-[24px] font-semibold text-white"><span id="canvas-workflow-dialog-title">创建新工具箱</span><span className="text-[#8f939a]">更新工具箱</span></div></div>
        <div className="grid grid-cols-[360px_1fr] gap-6 p-6">
          <div><div className="mb-3 text-sm text-[#b0b3bb]">封面</div><div data-media-preview className="overflow-hidden rounded-[18px] border border-[#44464b] bg-[#1d1f23]"><div className="aspect-[0.74] w-full">{coverSrc ? <ReferencePreviewImage src={coverSrc} alt="工具箱封面" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-[#8f939a]"><ImageIcon className="h-10 w-10" /></div>}</div>{candidates.length > 0 ? <div className="border-t border-[#34363b] p-3"><div className="mb-2 text-xs text-[#9ea2a9]">更换封面</div><div className="flex gap-2 overflow-x-auto pb-1">{candidates.map((node) => { const src = node.type === "video" ? node.videoUrl || node.localVideoUrl || "" : node.imageUrl || node.localPreviewUrl || ""; return <button key={node.id} type="button" onClick={() => onCoverChange(node.id)} className={`h-16 w-16 shrink-0 overflow-hidden rounded-xl border ${coverNodeId === node.id ? "border-white" : "border-[#4a4c51]"}`}>{src ? <ReferencePreviewImage src={getCanvasImagePreviewUrl(src, 360)} alt={node.title} loading="lazy" decoding="async" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center bg-[#22252a] text-[#8f939a]"><ImageIcon className="h-4 w-4" /></div>}</button>; })}</div></div> : null}</div></div>
          <div className="space-y-5"><div><div className="mb-2 text-sm text-[#b0b3bb]">名称</div><input value={name} maxLength={20} onChange={onNameChange} className="h-12 w-full rounded-xl border border-[#3c3d42] bg-[#1f2023] px-4 text-base text-white outline-none" placeholder="工具箱" /></div><div><div className="mb-2 text-sm text-[#b0b3bb]">备注</div><textarea value={note} onChange={onNoteChange} className="h-[180px] w-full resize-none rounded-xl border border-[#3c3d42] bg-[#1f2023] px-4 py-3 text-sm text-white outline-none placeholder:text-[#72767e]" placeholder="请输入您的工具箱，例如应用场景、使用步骤及使用技巧" /></div></div>
        </div>
        <div className="flex justify-end px-6 pb-6"><button className="rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black" onClick={onCreate}>创建</button></div>
      </div>
    </div>
  );
}
