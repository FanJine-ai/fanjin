import { Download, X } from "lucide-react";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { ReferencePreviewVideo } from "@/features/quick-create/attachments/AuthenticatedReferenceMedia";

type MediaViewerNode = { title: string; type: string };

export function CanvasMediaViewerOverlay({
  node,
  mediaUrl,
  onDownload,
  onClose,
}: {
  node: MediaViewerNode;
  mediaUrl: string;
  onDownload: () => void;
  onClose: () => void;
}) {
  return (
    <div data-fixed-ui className="absolute inset-0 z-[120] bg-black/88" onMouseDown={onClose}>
      <div className="absolute left-8 top-7 text-[18px] font-semibold text-white">{node.title}</div>
      <div className="absolute right-8 top-7 flex items-center gap-3">
        <button className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-white/10 text-white transition hover:bg-white/16" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); onDownload(); }}>
          <Download className="h-5 w-5" />
        </button>
        <button className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-white/10 text-white transition hover:bg-white/16" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
          <X className="h-6 w-6" />
        </button>
      </div>
      <div className="absolute inset-x-8 bottom-8 top-20 flex items-center justify-center" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}>
        {node.type === "video" ? <ReferencePreviewVideo src={mediaUrl} controls autoPlay className="max-h-full max-w-full bg-black object-contain" /> : <ReferencePreviewImage src={mediaUrl} alt={node.title} className="max-h-full max-w-full object-contain" />}
      </div>
    </div>
  );
}
