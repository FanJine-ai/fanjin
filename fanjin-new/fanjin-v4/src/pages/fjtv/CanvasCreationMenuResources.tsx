import { Upload, Workflow } from "lucide-react";

export function CanvasCreationMenuResources({ onUpload, onHistory }: { onUpload: () => void; onHistory: () => void }) {
  return <>
    <div className="mb-3 mt-4 text-[14px] text-[#8e8f95]">添加资源</div>
    <button className="flex h-11 w-full items-center gap-3 rounded-[14px] px-3 text-left text-white transition hover:bg-[#333335]" onClick={onUpload}>
      <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#3a3a3d] text-[#f0f1f4]"><Upload className="h-5 w-5" /></span>
      <span className="text-[14px] font-medium leading-none">上传</span>
    </button>
    <button className="mt-1.5 flex h-11 w-full items-center gap-3 rounded-[14px] px-3 text-left text-white transition hover:bg-[#333335]" onClick={onHistory}>
      <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#3a3a3d] text-[#f0f1f4]"><Workflow className="h-5 w-5" /></span>
      <span className="text-[14px] font-medium leading-none">从生成历史选择</span>
    </button>
  </>;
}
