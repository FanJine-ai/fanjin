import { useState } from "react";

export function useCanvasStoryboardState() {
  const [storyboardSlotMenuNodeId, setStoryboardSlotMenuNodeId] = useState<string | null>(null);
  const [storyboardSlotMenuPosition, setStoryboardSlotMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [storyboardHistoryTargetNodeId, setStoryboardHistoryTargetNodeId] = useState<string | null>(null);
  const [storyboardSlotUploadTargetNodeId, setStoryboardSlotUploadTargetNodeId] = useState<string | null>(null);
  const [storyboardToolbarRatioOpen, setStoryboardToolbarRatioOpen] = useState(false);
  const [storyboardToolbarGridOpen, setStoryboardToolbarGridOpen] = useState(false);
  const [storyboardToolbarStitchOpen, setStoryboardToolbarStitchOpen] = useState(false);
  return {
    storyboardSlotMenuNodeId, setStoryboardSlotMenuNodeId,
    storyboardSlotMenuPosition, setStoryboardSlotMenuPosition,
    storyboardHistoryTargetNodeId, setStoryboardHistoryTargetNodeId,
    storyboardSlotUploadTargetNodeId, setStoryboardSlotUploadTargetNodeId,
    storyboardToolbarRatioOpen, setStoryboardToolbarRatioOpen,
    storyboardToolbarGridOpen, setStoryboardToolbarGridOpen,
    storyboardToolbarStitchOpen, setStoryboardToolbarStitchOpen,
  };
}
