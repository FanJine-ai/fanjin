import { useEffect, type DependencyList, type Dispatch, type SetStateAction, type RefObject, type ReactNode, type JSX } from "react";
import { getComposeClipLocalTime, type ComposeClip } from "./canvasComposeTimeline";

interface UseCanvasComposePreviewSyncContext {
  composePreviewRef: RefObject<HTMLVideoElement | null>;
  composeActiveClip: ComposeClip | null;
  composeCurrentTime: number;
  composeMuted: boolean;
  composePlaying: boolean;
}

export function useCanvasComposePreviewSync(readContext: () => UseCanvasComposePreviewSyncContext, dependencies: DependencyList) {
  useEffect(() => {
    const { composePreviewRef, composeActiveClip, composeCurrentTime, composeMuted, composePlaying } = readContext();

    const preview = composePreviewRef.current;
    if (!preview || !composeActiveClip) return;
    const localTime = getComposeClipLocalTime(composeActiveClip, composeCurrentTime);
    preview.muted = composeMuted;
    preview.playbackRate = composeActiveClip.speed;
    if (preview.src !== composeActiveClip.url) {
      preview.src = composeActiveClip.url;
      preview.load();
      preview.onloadedmetadata = () => {
        preview.currentTime = Math.min(Math.max(composeActiveClip.trimStart, localTime), Math.max(composeActiveClip.trimStart, composeActiveClip.trimEnd - 0.02));
        if (composePlaying) void preview.play().catch(() => undefined);
      };
    } else if (Math.abs(preview.currentTime - localTime) > 0.2) {
      preview.currentTime = Math.min(Math.max(composeActiveClip.trimStart, localTime), Math.max(composeActiveClip.trimStart, composeActiveClip.trimEnd - 0.02));
    }
    if (composePlaying) {
      void preview.play().catch(() => undefined);
    } else {
      preview.pause();
    }

  }, dependencies);
}

interface UseCanvasComposePlaybackEventsContext {
  composePreviewRef: RefObject<HTMLVideoElement | null>;
  composeActiveClip: ComposeClip | null;
  composeClips: ComposeClip[];
  setComposePlaying: Dispatch<SetStateAction<boolean>>;
  setComposeCurrentTime: Dispatch<SetStateAction<number>>;
  composeTotalDuration: number;
}

export function useCanvasComposePlaybackEvents(readContext: () => UseCanvasComposePlaybackEventsContext, dependencies: DependencyList) {
  useEffect(() => {
    const { composePreviewRef, composeActiveClip, composeClips, setComposePlaying, setComposeCurrentTime, composeTotalDuration } = readContext();

    const preview = composePreviewRef.current;
    if (!preview) return;
    const onTimeUpdate = () => {
      if (!composeActiveClip) return;
      if (preview.currentTime >= composeActiveClip.trimEnd - 0.02) {
        const nextIndex = composeClips.findIndex((clip) => clip.id === composeActiveClip.id) + 1;
        if (nextIndex <= 0 || nextIndex >= composeClips.length) {
          setComposePlaying(false);
          setComposeCurrentTime(composeTotalDuration);
          preview.pause();
          return;
        }
        const nextClip = composeClips[nextIndex];
        setComposeCurrentTime(nextClip.startAt);
        return;
      }
      setComposeCurrentTime(
        Math.min(composeTotalDuration, composeActiveClip.startAt + Math.max(0, (preview.currentTime - composeActiveClip.trimStart) / Math.max(0.25, composeActiveClip.speed))),
      );
    };
    const onEnded = () => {
      if (!composeActiveClip) return;
      const nextIndex = composeClips.findIndex((clip) => clip.id === composeActiveClip.id) + 1;
      if (nextIndex <= 0 || nextIndex >= composeClips.length) {
        setComposePlaying(false);
        setComposeCurrentTime(composeTotalDuration);
        return;
      }
      const nextClip = composeClips[nextIndex];
      setComposeCurrentTime(nextClip.startAt);
    };
    preview.addEventListener("timeupdate", onTimeUpdate);
    preview.addEventListener("ended", onEnded);
    return () => {
      preview.removeEventListener("timeupdate", onTimeUpdate);
      preview.removeEventListener("ended", onEnded);
    };

  }, dependencies);
}

interface UseCanvasComposeFullscreenContext {
  setComposePreviewFullscreen: Dispatch<SetStateAction<boolean>>;
}

export function useCanvasComposeFullscreen(readContext: () => UseCanvasComposeFullscreenContext, dependencies: DependencyList) {
  useEffect(() => {
    const { setComposePreviewFullscreen } = readContext();

    const onFullScreenChange = () => {
      setComposePreviewFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullScreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullScreenChange);

  }, dependencies);
}

interface UseCanvasComposeTimelineDragContext {
  composeTimelineDragging: boolean;
  composeTimelineRef: RefObject<HTMLDivElement | null>;
  seekComposeTime: (nextTime: number) => void;
  composeTotalDuration: number;
  setComposeTimelineDragging: Dispatch<SetStateAction<boolean>>;
}

export function useCanvasComposeTimelineDrag(readContext: () => UseCanvasComposeTimelineDragContext, dependencies: DependencyList) {
  useEffect(() => {
    const { composeTimelineDragging, composeTimelineRef, seekComposeTime, composeTotalDuration, setComposeTimelineDragging } = readContext();

    if (!composeTimelineDragging) return;
    const onMove = (event: MouseEvent) => {
      const track = composeTimelineRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      seekComposeTime(ratio * composeTotalDuration);
    };
    const onUp = () => setComposeTimelineDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

  }, dependencies);
}
