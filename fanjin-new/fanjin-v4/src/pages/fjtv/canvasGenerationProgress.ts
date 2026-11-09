import { isPreparingGeneration } from "../../features/quick-create/generationPreparation";
import type { NodeData } from "./canvasDataTypes";

type GenerationProgressNode = { generationState?: string; reportedGenerationProgress?: number };

export function preserveActiveGenerationState<T extends object>(patch: T): Partial<T> {
  const result: Partial<T> = { ...patch };
  for (const field of ["isGenerating", "generationState", "taskStatus", "taskId", "generationProgress", "reportedGenerationProgress"]) delete (result as Record<string, unknown>)[field];
  return result;
}

export function advanceReportedGenerationProgress(previous: number | undefined, incoming: unknown) {
  const value = Number(incoming);
  if (!Number.isFinite(value) || value <= 0) return previous;
  const percent = Math.max(1, Math.min(99, Math.round(value < 1 ? value * 100 : value)));
  return Math.max(previous || 0, percent);
}

export function canvasGenerationProgressLabel(node: GenerationProgressNode) {
  if (typeof node.reportedGenerationProgress === "number" && node.reportedGenerationProgress > 0) return `生成中 ${Math.min(99, Math.round(node.reportedGenerationProgress))}%...`;
  return node.generationState === "submitting" ? "正在提交..." : "生成中...";
}

export function resolvePendingGenerationProgress(node: NodeData, startedAt: Record<string, number>): number | undefined {
  if (!startedAt[node.id]) startedAt[node.id] = Date.now();
  if (isPreparingGeneration(node)) return undefined;
  return node.reportedGenerationProgress;
}

export function pendingElapsedLabel(nodeId: string, startedAt: Record<string, number>): string {
  const started = startedAt[nodeId];
  if (!started) return "进行中";
  const sec = Math.max(0, Math.floor((Date.now() - started) / 1000));
  return sec < 60 ? `已等待 ${sec} 秒` : `已等待 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}
