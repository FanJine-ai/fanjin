import { Music4, Scissors } from "lucide-react";
import type { NodeData } from "./canvasDataTypes";
import { renderCanvasNodeGlyph as renderGlyph } from "./canvasNodeGlyph";
import { renderVirtualizedNodePlaceholder as renderPlaceholder } from "./canvasVirtualizedNodePlaceholder";

export function renderCanvasNodeGlyph(type: NodeData["type"], variant: "node" | "header" = "node") {
  return renderGlyph(type, variant, Music4, Scissors);
}

export function renderVirtualizedNodePlaceholder(node: NodeData) {
  return renderPlaceholder(node, (type) => renderCanvasNodeGlyph(type as NodeData["type"]));
}
