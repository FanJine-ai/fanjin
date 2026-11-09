import { X } from "lucide-react";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { ReferencePreviewVideo } from "@/features/quick-create/attachments/AuthenticatedReferenceMedia";

export type CanvasHistoryPreviewItem = {
  type: string;
  url: string;
  prompt?: string;
  model?: string;
};

export function CanvasHistoryPreviewDialog({
  item,
  onClose,
}: {
  item: CanvasHistoryPreviewItem;
  onClose: () => void;
}) {
  return (
    <div data-fixed-ui className="absolute inset-0 z-[97] bg-black/88" onClick={onClose}>
      <button type="button" aria-label="关闭预览" className="absolute right-6 top-6 z-10 text-white/80 hover:text-white" onClick={onClose}><X className="h-7 w-7" /></button>
      <div className="flex h-full w-full items-center justify-center p-10" onClick={(event) => event.stopPropagation()}>
        {item.type === "video" ? (
          <ReferencePreviewVideo src={item.url} controls autoPlay className="max-h-full max-w-full rounded-[18px] bg-black" />
        ) : (
          <ReferencePreviewImage src={item.url} alt={item.prompt || item.model || "历史生成结果"} className="max-h-full max-w-full rounded-[18px] object-contain" />
        )}
      </div>
    </div>
  );
}
