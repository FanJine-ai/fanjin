export function buildCanvasFrameDashStyle(strokeWidth: number, dash: number, gap: number) {
  return {
    border: "none",
    backgroundImage: [
      `repeating-linear-gradient(90deg, rgba(255,255,255,0.48) 0 ${dash}px, transparent ${dash}px ${dash + gap}px)`,
      `repeating-linear-gradient(90deg, rgba(255,255,255,0.48) 0 ${dash}px, transparent ${dash}px ${dash + gap}px)`,
      `repeating-linear-gradient(180deg, rgba(255,255,255,0.48) 0 ${dash}px, transparent ${dash}px ${dash + gap}px)`,
      `repeating-linear-gradient(180deg, rgba(255,255,255,0.48) 0 ${dash}px, transparent ${dash}px ${dash + gap}px)`,
    ].join(","),
    backgroundPosition: "left top, left bottom, left top, right top",
    backgroundRepeat: "repeat-x, repeat-x, repeat-y, repeat-y",
    backgroundSize: `auto ${strokeWidth}px, auto ${strokeWidth}px, ${strokeWidth}px auto, ${strokeWidth}px auto`,
    filter: "none",
  } as const;
}

export function buildCanvasDotBackgroundStyle(mode: "light" | "dark", panX: number, panY: number, spacing: number, radius: number) {
  return {
    backgroundImage: `radial-gradient(circle, var(--studio-grid-dot, ${mode === "light" ? "#d7dce5" : "#313131"}) ${radius}px, transparent ${radius + 0.12}px)`,
    backgroundPosition: `${panX}px ${panY}px`,
    backgroundSize: `${spacing}px ${spacing}px`,
  } as const;
}
