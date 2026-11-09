import { Image as ImageIcon, Upload } from "lucide-react";

export function CanvasStoryboardSlotMenu({ position, onUpload, onHistory }: { position: { x: number; y: number }; onUpload: () => void; onHistory: () => void }) {
  return <div data-storyboard-slot-menu className="absolute z-[70] w-[312px] rounded-[24px] border border-[#4a4b50] bg-[#3a3a3c] p-4 shadow-[0_20px_42px_rgba(0,0,0,0.38)]" style={{ left: position.x, top: position.y }} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}><button className="flex h-14 w-full items-center gap-3 rounded-[16px] px-4 text-left text-[18px] text-white transition hover:bg-[#4a4a4d]" onClick={onUpload}><Upload className="h-6 w-6" /><span>从本地上传图片</span></button><button className="mt-1 flex h-14 w-full items-center gap-3 rounded-[16px] px-4 text-left text-[18px] text-white transition hover:bg-[#4a4a4d]" onClick={onHistory}><ImageIcon className="h-6 w-6" /><span>从历史记录中选择</span></button></div>;
}
