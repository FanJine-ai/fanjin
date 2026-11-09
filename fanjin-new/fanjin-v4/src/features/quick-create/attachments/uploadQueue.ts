import { create } from "zustand";
import type { ReferenceAttachmentMimeCategory, UploadedReferenceAsset } from "./api";
import {
  uploadReferenceAttachment,
  validateUploadFile,
} from "./api";
import type { AttachmentQueueItem, AttachmentUploadResult } from "./uploadQueue.types";

export type {
  AttachmentQueueItem,
  AttachmentUploadResult,
  AttachmentUploadState,
} from "./uploadQueue.types";

type UploadQueueState = {
  items: AttachmentQueueItem[];
  /** 已上传引用所属项目；queued 状态在首次 startUpload 前保持未绑定。 */
  boundProjectId: number | null;
  /** 是否有正在上传的项目 */
  hasActiveUploads: boolean;

  setMediaDuration: (clientId: string, durationSeconds: number) => void;
  /** 添加文件到队列 */
  addFiles: (files: File[]) => { added: number; errors: string[] };
  /** 开始上传所有 queued 项目 */
  startUpload: (projectId: number) => Promise<AttachmentUploadResult>;
  /** 重试失败的项目 */
  retryFailed: (projectId: number) => Promise<AttachmentUploadResult>;
  /** 从持久化 Session 恢复已上传引用，不覆盖仍在上传的本地项目。 */
  hydrateUploaded: (
    projectId: number,
    assets: UploadedReferenceAsset[],
    options?: { replace?: boolean },
  ) => void;
  /** Materialize 创建新项目时，仅迁移仍持有 File 的本地附件并重新绑定。 */
  rebindLocalFiles: (projectId: number) => number;
  /** 移除项目（已上传的不删除服务端文件） */
  remove: (clientId: string) => void;
  /** 清空队列 */
  clear: () => void;
  /** 获取所有已上传的 AssetVersion ID */
  getUploadedAssetVersionIds: () => number[];
  /** 获取所有已上传的引用 */
  getUploadedReferences: () => UploadedReferenceAsset[];
  /** 获取失败项目，供提交后展示/阻止继续生成。 */
  getFailedItems: () => AttachmentQueueItem[];
};

let clientIdCounter = 0;
let uploadRunCounter = 0;
let activeUploadRunId: number | null = null;
const activeUploadControllers = new Map<string, AbortController>();
const uploadedReferenceTypes = new Set<ReferenceAttachmentMimeCategory>([
  "image",
  "video",
  "audio",
  "document",
]);

function generateClientId(): string {
  return `attachment-${Date.now()}-${++clientIdCounter}`;
}

function fileToQueueItem(file: File): AttachmentQueueItem {
  const previewUrl = URL.createObjectURL(file);
  return {
    clientId: generateClientId(),
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type,
    previewUrl,
    localPreviewUrl: previewUrl,
    state: "queued",
    progress: 0,
  };
}

function releaseLocalPreview(item: AttachmentQueueItem) {
  if (item.localPreviewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.localPreviewUrl);
}

function isUploadedReferenceAsset(value: unknown): value is UploadedReferenceAsset {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const asset = value as Partial<UploadedReferenceAsset>;
  return Number.isSafeInteger(asset.assetId)
    && Number(asset.assetId) > 0
    && Number.isSafeInteger(asset.assetVersionId)
    && Number(asset.assetVersionId) > 0
    && typeof asset.filePath === "string"
    && Boolean(asset.filePath.trim())
    && typeof asset.previewUrl === "string"
    && Boolean(asset.previewUrl.trim())
    && uploadedReferenceTypes.has(asset.type as ReferenceAttachmentMimeCategory)
    && typeof asset.name === "string"
    && Boolean(asset.name.trim());
}

export const useUploadQueueStore = create<UploadQueueState>()((set, get) => ({
  items: [],
  boundProjectId: null,
  hasActiveUploads: false,

  setMediaDuration: (clientId, durationSeconds) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    set((state) => ({ items: state.items.map((item) => item.clientId === clientId && item.durationSeconds !== durationSeconds
      ? { ...item, durationSeconds } : item) }));
  },

  addFiles: (files: File[]) => {
    const errors: string[] = [];
    const newItems: AttachmentQueueItem[] = [];

    for (const file of files) {
      const error = validateUploadFile(file);
      if (error) {
        errors.push(`${file.name}: ${error}`);
        continue;
      }
      newItems.push(fileToQueueItem(file));
    }

    if (newItems.length > 0) {
      set((state) => ({
        items: [...state.items, ...newItems],
      }));
    }

    return { added: newItems.length, errors };
  },

  startUpload: async (projectId: number) => {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      return { uploaded: 0, failed: 0, failedClientIds: [] };
    }
    const previousProjectId = get().boundProjectId;
    if (previousProjectId !== null && previousProjectId !== projectId) {
      throw new Error(
        `附件队列已绑定项目 ${previousProjectId}，不能上传到项目 ${projectId}；请先切换或清理附件`,
      );
    }
    if (get().hasActiveUploads) {
      return { uploaded: 0, failed: 0, failedClientIds: [] };
    }
    if (previousProjectId === null) set({ boundProjectId: projectId });
    const { items } = get();
    const queuedItems = items.filter((item) => item.state === "queued");
    if (queuedItems.length === 0) return { uploaded: 0, failed: 0, failedClientIds: [] };

    const uploadRunId = ++uploadRunCounter;
    activeUploadRunId = uploadRunId;
    set({ hasActiveUploads: true });

    // 并发上传（最多 3 个并发）
    const concurrency = 3;
    const uploadedClientIds: string[] = [];
    const failedClientIds: string[] = [];

    const isCurrentRun = () => (
      activeUploadRunId === uploadRunId
      && get().boundProjectId === projectId
    );

    async function processNext() {
      while (true) {
        // clear()/rebind/hydrate 到其他项目后，不再为已失效批次发起新请求。
        if (!isCurrentRun()) return;
        const item = get().items.find(current => current.state === "queued");
        if (!item) return;
        // Claim synchronously before awaiting. Waiting files stay queued, and
        // files added during this batch are picked up by the next free worker.
        set(state => ({items: state.items.map(current => current.clientId === item.clientId
          ? {...current, state: "uploading" as const, progress: 0, transfer: undefined} : current)}));
        const controller = new AbortController();
        activeUploadControllers.set(item.clientId, controller);
        try {
          const asset = await uploadReferenceAttachment(projectId, item.file!, {
            signal: controller.signal,
            onProgress: (progress, transfer) => {
              if (!isCurrentRun()) return;
              set((state) => ({
                items: state.items.map((current) => current.clientId === item.clientId
                  ? { ...current, progress: Math.max(current.progress, progress), transfer: transfer ?? current.transfer }
                  : current),
              }));
            },
          });
          // 旧响应不得写回已切换项目或已移除的队列项。
          if (!isCurrentRun()) return;
          if (!get().items.some(current => current.clientId === item.clientId)) continue;
          uploadedClientIds.push(item.clientId);
          set((state) => ({
            items: state.items.map((i) =>
              i.clientId === item.clientId
                  ? {
                    ...i,
                    state: "uploaded" as const,
                    asset,
                    // Keep the already-renderable local blob for this page.
                    // The protected canonical URL remains on `asset` and is
                    // the only value persisted into the creation session.
                    previewUrl: i.localPreviewUrl || i.previewUrl || asset.previewUrl,
                    progress: 100,
                    file: null,
                    error: undefined,
                  }
                : i,
            ),
          }));
        } catch (error: any) {
          if (!isCurrentRun()) return;
          failedClientIds.push(item.clientId);
          set((state) => ({
            items: state.items.map((i) =>
              i.clientId === item.clientId
                ? { ...i, state: "failed" as const, error: error?.message || "上传失败", progress: 0 }
                : i,
            ),
          }));
        } finally {
          activeUploadControllers.delete(item.clientId);
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, queuedItems.length) }, () => processNext());
    await Promise.all(workers);

    // clear()/项目切换后可能已经启动了新项目的上传。旧批次结束时
    // 不能把新批次的 hasActiveUploads 误置为 false。
    if (activeUploadRunId === uploadRunId) {
      activeUploadRunId = null;
      set({ hasActiveUploads: false });
    }
    return {
      uploaded: uploadedClientIds.length,
      failed: failedClientIds.length,
      failedClientIds,
    };
  },

  retryFailed: async (projectId: number) => {
    const previousProjectId = get().boundProjectId;
    if (previousProjectId !== null && previousProjectId !== projectId) {
      throw new Error(
        `附件队列已绑定项目 ${previousProjectId}，不能上传到项目 ${projectId}；请先切换或清理附件`,
      );
    }
    const { items } = get();
    const failedItems = items.filter((item) => item.state === "failed");
    if (failedItems.length === 0) return { uploaded: 0, failed: 0, failedClientIds: [] };

    // 重置为 queued
    set((state) => ({
      items: state.items.map((item) =>
        item.state === "failed" ? { ...item, state: "queued" as const, error: undefined } : item,
      ),
    }));

    // 重新上传
    return await get().startUpload(projectId);
  },

  hydrateUploaded: (projectId, assets, options) => {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return;
    const projectChanged = get().boundProjectId !== null && get().boundProjectId !== projectId;
    if (projectChanged) activeUploadRunId = null;
    const normalized = Array.isArray(assets)
      ? (assets as unknown[]).filter(isUploadedReferenceAsset)
      : [];
    set((state) => {
      const stateProjectChanged = state.boundProjectId !== null && state.boundProjectId !== projectId;
      if (stateProjectChanged) state.items.forEach(releaseLocalPreview);
      const retained = stateProjectChanged
        ? []
        : options?.replace
          ? state.items.filter((item) => item.state !== "uploaded")
          : state.items;
      const existingVersions = new Set(
        retained
          .map((item) => item.asset?.assetVersionId)
          .filter((id): id is number => Number.isSafeInteger(id)),
      );
      const hydrated = normalized
        .filter((asset) => {
          if (existingVersions.has(asset.assetVersionId)) return false;
          existingVersions.add(asset.assetVersionId);
          return true;
        })
        .map((asset): AttachmentQueueItem => ({
          clientId: `attachment-uploaded-${asset.assetVersionId}`,
          file: null,
          name: asset.name,
          size: Number.isFinite(asset.size) && asset.size >= 0 ? asset.size : 0,
          mimeType: typeof asset.mimeType === "string" && asset.mimeType.trim() ? asset.mimeType : asset.type,
          previewUrl: asset.previewUrl,
          state: "uploaded",
          asset,
          progress: 100,
        }));
      return {
        items: [...retained, ...hydrated],
        boundProjectId: projectId,
        ...(stateProjectChanged ? { hasActiveUploads: false } : {}),
      };
    });
  },

  rebindLocalFiles: (projectId) => {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new Error("缺少有效的项目 ID");
    }
    const current = get();
    if (current.hasActiveUploads) {
      throw new Error("附件仍在上传中，暂时不能切换项目");
    }

    const retained = current.items
      .filter((item) => Boolean(item.file))
      .map((item): AttachmentQueueItem => ({
        ...item,
        state: "queued",
        asset: undefined,
        error: undefined,
        progress: 0,
      }));
    const retainedIds = new Set(retained.map((item) => item.clientId));
    current.items
      .filter((item) => !retainedIds.has(item.clientId))
      .forEach(releaseLocalPreview);
    activeUploadRunId = null;
    set({
      items: retained,
      boundProjectId: projectId,
      hasActiveUploads: false,
    });
    return retained.length;
  },

  remove: (clientId: string) => {
    activeUploadControllers.get(clientId)?.abort(
      new DOMException("用户已取消附件上传", "AbortError"),
    );
    activeUploadControllers.delete(clientId);
    set((state) => {
      const item = state.items.find((i) => i.clientId === clientId);
      if (item) releaseLocalPreview(item);
      return {
        items: state.items.filter((i) => i.clientId !== clientId),
      };
    });
  },

  clear: () => {
    const { items } = get();
    activeUploadRunId = null;
    for (const controller of activeUploadControllers.values()) {
      controller.abort(new DOMException("附件队列已清空", "AbortError"));
    }
    activeUploadControllers.clear();
    // 释放所有预览 URL
    for (const item of items) {
      releaseLocalPreview(item);
    }
    set({ items: [], boundProjectId: null, hasActiveUploads: false });
  },

  getUploadedAssetVersionIds: () => {
    return get()
      .items.filter((item) => item.state === "uploaded" && item.asset)
      .map((item) => item.asset!.assetVersionId);
  },

  getUploadedReferences: () => {
    return get()
      .items.filter((item) => item.state === "uploaded" && item.asset)
      .map((item) => item.asset!);
  },

  getFailedItems: () => get().items.filter((item) => item.state === "failed"),
}));
