import { useEffect, type DependencyList, type Dispatch, type SetStateAction, type RefObject, type ReactNode, type JSX } from "react";
import type { NodeData, VideoTrimDraft, VideoCropDraft, ImageOutpaintDragState, ImageCropDragState } from "./canvasDataTypes";
import type { ImageOutpaintDraft, ImageCropDraft } from "./canvasMediaTypes";
import { clampImageOutpaintDraft, clampImageCropDraft } from "./canvasMediaGeometry";
import { clampVideoCropDraft } from "./canvasAssetPresentation";

interface UseCanvasVideoTrimLoopContext {
  activeVideoEditor: { nodeId: string; mode: "trim" | "erase-subtitle" | "erase-region"; } | null;
  videoTrimDraft: VideoTrimDraft | null;
  nodeVideoRefs: RefObject<Record<string, HTMLVideoElement | null>>;
}

export function useCanvasVideoTrimLoop(readContext: () => UseCanvasVideoTrimLoopContext, dependencies: DependencyList) {
  useEffect(() => {
    const { activeVideoEditor, videoTrimDraft, nodeVideoRefs } = readContext();

    if (!activeVideoEditor || activeVideoEditor.mode !== "trim" || !videoTrimDraft) return;
    const video = nodeVideoRefs.current[activeVideoEditor.nodeId];
    if (!video) return;
    const onTimeUpdate = () => {
      if (!videoTrimDraft.loopSelection) return;
      if (video.currentTime >= videoTrimDraft.end - 0.03) {
        video.currentTime = videoTrimDraft.start;
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);

  }, dependencies);
}

interface UseCanvasVideoTrimDragContext {
  videoTrimDragging: { type: "start" | "end" | "move"; pointerStart: number; initialStart: number; initialEnd: number; } | null;
  activeVideoEditor: { nodeId: string; mode: "trim" | "erase-subtitle" | "erase-region"; } | null;
  videoTrimDraft: VideoTrimDraft | null;
  nodeMap: Map<string, NodeData>;
  applyTrimSnap: (value: number, enabled: boolean) => number;
  setVideoTrimDraft: Dispatch<SetStateAction<VideoTrimDraft | null>>;
  setVideoTrimDragging: Dispatch<SetStateAction<{ type: "start" | "end" | "move"; pointerStart: number; initialStart: number; initialEnd: number; } | null>>;
}

export function useCanvasVideoTrimDrag(readContext: () => UseCanvasVideoTrimDragContext, dependencies: DependencyList) {
  useEffect(() => {
    const { videoTrimDragging, activeVideoEditor, videoTrimDraft, nodeMap, applyTrimSnap, setVideoTrimDraft, setVideoTrimDragging } = readContext();

    if (!videoTrimDragging || !activeVideoEditor || activeVideoEditor.mode !== "trim" || !videoTrimDraft) return;
    const onMove = (event: MouseEvent) => {
      const node = nodeMap.get(activeVideoEditor.nodeId);
      if (!node) return;
      const timelineWidth = Math.max(280, node.width + 260);
      const deltaSeconds = ((event.clientX - videoTrimDragging.pointerStart) / timelineWidth) * videoTrimDraft.duration;
      const snap = (value: number) => applyTrimSnap(value, videoTrimDraft.snapToWholeSecond);
      if (videoTrimDragging.type === "start") {
        const nextStart = Math.max(0, Math.min(videoTrimDragging.initialEnd - 0.1, snap(videoTrimDragging.initialStart + deltaSeconds)));
        setVideoTrimDraft((prev) => (prev ? { ...prev, start: nextStart } : prev));
        return;
      }
      if (videoTrimDragging.type === "end") {
        const nextEnd = Math.max(videoTrimDragging.initialStart + 0.1, Math.min(videoTrimDraft.duration, snap(videoTrimDragging.initialEnd + deltaSeconds)));
        setVideoTrimDraft((prev) => (prev ? { ...prev, end: nextEnd } : prev));
        return;
      }
      const span = videoTrimDragging.initialEnd - videoTrimDragging.initialStart;
      const nextStart = Math.max(0, Math.min(videoTrimDraft.duration - span, snap(videoTrimDragging.initialStart + deltaSeconds)));
      setVideoTrimDraft((prev) => (prev ? { ...prev, start: nextStart, end: nextStart + span } : prev));
    };
    const onUp = () => setVideoTrimDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

  }, dependencies);
}

interface UseCanvasVideoEraseRegionDragContext {
  videoCropDragging: { type: "move" | "left" | "right" | "top" | "bottom" | "corner"; startX: number; startY: number; initial: VideoCropDraft; aspect: number; } | null;
  activeVideoEditor: { nodeId: string; mode: "trim" | "erase-subtitle" | "erase-region"; } | null;
  videoCropDraft: VideoCropDraft | null;
  nodeMap: Map<string, NodeData>;
  setVideoCropDraft: Dispatch<SetStateAction<VideoCropDraft | null>>;
  setVideoCropDragging: Dispatch<SetStateAction<{ type: "move" | "left" | "right" | "top" | "bottom" | "corner"; startX: number; startY: number; initial: VideoCropDraft; aspect: number; } | null>>;
}

export function useCanvasVideoEraseRegionDrag(readContext: () => UseCanvasVideoEraseRegionDragContext, dependencies: DependencyList) {
  useEffect(() => {
    const { videoCropDragging, activeVideoEditor, videoCropDraft, nodeMap, setVideoCropDraft, setVideoCropDragging } = readContext();

    if (!videoCropDragging || !activeVideoEditor || activeVideoEditor.mode !== "erase-region" || !videoCropDraft) return;
    const node = nodeMap.get(activeVideoEditor.nodeId);
    if (!node) return;
    const onMove = (event: MouseEvent) => {
      const dx = (event.clientX - videoCropDragging.startX) / Math.max(1, node.width);
      const dy = (event.clientY - videoCropDragging.startY) / Math.max(1, node.height);
      const initial = videoCropDragging.initial;
      if (videoCropDragging.type === "move") {
        setVideoCropDraft(clampVideoCropDraft({ ...initial, x: initial.x + dx, y: initial.y + dy }));
        return;
      }
      if (videoCropDragging.type === "right") {
        setVideoCropDraft(clampVideoCropDraft({ ...initial, width: initial.width + dx }));
        return;
      }
      if (videoCropDragging.type === "left") {
        const nextX = initial.x + dx;
        const nextWidth = initial.width - dx;
        setVideoCropDraft(clampVideoCropDraft({ ...initial, x: nextX, width: nextWidth }));
        return;
      }
      if (videoCropDragging.type === "top") {
        const nextY = initial.y + dy;
        const nextHeight = initial.height - dy;
        setVideoCropDraft(clampVideoCropDraft({ ...initial, y: nextY, height: nextHeight }));
        return;
      }
      if (videoCropDragging.type === "bottom") {
        setVideoCropDraft(clampVideoCropDraft({ ...initial, height: initial.height + dy }));
        return;
      }
      const nextWidth = Math.max(0.08, initial.width + dx);
      const nextHeight = Math.max(0.08, nextWidth / Math.max(0.1, videoCropDragging.aspect));
      setVideoCropDraft(clampVideoCropDraft({ ...initial, width: nextWidth, height: nextHeight }));
    };
    const onUp = () => setVideoCropDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

  }, dependencies);
}

interface UseCanvasImageOutpaintDragContext {
  imageOutpaintDragging: ImageOutpaintDragState | null;
  activeImageOutpaint: ImageOutpaintDraft | null;
  nodeMap: Map<string, NodeData>;
  setActiveImageOutpaint: Dispatch<SetStateAction<ImageOutpaintDraft | null>>;
  setImageOutpaintDragging: Dispatch<SetStateAction<ImageOutpaintDragState | null>>;
}

export function useCanvasImageOutpaintDrag(readContext: () => UseCanvasImageOutpaintDragContext, dependencies: DependencyList) {
  useEffect(() => {
    const { imageOutpaintDragging, activeImageOutpaint, nodeMap, setActiveImageOutpaint, setImageOutpaintDragging } = readContext();

    if (!imageOutpaintDragging || !activeImageOutpaint || imageOutpaintDragging.nodeId !== activeImageOutpaint.nodeId) return;
    const node = nodeMap.get(activeImageOutpaint.nodeId);
    if (!node) return;
    const onMove = (event: MouseEvent) => {
      const dx = (event.clientX - imageOutpaintDragging.startX) / Math.max(1, node.width);
      const dy = (event.clientY - imageOutpaintDragging.startY) / Math.max(1, node.height);
      const initial = imageOutpaintDragging.initial;
      if (imageOutpaintDragging.side === "left") {
        setActiveImageOutpaint(clampImageOutpaintDraft({ ...initial, expandLeft: initial.expandLeft - dx }));
        return;
      }
      if (imageOutpaintDragging.side === "right") {
        setActiveImageOutpaint(clampImageOutpaintDraft({ ...initial, expandRight: initial.expandRight + dx }));
        return;
      }
      if (imageOutpaintDragging.side === "top") {
        setActiveImageOutpaint(clampImageOutpaintDraft({ ...initial, expandTop: initial.expandTop - dy }));
        return;
      }
      setActiveImageOutpaint(clampImageOutpaintDraft({ ...initial, expandBottom: initial.expandBottom + dy }));
    };
    const onUp = () => setImageOutpaintDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

  }, dependencies);
}

interface UseCanvasImageCropDragContext {
  imageCropDragging: ImageCropDragState | null;
  activeImageCrop: ImageCropDraft | null;
  nodeMap: Map<string, NodeData>;
  setActiveImageCrop: Dispatch<SetStateAction<ImageCropDraft | null>>;
  setImageCropDragging: Dispatch<SetStateAction<ImageCropDragState | null>>;
}

export function useCanvasImageCropDrag(readContext: () => UseCanvasImageCropDragContext, dependencies: DependencyList) {
  useEffect(() => {
    const { imageCropDragging, activeImageCrop, nodeMap, setActiveImageCrop, setImageCropDragging } = readContext();

    if (!imageCropDragging || !activeImageCrop || imageCropDragging.nodeId !== activeImageCrop.nodeId) return;
    const node = nodeMap.get(activeImageCrop.nodeId);
    if (!node) return;
    const onMove = (event: MouseEvent) => {
      const dx = (event.clientX - imageCropDragging.startX) / Math.max(1, node.width);
      const dy = (event.clientY - imageCropDragging.startY) / Math.max(1, node.height);
      const initial = imageCropDragging.initial;
      const aspect = imageCropDragging.aspect;
      if (imageCropDragging.type === "move") {
        setActiveImageCrop(clampImageCropDraft({ ...initial, x: initial.x + dx, y: initial.y + dy }));
        return;
      }
      if (imageCropDragging.type === "right") {
        const nextWidth = initial.width + dx;
        if (aspect) {
          setActiveImageCrop(clampImageCropDraft({ ...initial, width: nextWidth, height: nextWidth / aspect }));
        } else {
          setActiveImageCrop(clampImageCropDraft({ ...initial, width: nextWidth }));
        }
        return;
      }
      if (imageCropDragging.type === "left") {
        const nextX = initial.x + dx;
        const nextWidth = initial.width - dx;
        if (aspect) {
          const nextHeight = nextWidth / aspect;
          setActiveImageCrop(clampImageCropDraft({ ...initial, x: nextX, width: nextWidth, height: nextHeight }));
        } else {
          setActiveImageCrop(clampImageCropDraft({ ...initial, x: nextX, width: nextWidth }));
        }
        return;
      }
      if (imageCropDragging.type === "top") {
        const nextY = initial.y + dy;
        const nextHeight = initial.height - dy;
        if (aspect) {
          const nextWidth = nextHeight * aspect;
          setActiveImageCrop(clampImageCropDraft({ ...initial, y: nextY, height: nextHeight, width: nextWidth }));
        } else {
          setActiveImageCrop(clampImageCropDraft({ ...initial, y: nextY, height: nextHeight }));
        }
        return;
      }
      if (imageCropDragging.type === "bottom") {
        const nextHeight = initial.height + dy;
        if (aspect) {
          setActiveImageCrop(clampImageCropDraft({ ...initial, height: nextHeight, width: nextHeight * aspect }));
        } else {
          setActiveImageCrop(clampImageCropDraft({ ...initial, height: nextHeight }));
        }
        return;
      }
      const nextWidth = Math.max(0.08, initial.width + dx);
      const nextHeight = aspect ? nextWidth / Math.max(0.1, aspect) : Math.max(0.08, initial.height + dy);
      setActiveImageCrop(clampImageCropDraft({ ...initial, width: nextWidth, height: nextHeight }));
    };
    const onUp = () => setImageCropDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

  }, dependencies);
}

interface UseCanvasVideoTrimPreviewContext {
  activeVideoEditor: { nodeId: string; mode: "trim" | "erase-subtitle" | "erase-region"; } | null;
  videoTrimDraft: VideoTrimDraft | null;
  nodeVideoRefs: RefObject<Record<string, HTMLVideoElement | null>>;
}

export function useCanvasVideoTrimPreview(readContext: () => UseCanvasVideoTrimPreviewContext, dependencies: DependencyList) {
  useEffect(() => {
    const { activeVideoEditor, videoTrimDraft, nodeVideoRefs } = readContext();

    if (!activeVideoEditor || activeVideoEditor.mode !== "trim" || !videoTrimDraft) return;
    const video = nodeVideoRefs.current[activeVideoEditor.nodeId];
    if (!video) return;
    if (video.currentTime < videoTrimDraft.start || video.currentTime > videoTrimDraft.end) {
      video.currentTime = videoTrimDraft.start;
    }

  }, dependencies);
}
