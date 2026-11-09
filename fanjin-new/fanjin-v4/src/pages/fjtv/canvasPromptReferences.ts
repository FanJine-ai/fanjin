import type { PromptReferenceRange, PromptSegment } from "./canvasDataTypes";

export function splitPromptSegments(prompt: string) {
  const segments: PromptSegment[] = [];
  const regex = /\[@([^\]]+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt))) {
    if (match.index > lastIndex) segments.push({ type: "text", value: prompt.slice(lastIndex, match.index) });
    segments.push({ type: "reference", value: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < prompt.length) segments.push({ type: "text", value: prompt.slice(lastIndex) });
  return segments;
}

export function getPromptReferenceRanges(prompt: string): PromptReferenceRange[] {
  const ranges: PromptReferenceRange[] = [];
  const regex = /\[@([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt))) ranges.push({ label: match[1], start: match.index, end: match.index + match[0].length });
  return ranges;
}

export function findPromptReferenceRangeAt(prompt: string, index: number) {
  return getPromptReferenceRanges(prompt).find((range) => index > range.start && index < range.end) ?? null;
}

export function snapPromptCaretToReferenceBoundary(range: PromptReferenceRange, index: number) {
  const midpoint = range.start + (range.end - range.start) / 2;
  return index <= midpoint ? range.start : range.end;
}
