export function toggleAudioNodePlaybackExternal(nodeId: string, nodeAudioRefs: Record<string, HTMLAudioElement | null>) {
  const audio = nodeAudioRefs[nodeId];
  if (!audio) return;
  if (audio.paused) void audio.play().catch(() => undefined);
  else audio.pause();
}
