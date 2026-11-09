import { ApiError } from "@/lib/api";
import type { NodeData, CanvasConflictState } from "./canvasDataTypes";
import type { NodeType } from "./canvasMediaTypes";
import { NODE_WIDTH, mediaToNodeDimensions, nearestRatio } from "./canvasMediaGeometry";
import { sanitizeLegacyDemoNode, getNodeImageDisplayUrl } from "./canvasAssetPresentation";

type LegacyCanvasNodeFactory = (id: string, type: NodeType, x: number, y: number) => NodeData;

export function positiveCanvasRevision(value: unknown): number | null {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

export function positiveCanvasProjectId(value: unknown): string | null {
  const projectId = Number(value);
  return Number.isSafeInteger(projectId) && projectId > 0 ? String(projectId) : null;
}

export function canvasConflictFromError(error: unknown): CanvasConflictState | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = error.details && typeof error.details === "object"
    ? error.details as { data?: { expectedRevision?: unknown; currentRevision?: unknown } }
    : {};
  return {
    message: error.message || "画布已被其他操作更新",
    expectedRevision: positiveCanvasRevision(details.data?.expectedRevision),
    currentRevision: positiveCanvasRevision(details.data?.currentRevision),
  };
}

export function defaultNodeTitle(type: NodeType, index: number) {
  if (type === "video") return `视频节点${index}`;
  if (type === "text") return `文本节点${index}`;
  if (type === "audio") return `音频节点${index}`;
  if (type === "compose") return `视频合成 ${index}`;
  if (type === "script") return `爆款视频拆解${index}`;
  return `图片节点${index}`;
}

export function repairLegacyMojibakeText(input: string) {
  let text = String(input || "");
  const replacements: Array<[string, string]> = [
    ["鍥剧墖", "图片"],
    ["瑙嗛", "视频"],
    ["鏂囨湰", "文本"],
    ["闊抽", "音频"],
    ["鍚堟垚", "合成"],
    ["鑺傜偣", "节点"],
    ["鍓湰", "副本"],
    ["棣栧抚", "首帧"],
    ["涓婁紶", "上传"],
  ];
  replacements.forEach(([from, to]) => {
    if (text.includes(from)) text = text.split(from).join(to);
  });
  return text;
}

export function repairLegacyNodeTitle(title: string, type: NodeType) {
  const normalized = repairLegacyMojibakeText(String(title || ""));
  const suffixMatch = normalized.match(/(\d+)\s*$/);
  const suffix = suffixMatch ? suffixMatch[1] : "";
  if (normalized.includes("图片节点")) return `图片节点${suffix}`;
  if (normalized.includes("视频节点")) return `视频节点${suffix}`;
  if (normalized.includes("文本节点")) return `文本节点${suffix}`;
  if (normalized.includes("音频节点")) return `音频节点${suffix}`;
  if (normalized.includes("视频合成")) return `视频合成 ${suffix || "1"}`;
  if (normalized.includes("爆款视频拆解")) return `爆款视频拆解${suffix || "1"}`;
  if (normalized.includes("副本")) return normalized;
  if (!normalized.trim()) return defaultNodeTitle(type, suffix ? Number(suffix) : 1);
  return normalized;
}

export function repairLegacyNodes(rawNodes: any[], createNode: LegacyCanvasNodeFactory) {
  return rawNodes.map((node, index) => {
    const safeNode = sanitizeLegacyDemoNode(node);
    const type = (safeNode?.type || "image") as NodeType;
    const nodeId = String(safeNode?.id || `legacy-node-${index + 1}`);
    const defaults = createNode(nodeId, type, index * 48, index * 48);
    const normalized = {
      ...defaults,
      ...safeNode,
      id: nodeId,
      type,
      title: repairLegacyNodeTitle(String(safeNode?.title || ""), type),
      titleCustomized: typeof safeNode?.titleCustomized === "boolean" ? safeNode.titleCustomized : false,
      prompt: typeof safeNode?.prompt === "string" ? safeNode.prompt : "",
      x: Number.isFinite(Number(safeNode?.x)) ? Number(safeNode.x) : defaults.x,
      y: Number.isFinite(Number(safeNode?.y)) ? Number(safeNode.y) : defaults.y,
      width: Number.isFinite(Number(safeNode?.width)) && Number(safeNode.width) > 0
        ? Number(safeNode.width)
        : defaults.width,
      height: Number.isFinite(Number(safeNode?.height)) && Number(safeNode.height) > 0
        ? Number(safeNode.height)
        : defaults.height,
    } as NodeData;
    if (type === "image") {
      const recoveredImageUrl = getNodeImageDisplayUrl(normalized);
      if (recoveredImageUrl && !normalized.imageUrl && !normalized.localPreviewUrl) {
        normalized.imageUrl = recoveredImageUrl;
      }
      if (recoveredImageUrl && !normalized.primaryImageUrl) {
        normalized.primaryImageUrl = recoveredImageUrl;
      }
    }
    if (
      (type === "image" || type === "video") &&
      !(Number(safeNode?.width) > 0 && Number(safeNode?.height) > 0) &&
      Number(normalized.mediaNaturalWidth) > 0 &&
      Number(normalized.mediaNaturalHeight) > 0
    ) {
      const nextDims = mediaToNodeDimensions(Number(normalized.mediaNaturalWidth), Number(normalized.mediaNaturalHeight));
      const centerX = Number(normalized.x || 0) + Number(normalized.width || NODE_WIDTH) / 2;
      const centerY = Number(normalized.y || 0) + Number(normalized.height || NODE_WIDTH) / 2;
      normalized.ratio = nearestRatio(Number(normalized.mediaNaturalWidth), Number(normalized.mediaNaturalHeight));
      normalized.width = nextDims.width;
      normalized.height = nextDims.height;
      normalized.x = centerX - nextDims.width / 2;
      normalized.y = centerY - nextDims.height / 2;
    }
    return normalized;
  });
}
