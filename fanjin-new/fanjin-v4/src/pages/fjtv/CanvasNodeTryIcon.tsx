import { Boxes, Image as ImageIcon, Languages, Type, Video, Zap } from "lucide-react";

export function CanvasNodeTryIcon({ kind }: { kind: "text" | "video" | "image" | "audio" | "boxes" | "spark" }) {
  if (kind === "text") return <Type className="h-4 w-4" />;
  if (kind === "video") return <Video className="h-4 w-4" />;
  if (kind === "image") return <ImageIcon className="h-4 w-4" />;
  if (kind === "audio") return <Languages className="h-4 w-4" />;
  if (kind === "boxes") return <Boxes className="h-4 w-4" />;
  return <Zap className="h-4 w-4" />;
}
