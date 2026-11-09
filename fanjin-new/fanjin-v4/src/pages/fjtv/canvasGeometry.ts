export interface CanvasRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CanvasAlignmentGuides {
  vertical?: number;
  horizontal?: number;
  snapDx: number;
  snapDy: number;
}

type PositionedCanvasNode = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type CanvasNodeGroup = { id: string; nodeIds: string[] };

export function rectFromNode(node: PositionedCanvasNode): CanvasRect {
  return { left: node.x, top: node.y, right: node.x + node.width, bottom: node.y + node.height };
}

export function unionRects(rects: CanvasRect[]) {
  if (rects.length === 0) return null;
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  } as CanvasRect;
}

export function rectIntersects(a: CanvasRect, b: CanvasRect) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

export function rectContainsRect(outer: CanvasRect, inner: CanvasRect) {
  return inner.left >= outer.left
    && inner.right <= outer.right
    && inner.top >= outer.top
    && inner.bottom <= outer.bottom;
}

export function rectSelectsNode(selectionRect: CanvasRect, nodeRect: CanvasRect) {
  return rectContainsRect(selectionRect, nodeRect);
}

export function bezierControl(x1: number, y1: number, x2: number, y2: number) {
  const d = Math.max(70, Math.abs(x2 - x1) * 0.42);
  return {
    p0: { x: x1, y: y1 },
    p1: { x: x1 + d, y: y1 },
    p2: { x: x2 - d, y: y2 },
    p3: { x: x2, y: y2 },
  };
}

export function bezierPath(x1: number, y1: number, x2: number, y2: number) {
  const { p0, p1, p2, p3 } = bezierControl(x1, y1, x2, y2);
  return `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
}

export function bezierPoint(
  t: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
  };
}

export function collectGroupBounds(
  groups: CanvasNodeGroup[],
  nodes: PositionedCanvasNode[],
  padding = 34,
) {
  return groups
    .map((group) => {
      const members = nodes.filter((node) => group.nodeIds.includes(node.id));
      if (members.length === 0) return null;
      const left = Math.min(...members.map((node) => node.x));
      const top = Math.min(...members.map((node) => node.y));
      const right = Math.max(...members.map((node) => node.x + node.width));
      const bottom = Math.max(...members.map((node) => node.y + node.height));
      return {
        groupId: group.id,
        rect: {
          left: left - padding,
          top: top - padding,
          right: right + padding,
          bottom: bottom + padding,
        },
      };
    })
    .filter((item): item is { groupId: string; rect: CanvasRect } => Boolean(item));
}

export function findGroupByNode<T extends CanvasNodeGroup>(groups: T[], nodeId: string): T | null {
  return groups.find((group) => group.nodeIds.includes(nodeId)) ?? null;
}

export function alignmentForRect(
  moving: CanvasRect,
  candidates: CanvasRect[],
  threshold: number,
): CanvasAlignmentGuides {
  let bestVX: number | undefined;
  let bestVDelta: number | undefined;
  let bestHY: number | undefined;
  let bestHDelta: number | undefined;
  const movingX = [moving.left, moving.right];
  const movingY = [moving.top, moving.bottom];

  candidates.forEach((candidate) => {
    const candidateX = [candidate.left, candidate.right];
    const candidateY = [candidate.top, candidate.bottom];
    movingX.forEach((movingValue) => {
      candidateX.forEach((candidateValue) => {
        const delta = candidateValue - movingValue;
        if (Math.abs(delta) <= threshold && (bestVDelta === undefined || Math.abs(delta) < Math.abs(bestVDelta))) {
          bestVDelta = delta;
          bestVX = candidateValue;
        }
      });
    });
    movingY.forEach((movingValue) => {
      candidateY.forEach((candidateValue) => {
        const delta = candidateValue - movingValue;
        if (Math.abs(delta) <= threshold && (bestHDelta === undefined || Math.abs(delta) < Math.abs(bestHDelta))) {
          bestHDelta = delta;
          bestHY = candidateValue;
        }
      });
    });
  });
  return {
    vertical: bestVX,
    horizontal: bestHY,
    snapDx: bestVDelta ?? 0,
    snapDy: bestHDelta ?? 0,
  };
}
