import { Sparkles } from "lucide-react";

export function CanvasVideoEditMenuItem({ onEdit }: { onEdit: () => void }) {
  return <button type="button" aria-label="修改视频" title="按新要求重拍这一段" className="flex h-11 w-full items-center gap-3 rounded-[12px] px-0 text-left text-white transition hover:bg-[#333335]" onClick={onEdit}>
    <span className="flex h-7 w-7 items-center justify-center text-[#f0f1f4]"><Sparkles className="h-5 w-5" /></span>
    <span className="flex flex-col gap-0.5"><span className="text-[14px] font-medium leading-none">修改视频</span><span className="text-[11px] leading-none text-[#8e8f95]">按新要求重拍这一段</span></span>
  </button>;
}
