import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { FileAudio,FileImage,FileText,Film } from "lucide-react";
import { getCanvasImagePreviewUrl } from "./canvasAssetPresentation";
import { type UpstreamReferenceItem } from "./canvasDataTypes";

export interface CanvasReferencePreviewViewDependencies {
  canvasColorMode: import("@/ui/theme").ThemeMode;
}

export function createCanvasReferencePreviewView({
  canvasColorMode,
}: CanvasReferencePreviewViewDependencies) {
function renderReferenceVisual(reference: UpstreamReferenceItem, sizeClass = "h-full w-full") {
    if (reference.thumbnailSrc) {
      return <ReferencePreviewImage src={getCanvasImagePreviewUrl(reference.thumbnailSrc, 420)} alt={reference.label} loading="lazy" decoding="async" className={`${sizeClass} object-cover`} />;
    }
    const Icon = reference.type === "image" ? FileImage : reference.type === "video" ? Film : reference.type === "audio" ? FileAudio : FileText;
    const fallbackTone = canvasColorMode === "light"
      ? "bg-[linear-gradient(135deg,#eef1f6,#dde3ec)] text-[#5f6b7a]"
      : "bg-[linear-gradient(135deg,#4c525d,#23252a)] text-white";
    return (
      <div className={`flex ${sizeClass} items-center justify-center ${fallbackTone}`}>
        <Icon className="h-3.5 w-3.5 opacity-90" />
      </div>
    );
  }
  return { renderReferenceVisual };
}
