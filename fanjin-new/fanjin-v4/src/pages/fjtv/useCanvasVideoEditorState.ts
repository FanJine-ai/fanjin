import type { VideoTrimDraft, VideoCropDraft } from "./canvasDataTypes";
import { useRef, useState } from "react";

export function useCanvasVideoEditorState() {
  const [activeVideoEditor, setActiveVideoEditor] = useState<{ nodeId: string; mode: "trim" | "erase-subtitle" | "erase-region" } | null>(null);
  const [videoTrimDraft, setVideoTrimDraft] = useState<VideoTrimDraft | null>(null);
  const [videoCropDraft, setVideoCropDraft] = useState<VideoCropDraft | null>(null);
  const [videoTrimDragging, setVideoTrimDragging] = useState<null | { type: "start" | "end" | "move"; pointerStart: number; initialStart: number; initialEnd: number }>(null);
  const [videoCropDragging, setVideoCropDragging] = useState<
    | null
    | {
        type: "move" | "left" | "right" | "top" | "bottom" | "corner";
        startX: number;
        startY: number;
        initial: VideoCropDraft;
        aspect: number;
      }
  >(null);
  const [videoEnhanceResolutionOpen, setVideoEnhanceResolutionOpen] = useState(false);
  const [videoSubtitleMenuNodeId, setVideoSubtitleMenuNodeId] = useState<string | null>(null);
  const [videoFrameMenuNodeId, setVideoFrameMenuNodeId] = useState<string | null>(null);
  const [videoStoryFullscreenNodeId, setVideoStoryFullscreenNodeId] = useState<string | null>(null);
  const videoStoryPollInFlightRef = useRef(new Set<number>());
  const videoStoryResumeAttemptedRef = useRef(new Set<number>());
  return {
    activeVideoEditor, setActiveVideoEditor,
    videoTrimDraft, setVideoTrimDraft,
    videoCropDraft, setVideoCropDraft,
    videoTrimDragging, setVideoTrimDragging,
    videoCropDragging, setVideoCropDragging,
    videoEnhanceResolutionOpen, setVideoEnhanceResolutionOpen,
    setVideoSubtitleMenuNodeId, videoFrameMenuNodeId,
    setVideoFrameMenuNodeId, videoStoryFullscreenNodeId,
    setVideoStoryFullscreenNodeId, videoStoryPollInFlightRef,
    videoStoryResumeAttemptedRef,
  };
}
