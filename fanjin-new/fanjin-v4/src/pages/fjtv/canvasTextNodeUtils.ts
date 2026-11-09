import type { TextNodeHeading, TextNodeListStyle } from "./canvasDataTypes";

export function getTextNodeBackground(color: string | undefined, mode: "light" | "dark") {
  return color || (mode === "light" ? "#f8fafc" : "#151515");
}

export function getTextNodeFontSize(size: number | undefined, heading: TextNodeHeading | undefined) {
  if (typeof size === "number") return size;
  if (heading === "h1") return 42;
  if (heading === "h2") return 34;
  if (heading === "h3") return 28;
  return 22;
}

export function getTextNodeLineHeight(size: number | undefined, heading: TextNodeHeading | undefined) {
  if (typeof size === "number" && size <= 16) return 1.38;
  return heading === "h1" ? 1.28 : heading === "h2" ? 1.35 : 1.5;
}

function stripTextListPrefix(line: string) {
  return line.replace(/^\s*(?:[•*-]\s+|\d+[.)]\s+)/, "");
}

export function applyTextListStyle(value: string, style: TextNodeListStyle) {
  const lines = String(value || "").split("\n");
  if (style === "none") return lines.map(stripTextListPrefix).join("\n");
  let index = 1;
  return lines.map((line) => {
    const content = stripTextListPrefix(line);
    if (!content.trim()) return "";
    if (style === "bullet") return `• ${content}`;
    return `${index++}. ${content}`;
  }).join("\n");
}
