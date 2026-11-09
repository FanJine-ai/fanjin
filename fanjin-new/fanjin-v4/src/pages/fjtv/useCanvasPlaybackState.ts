import { useState } from "react";

export function useCanvasPlaybackState() {
  const [videoNodeDurations, setVideoNodeDurations] = useState<Record<string, number>>({});
  const [videoNodeCurrentTimes, setVideoNodeCurrentTimes] = useState<Record<string, number>>({});
  const [videoNodePlaying, setVideoNodePlaying] = useState<Record<string, boolean>>({});
  const [videoNodeMuted, setVideoNodeMuted] = useState<Record<string, boolean>>({});
  const [audioNodeDurations, setAudioNodeDurations] = useState<Record<string, number>>({});
  const [audioNodeCurrentTimes, setAudioNodeCurrentTimes] = useState<Record<string, number>>({});
  const [audioNodePlaying, setAudioNodePlaying] = useState<Record<string, boolean>>({});
  return {
    videoNodeDurations, setVideoNodeDurations,
    videoNodeCurrentTimes, setVideoNodeCurrentTimes,
    videoNodePlaying, setVideoNodePlaying,
    videoNodeMuted, setVideoNodeMuted,
    audioNodeDurations, setAudioNodeDurations,
    audioNodeCurrentTimes, setAudioNodeCurrentTimes,
    audioNodePlaying, setAudioNodePlaying,
  };
}
