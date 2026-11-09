import { useMemo } from "react";
import {
type ComposeClip
} from "./canvasComposeTimeline";
interface Context {
  composeClips: ComposeClip[];
  composeCurrentTime: number;
  composeSelectedClipId: string | null;
}
export function useCanvasComposeView({ composeClips, composeCurrentTime, composeSelectedClipId }: Context) {
  const composeTotalDuration = useMemo(() => composeClips.reduce((sum, clip) => sum + clip.duration, 0), [composeClips]);

  const composeActiveClip = useMemo(() => {
    if (composeClips.length === 0) return null;
    return (
      composeClips.find((clip) => composeCurrentTime >= clip.startAt && composeCurrentTime < clip.endAt) ??
      composeClips[composeClips.length - 1]
    );
  }, [composeClips, composeCurrentTime]);

  const composeSelectedClip = useMemo(
    () => composeClips.find((clip) => clip.id === composeSelectedClipId) ?? composeActiveClip ?? null,
    [composeActiveClip, composeClips, composeSelectedClipId],
  );

  const composeCanCrop = useMemo(() => {
    if (!composeSelectedClip) return false;
    return composeCurrentTime >= composeSelectedClip.startAt && composeCurrentTime <= composeSelectedClip.endAt;
  }, [composeCurrentTime, composeSelectedClip]);

  return { composeTotalDuration, composeActiveClip, composeSelectedClip, composeCanCrop };
}
