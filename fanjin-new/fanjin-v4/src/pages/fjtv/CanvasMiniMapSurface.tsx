import type { Ref } from "react";
import type { NodeData, GroupData } from "./canvasDataTypes";
import { rectFromNode, type CanvasRect } from "./canvasGeometry";
import type { MiniMapMetrics, MiniMapRectLike } from "./miniMapMetrics";

export interface CanvasMiniMapSurfaceProps {
  className: string;
  canvasColorMode: "light" | "dark";
  miniMapSurfaceRef: Ref<HTMLDivElement>;
  readMiniMapSurfaceBox: () => MiniMapRectLike | null;
  setMiniMapDragging: (dragging: boolean) => void;
  updateViewportFromMiniMap: (clientX: number, clientY: number, box: MiniMapRectLike) => void;
  miniMapDragging: boolean;
  returnToCanvasContent: () => void;
  miniMapPreview: MiniMapMetrics | null;
  groupBoundsMap: Map<string, CanvasRect>;
  groups: GroupData[];
  nodes: NodeData[];
  selectedNodeIds: string[];
  miniMapViewportRect: MiniMapRectLike | null;
}

export function CanvasMiniMapSurface({
  className,
  canvasColorMode,
  miniMapSurfaceRef,
  readMiniMapSurfaceBox,
  setMiniMapDragging,
  updateViewportFromMiniMap,
  miniMapDragging,
  returnToCanvasContent,
  miniMapPreview,
  groupBoundsMap,
  groups,
  nodes,
  selectedNodeIds,
  miniMapViewportRect,
}: CanvasMiniMapSurfaceProps) {

    // The studio rail overrides the surface to a light background in light
    // theme, so every projected element must switch palette with the canvas
    // theme — the old hard-coded white-on-dark colors composited to the same
    // color as the light surface and made the minimap look empty ("无效").
    const miniMapIsLight = canvasColorMode === "light";
    const dotColor = miniMapIsLight ? "rgba(15,23,42,0.10)" : "rgba(255,255,255,0.055)";
    const groupBorderColor = miniMapIsLight ? "rgba(15,23,42,0.18)" : "rgba(255,255,255,0.10)";
    const groupFallbackFill = miniMapIsLight ? "rgba(15,23,42,0.07)" : "rgba(255,255,255,0.055)";
    const nodeFill = (node: NodeData) => {
      if (miniMapIsLight) {
        return node.type === "video"
          ? "rgba(37,99,235,0.80)"
          : node.type === "image"
            ? "rgba(71,85,105,0.85)"
            : node.type === "audio"
              ? "rgba(5,150,105,0.80)"
              : "rgba(100,116,139,0.85)";
      }
      return node.type === "video"
        ? "rgba(130,180,255,0.62)"
        : node.type === "image"
          ? "rgba(210,214,220,0.72)"
          : node.type === "audio"
            ? "rgba(120,220,185,0.58)"
            : "rgba(170,170,176,0.58)";
    };
    const selectedOutline = miniMapIsLight ? "0 0 0 1.5px rgba(14,109,148,0.95)" : "0 0 0 1px rgba(255,255,255,0.85)";
    return (
      <div
        ref={miniMapSurfaceRef}
        role="button"
        tabIndex={0}
        data-minimap-surface
        className={`relative cursor-crosshair overflow-hidden bg-[#242424] ${className}`}
        style={{ backgroundColor: `var(--studio-muted-bg, ${miniMapIsLight ? "#f2f5f8" : "#242424"})` }}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const box = readMiniMapSurfaceBox();
          if (!box) return;
          setMiniMapDragging(true);
          updateViewportFromMiniMap(event.clientX, event.clientY, box);
        }}
        onMouseMove={(event) => {
          if (!miniMapDragging) return;
          const box = readMiniMapSurfaceBox();
          if (!box) return;
          updateViewportFromMiniMap(event.clientX, event.clientY, box);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          returnToCanvasContent();
        }}
        aria-label="看板缩略图，按回车适应全部内容"
      >
        <div
          className="absolute inset-0 opacity-70"
          style={{ backgroundImage: `radial-gradient(circle at center, ${dotColor} 0, transparent 1px)`, backgroundSize: "12px 12px" }}
        />
        {miniMapPreview ? (
          <>
            {Array.from(groupBoundsMap.entries()).map(([groupId, bounds]) => {
              const rect = miniMapPreview.toMiniRect(bounds);
              const group = groups.find((item) => item.id === groupId);
              return (
                <div
                  key={groupId}
                  data-minimap-group={groupId}
                  className="absolute rounded-[3px] border"
                  style={{
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    borderColor: groupBorderColor,
                    backgroundColor: group?.themeColor ? String(group.themeColor) + "33" : groupFallbackFill,
                  }}
                />
              );
            })}
            {nodes.map((node) => {
              const rect = miniMapPreview.toMiniRect(rectFromNode(node));
              return (
                <div
                  key={node.id}
                  data-minimap-node={node.id}
                  className="absolute rounded-[1.5px]"
                  style={{
                    left: rect.left,
                    top: rect.top,
                    width: Math.max(3, rect.width),
                    height: Math.max(3, rect.height),
                    backgroundColor: nodeFill(node),
                    boxShadow: selectedNodeIds.includes(node.id) ? selectedOutline : undefined,
                  }}
                />
              );
            })}
            {miniMapViewportRect ? (
              <div
                data-minimap-viewport
                className="absolute rounded-[2px] border"
                style={{
                  left: miniMapViewportRect.left,
                  top: miniMapViewportRect.top,
                  width: Math.max(22, miniMapViewportRect.width),
                  height: Math.max(16, miniMapViewportRect.height),
                  borderColor: miniMapIsLight ? "rgba(14,109,148,0.9)" : "rgba(255,255,255,0.7)",
                  backgroundColor: miniMapIsLight ? "rgba(14,109,148,0.07)" : "rgba(255,255,255,0.05)",
                  boxShadow: miniMapIsLight
                    ? "0 0 0 1px rgba(255,255,255,0.55), 0 0 18px rgba(14,109,148,0.18)"
                    : "0 0 0 1px rgba(0,0,0,0.45), 0 0 18px rgba(255,255,255,0.08)",
                }}
              />
            ) : null}
          </>
        ) : null}
      </div>
    );
  }
