import { useState } from "react";
import { type ComposeClip } from "./canvasComposeTimeline";
import { type CanvasComposeVideoAsset } from "@/lib/api";

export function useCanvasComposeState() {
  const [composeEditorNodeId, setComposeEditorNodeId] = useState<string | null>(null);
  const [composeClips, setComposeClips] = useState<ComposeClip[]>([]);
  const [composeSelectedClipId, setComposeSelectedClipId] = useState<string | null>(null);
  const [composeCurrentTime, setComposeCurrentTime] = useState(0);
  const [composePlaying, setComposePlaying] = useState(false);
  const [composeMuted, setComposeMuted] = useState(false);
  const [composeExportOpen, setComposeExportOpen] = useState(false);
  const [composePreviewFullscreen, setComposePreviewFullscreen] = useState(false);
  const [composeScale, setComposeScale] = useState(1);
  const [composeLoading, setComposeLoading] = useState(false);
  const [composeExporting, setComposeExporting] = useState(false);
  const [composeExportError, setComposeExportError] = useState("");
  const [composeRenderResult, setComposeRenderResult] = useState<CanvasComposeVideoAsset | null>(null);
  const [composeInspectorOpen, setComposeInspectorOpen] = useState(false);
  const [composeTimelineDragging, setComposeTimelineDragging] = useState(false);
  return {
    composeEditorNodeId, setComposeEditorNodeId,
    composeClips, setComposeClips,
    composeSelectedClipId, setComposeSelectedClipId,
    composeCurrentTime, setComposeCurrentTime,
    composePlaying, setComposePlaying,
    composeMuted, setComposeMuted,
    composeExportOpen, setComposeExportOpen,
    composePreviewFullscreen, setComposePreviewFullscreen,
    composeScale, setComposeScale,
    composeLoading, setComposeLoading,
    composeExporting, setComposeExporting,
    composeExportError, setComposeExportError,
    composeRenderResult, setComposeRenderResult,
    composeInspectorOpen, setComposeInspectorOpen,
    composeTimelineDragging, setComposeTimelineDragging,
  };
}
