
import type { Side, NodeData, EdgeData, DraftLine, EdgeHoverState } from "./canvasDataTypes";
import { bezierPath, type CanvasAlignmentGuides as AlignmentGuides } from "./canvasGeometry";

export interface CanvasEdgeLayerDependencies {
  visibleEdges: EdgeData[];
  nodeMap: Map<string, NodeData>;
  nodeSocket: (node: NodeData, side: Side) => { x: number; y: number; };
  edgeHoverState: EdgeHoverState | null;
  selectedEdgeIds: string[];
  animatedEdgeIds: Set<string>;
  NODE_SELECTION_BORDER: "#d0d0d2";
  draftLine: DraftLine | null;
  alignmentGuides: AlignmentGuides | null;
}

export function createCanvasEdgeLayer(deps: CanvasEdgeLayerDependencies) {
  const {
    visibleEdges,
    nodeMap,
    nodeSocket,
    edgeHoverState,
    selectedEdgeIds,
    animatedEdgeIds,
    NODE_SELECTION_BORDER,
    draftLine,
    alignmentGuides,
  } = deps;
  function renderCanvasEdgeLayer() { return (<svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          <defs>
            <filter id="canvas-edge-flow-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="3.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {visibleEdges.map((edge) => {
            const fromNode = nodeMap.get(edge.fromNodeId);
            const toNode = nodeMap.get(edge.toNodeId);
            if (!fromNode || !toNode) return null;
            const from = nodeSocket(fromNode, edge.fromSide);
            const to = nodeSocket(toNode, edge.toSide);
            const hovered = edgeHoverState?.edgeId === edge.id;
            const selected = selectedEdgeIds.includes(edge.id);
            const animated = animatedEdgeIds.has(edge.id);
            const pathD = bezierPath(from.x, from.y, to.x, to.y);
            return (
              <g
                key={edge.id}
                data-canvas-edge
                data-edge-id={edge.id}
                data-edge-from-node-id={edge.fromNodeId}
                data-edge-to-node-id={edge.toNodeId}
                data-edge-from-side={edge.fromSide}
                data-edge-to-side={edge.toSide}
              >
                <path d={pathD} stroke={selected ? NODE_SELECTION_BORDER : hovered ? "#d3dbe6" : animated ? "rgba(126, 211, 255, 0.64)" : "#838c98"} strokeWidth={selected ? 3 : hovered ? 3 : animated ? 2.2 : 2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                {animated ? (
                  <g filter="url(#canvas-edge-flow-glow)" style={{ animation: "canvas-edge-comet-breathe 1.8s ease-in-out infinite" }}>
                    {[0, -0.78, -1.56].flatMap((trailOffset, trailIndex) =>
                      [
                        { r: 5.8, opacity: 0.98, begin: -0.24 + trailOffset },
                        { r: 4.4, opacity: 0.78, begin: -0.18 + trailOffset },
                        { r: 3.2, opacity: 0.58, begin: -0.12 + trailOffset },
                        { r: 2.2, opacity: 0.38, begin: -0.06 + trailOffset },
                        { r: 1.4, opacity: 0.24, begin: 0 + trailOffset },
                      ].map((dot, index) => ({ ...dot, key: `${trailIndex}-${index}` })),
                    ).map((dot) => (
                      <circle key={dot.key} r={dot.r} fill="#78dcff" opacity={dot.opacity}>
                        <animateMotion dur="2.35s" repeatCount="indefinite" path={pathD} begin={`${dot.begin}s`} rotate="auto" />
                      </circle>
                    ))}
                  </g>
                ) : null}
              </g>
            );
          })}
          {draftLine ? <path d={bezierPath(draftLine.fromX, draftLine.fromY, draftLine.toX, draftLine.toY)} stroke="#95a0b1" strokeWidth={2} fill="none" /> : null}
          {alignmentGuides?.vertical !== undefined ? (
            <line x1={alignmentGuides.vertical} y1={-100000} x2={alignmentGuides.vertical} y2={100000} stroke="#2f80ff" strokeWidth={1.2} strokeDasharray="8 8" opacity={0.95} />
          ) : null}
          {alignmentGuides?.horizontal !== undefined ? (
            <line x1={-100000} y1={alignmentGuides.horizontal} x2={100000} y2={alignmentGuides.horizontal} stroke="#2f80ff" strokeWidth={1.2} strokeDasharray="8 8" opacity={0.95} />
          ) : null}
        </svg>); }
  return renderCanvasEdgeLayer;
}
