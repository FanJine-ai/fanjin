import { uploadReferenceAttachment } from "../quick-create/attachments/api";
import type { AgentMessageAttachmentInput } from "./types";

/**
 * 输入区附件 → 随 Agent 消息发送的附件引用(REVAMP-PLAN 4.4)。
 * 后端契约(Worker T, routes/agent/threads/[id]/messages.ts):
 * kind 仅 image/file,url 必须是 http(s),assetRef/url 至少其一;
 * 数量上限 图 ≤4 / 文件 ≤2 / 总 ≤6。本地文件经既有资产上传通道
 * (/assets/uploadReference) 换成 assetVersionId 后以 assetRef 上送。
 */
export type AgentComposerAttachment = {
  id?: string;
  name: string;
  previewUrl: string;
  kind: "image" | "video" | "file";
  /** 本地待上传原文件;资产库引用等已持久化的附件没有该字段。 */
  file?: File;
};

export type AgentPersistedReferenceAttachment = {
  id?: string;
  assetVersionId: string;
  name: string;
  kind?: string | null;
  previewUrl?: string | null;
};

export const AGENT_MESSAGE_ATTACHMENT_LIMITS = { image: 4, file: 2 } as const;

export type ResolveAgentMessageAttachmentsResult = {
  attachments: AgentMessageAttachmentInput[];
  /** 因超上限 / 无项目上下文 / 上传失败而未能随消息发送的附件名。 */
  skipped: string[];
  /** Composer 本地附件中已成功转换并进入请求的稳定 ID。 */
  submittedLocalIds: string[];
};

function isPersistentHttpUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && /^https?:\/\/\S+$/i.test(value);
}

export async function resolveAgentMessageAttachments(
  attachments: readonly AgentComposerAttachment[],
  options: {
    projectId: number | null;
    persistedReferences?: readonly AgentPersistedReferenceAttachment[];
    signal?: AbortSignal;
  },
): Promise<ResolveAgentMessageAttachmentsResult> {
  const skipped: string[] = [];
  const submittedLocalIds: string[] = [];
  const counts = { image: 0, file: 0 };
  const candidates: Array<{
    attachment: AgentComposerAttachment;
    persistedAssetRef?: string;
    persistedKind?: string | null;
  }> = [
    ...(options.persistedReferences ?? []).map((reference) => ({
      attachment: {
        id: reference.id,
        name: reference.name,
        previewUrl: reference.previewUrl || "",
        kind: String(reference.kind || "").includes("图片") || String(reference.kind || "").toLowerCase() === "image"
          ? "image" as const
          : "file" as const,
      },
      persistedAssetRef: String(reference.assetVersionId || "").trim(),
      persistedKind: reference.kind,
    })),
    ...attachments.map((attachment) => ({ attachment })),
  ];
  const dedupeKeys = new Set<string>();
  const ready: AgentMessageAttachmentInput[] = [];
  for (const candidate of candidates) {
    const { attachment } = candidate;
    if (options.signal?.aborted) {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      throw abortError;
    }
    const declaredAudio = attachment.file?.type.toLowerCase().startsWith("audio/")
      || String(candidate.persistedKind || "").toLowerCase().includes("audio")
      || String(candidate.persistedKind || "").includes("音频");
    if (declaredAudio) {
      skipped.push(`${attachment.name}(Agent 暂不接收音频附件)`);
      continue;
    }
    // 契约 kind 仅 image/file:video 等一律归入 file。
    const kind = attachment.kind === "image" ? "image" as const : "file" as const;
    const persistedAssetRef = candidate.persistedAssetRef?.trim();
    if (candidate.persistedAssetRef !== undefined && !persistedAssetRef) {
      skipped.push(attachment.name);
      continue;
    }
    if (persistedAssetRef) {
      const dedupeKey = `asset:${persistedAssetRef}`;
      if (dedupeKeys.has(dedupeKey)) continue;
      dedupeKeys.add(dedupeKey);
    }
    if (counts[kind] >= AGENT_MESSAGE_ATTACHMENT_LIMITS[kind]) {
      skipped.push(`${attachment.name}(${kind === "image" ? "图片" : "文件"}最多 ${AGENT_MESSAGE_ATTACHMENT_LIMITS[kind]} 个)`);
      continue;
    }
    if (persistedAssetRef) {
      ready.push({
        kind,
        name: attachment.name,
        assetRef: persistedAssetRef,
        ...(isPersistentHttpUrl(attachment.previewUrl) ? { url: attachment.previewUrl } : {}),
      });
      counts[kind] += 1;
      continue;
    }
    // 已持久化的引用(资产库等)直接透传 http(s) URL。
    if (isPersistentHttpUrl(attachment.previewUrl)) {
      ready.push({ kind, name: attachment.name, url: attachment.previewUrl });
      counts[kind] += 1;
      if (attachment.id) submittedLocalIds.push(attachment.id);
      continue;
    }
    // 本地 blob 预览对后端无意义:必须走上传通道换 assetRef。
    if (!attachment.file || !options.projectId) {
      skipped.push(attachment.name);
      continue;
    }
    try {
      const uploaded = await uploadReferenceAttachment(
        options.projectId,
        attachment.file,
        { signal: options.signal },
      );
      ready.push({
        kind,
        name: attachment.name,
        assetRef: String(uploaded.assetVersionId),
        ...(isPersistentHttpUrl(uploaded.previewUrl) ? { url: uploaded.previewUrl } : {}),
      });
      counts[kind] += 1;
      if (attachment.id) submittedLocalIds.push(attachment.id);
    } catch (error) {
      if (options.signal?.aborted || (error as { name?: string })?.name === "AbortError") throw error;
      skipped.push(attachment.name);
    }
  }
  return { attachments: ready, skipped, submittedLocalIds };
}
