import type { AiModelOption } from "@/lib/api";
export function supportsCanvasVideoDraft(model?: AiModelOption | null): boolean {
  const directory = model?.capabilities?.videoGeneration as { draft?: { enabled?: boolean }; dispatchable?: boolean } | undefined;
  return Boolean(model && directory?.dispatchable && directory.draft?.enabled);
}
export function canvasDraftRequest(payload: Record<string, any>) {
  return { projectId: Number(payload.projectId), type: "video" as const, renderMode: "draft" as const,
    modelId: payload.model, prompt: payload.prompt, aspectRatio: payload.ratio, resolution: "480p",
    duration: payload.duration, audio: payload.generateAudio, count: 1, operation: payload.operation || "generate",
    ...(payload.outputFormat ? { outputFormat: payload.outputFormat } : {}),
    mode: payload.mode, ...(payload.source?.assetVersionId ? { sourceAssetVersionId: payload.source.assetVersionId } : {}),
    references: (payload.references || []).map((reference: any) => ({ assetVersionId: reference.assetVersionId, role: reference.role, ...(reference.trim ? { trim: reference.trim } : {}) })) };
}
export function canvasDraftFinalRequest(projectId: number, draftTaskId: string) {
  return { projectId, type: "video" as const, renderMode: "finalize" as const, draftTaskId };
}
export function draftExpiryLabel(expiresAt?: number | null, now = Date.now()) {
  if (!expiresAt) return "正式片资格以服务端检查为准";
  if (now >= expiresAt) return "样片已到期，请重新生成";
  const hours = Math.ceil((expiresAt - now) / 3600000);
  return hours > 24 ? `可转正式片 · 剩余 ${Math.ceil(hours / 24)} 天` : `可转正式片 · 剩余 ${hours} 小时`;
}
