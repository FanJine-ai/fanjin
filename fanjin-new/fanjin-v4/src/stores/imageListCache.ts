// imageListCache — migrated from Pinia → zustand.
// Structure: { [projectId]: { [scriptId]: { [trackId]: CachedUploadItem[] } } }
// src in cache stores only the file path (no origin/host:port).
// Full URLs are resolved via backend endpoint at runtime.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { apiPost } from "../api/http";

// ── Migrated type definitions (from Vue project) ──────────────────────────
type UploadItem = { id: number; sources: string; src: string; url?: string };
type TrackMedia = { id: number; type: string; src?: string; sources?: string };
type TrackItem = { id: number | string; name: string; medias: TrackMedia[] };

type CacheKey = string | number;

/** 缓存中存储的项，src 为纯文件路径（不含 origin） */
type CachedUploadItem = Omit<UploadItem, "src"> & { src?: string };

type ImageListCacheData = Record<CacheKey, Record<CacheKey, Record<CacheKey, CachedUploadItem[]>>>;

/** 用于向后端请求 URL 的标识信息 */
interface ResolveUrlItem {
  id: number | null | undefined;
  sources: string | undefined;
}

/** 生成 urlMap 的复合键: "id:sources" */
function makeUrlKey(id: number | null | undefined, sources: string | undefined): string {
  return `${id ?? ""}:${sources ?? ""}`;
}

/** 从完整 URL 中提取路径部分（去掉 origin） */
function extractPath(url: string | undefined): string {
  if (!url) return "";
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

/** 将 UploadItem[] 转为缓存格式（src 只保留路径） */
function toCachedItems(items: (UploadItem | TrackMedia)[]): CachedUploadItem[] {
  return items.map((item) => ({
    ...JSON.parse(JSON.stringify(item)),
    src: extractPath(item.src),
  }));
}

interface ImageListCacheState {
  cacheData: ImageListCacheData;
  urlMap: Record<string, string>;

  resolveUrls: (items: ResolveUrlItem[]) => Promise<Record<string, string>>;
  resolveUrlSync: (id: number | null | undefined, sources: string | undefined, fallbackPath?: string) => string;
  toFullItems: (items: CachedUploadItem[]) => UploadItem[];
  getCache: (projectId: CacheKey, scriptId: CacheKey, trackId: CacheKey) => UploadItem[] | undefined;
  getCacheWithResolve: (projectId: CacheKey, scriptId: CacheKey, trackId: CacheKey) => Promise<UploadItem[] | undefined>;
  getRawCache: (projectId: CacheKey, scriptId: CacheKey, trackId: CacheKey) => CachedUploadItem[] | undefined;
  setCache: (projectId: CacheKey, scriptId: CacheKey, trackId: CacheKey, imageList: (UploadItem | TrackMedia)[]) => void;
  removeCache: (projectId: CacheKey, scriptId: CacheKey, trackId: CacheKey) => void;
  removeImageById: (projectId: CacheKey, scriptId: CacheKey, imageId: number) => void;
  clearScriptCache: (projectId: CacheKey, scriptId: CacheKey) => void;
  clearProjectCache: (projectId: CacheKey) => void;
  initCacheFromTrackList: (projectId: CacheKey, scriptId: CacheKey, trackList: TrackItem[]) => void;
  forceInitCacheFromTrackList: (projectId: CacheKey, scriptId: CacheKey, trackList: TrackItem[]) => void;
  warmUpUrls: (projectId: CacheKey, scriptId: CacheKey) => Promise<void>;
  clearUrlMap: () => void;
}

export const useImageListCacheStore = create<ImageListCacheState>()(
  persist(
    (set, get) => ({
      cacheData: {},
      urlMap: {},

      async resolveUrls(items: ResolveUrlItem[]): Promise<Record<string, string>> {
        if (!items.length) return {};
        const needResolve = items.filter((item) => item.id != null);
        if (needResolve.length) {
          try {
            const data: any = await apiPost("/production/workbench/getFileUrl", {
              items: needResolve.map((item) => ({ id: item.id, sources: item.sources })),
            });
            const rawData = data?.data;
            const resolved: Record<string, string> = {};
            if (Array.isArray(rawData)) {
              rawData.forEach((item: any) => {
                if (item.id != null && item.url) {
                  const key = makeUrlKey(item.id, item.sources);
                  resolved[key] = item.url;
                }
              });
            } else if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
              Object.entries(rawData).forEach(([key, url]) => {
                resolved[key] = url as string;
              });
            }
            set((state) => ({ urlMap: { ...state.urlMap, ...resolved } }));
          } catch (e) {
            console.warn("[imageListCache] resolveUrls 请求失败，降级使用路径", e);
          }
        }
        const { urlMap } = get();
        const result: Record<string, string> = {};
        items.forEach((item) => {
          const key = makeUrlKey(item.id, item.sources);
          result[key] = urlMap[key] || item.id?.toString() || "";
        });
        return result;
      },

      resolveUrlSync(id, sources, fallbackPath?) {
        if (id != null) {
          const key = makeUrlKey(id, sources);
          const { urlMap } = get();
          if (urlMap[key]) return urlMap[key];
        }
        return fallbackPath || "";
      },

      toFullItems(items: CachedUploadItem[]): UploadItem[] {
        const { resolveUrlSync } = get();
        return items.map((item) => ({
          ...item,
          src: resolveUrlSync(item.id, (item as any).sources, item.src),
        })) as UploadItem[];
      },

      getCache(projectId, scriptId, trackId) {
        const { cacheData, toFullItems } = get();
        const cached = cacheData[projectId]?.[scriptId]?.[trackId];
        if (!cached) return undefined;
        return toFullItems(cached);
      },

      async getCacheWithResolve(projectId, scriptId, trackId) {
        const { cacheData, resolveUrls, toFullItems } = get();
        const cached = cacheData[projectId]?.[scriptId]?.[trackId];
        if (!cached) return undefined;
        const resolveItems: ResolveUrlItem[] = cached
          .filter((item) => item.id != null)
          .map((item) => ({ id: item.id, sources: (item as any).sources }));
        await resolveUrls(resolveItems);
        return get().toFullItems(cached);
      },

      getRawCache(projectId, scriptId, trackId) {
        return get().cacheData[projectId]?.[scriptId]?.[trackId];
      },

      setCache(projectId, scriptId, trackId, imageList) {
        set((state) => {
          const newCacheData = { ...state.cacheData };
          if (!newCacheData[projectId]) newCacheData[projectId] = {};
          if (!newCacheData[projectId][scriptId]) newCacheData[projectId][scriptId] = {};
          newCacheData[projectId] = { ...newCacheData[projectId] };
          newCacheData[projectId][scriptId] = { ...newCacheData[projectId][scriptId] };
          newCacheData[projectId][scriptId][trackId] = toCachedItems(imageList);

          // Write full URLs to urlMap
          const newUrlMap = { ...state.urlMap };
          let urlMapDirty = false;
          imageList.forEach((item) => {
            if (!item.src || item.id == null) return;
            const key = makeUrlKey(item.id, (item as any).sources);
            if (!newUrlMap[key]) {
              newUrlMap[key] = item.src;
              urlMapDirty = true;
            }
          });

          return {
            cacheData: newCacheData,
            ...(urlMapDirty ? { urlMap: newUrlMap } : {}),
          };
        });
      },

      removeCache(projectId, scriptId, trackId) {
        set((state) => {
          const newCacheData = { ...state.cacheData };
          if (newCacheData[projectId]?.[scriptId]) {
            const scriptCopy = { ...newCacheData[projectId][scriptId] };
            delete scriptCopy[trackId];
            newCacheData[projectId] = { ...newCacheData[projectId], [scriptId]: scriptCopy };
          }
          return { cacheData: newCacheData };
        });
      },

      removeImageById(projectId, scriptId, imageId) {
        set((state) => {
          const newCacheData = { ...state.cacheData };
          const scriptCache = newCacheData[projectId]?.[scriptId];
          if (!scriptCache) return state;
          const updated: Record<CacheKey, CachedUploadItem[]> = {};
          Object.keys(scriptCache).forEach((trackId) => {
            updated[trackId] = scriptCache[trackId].filter((item) => item.id !== imageId);
          });
          newCacheData[projectId] = { ...newCacheData[projectId], [scriptId]: updated };
          return { cacheData: newCacheData };
        });
      },

      clearScriptCache(projectId, scriptId) {
        set((state) => {
          const newCacheData = { ...state.cacheData };
          if (newCacheData[projectId]) {
            const projectCopy = { ...newCacheData[projectId] };
            delete projectCopy[scriptId];
            newCacheData[projectId] = projectCopy;
          }
          return { cacheData: newCacheData };
        });
      },

      clearProjectCache(projectId) {
        set((state) => {
          const newCacheData = { ...state.cacheData };
          delete newCacheData[projectId];
          return { cacheData: newCacheData };
        });
      },

      initCacheFromTrackList(projectId, scriptId, trackList) {
        set((state) => {
          const newCacheData = { ...state.cacheData };
          if (!newCacheData[projectId]) newCacheData[projectId] = {};
          const projectCopy = { ...newCacheData[projectId] };
          if (!projectCopy[scriptId]) projectCopy[scriptId] = {};
          const scriptCopy = { ...projectCopy[scriptId] };
          trackList.forEach((track) => {
            if (track.id == null) return;
            if (scriptCopy[track.id]) return; // preserve existing cache
            scriptCopy[track.id] = toCachedItems(track.medias);
          });
          projectCopy[scriptId] = scriptCopy;
          newCacheData[projectId] = projectCopy;
          return { cacheData: newCacheData };
        });
      },

      forceInitCacheFromTrackList(projectId, scriptId, trackList) {
        set((state) => {
          const newCacheData = { ...state.cacheData };
          const scriptCopy: Record<CacheKey, CachedUploadItem[]> = {};
          trackList.forEach((track) => {
            if (track.id == null) return;
            scriptCopy[track.id] = toCachedItems(track.medias);
          });
          if (!newCacheData[projectId]) newCacheData[projectId] = {};
          newCacheData[projectId] = { ...newCacheData[projectId], [scriptId]: scriptCopy };
          return { cacheData: newCacheData };
        });
      },

      async warmUpUrls(projectId, scriptId) {
        const { cacheData, resolveUrls } = get();
        const scriptCache = cacheData[projectId]?.[scriptId];
        if (!scriptCache) return;
        const allItems: ResolveUrlItem[] = [];
        const seen = new Set<string>();
        Object.values(scriptCache).forEach((items) => {
          items.forEach((item) => {
            if (item.id == null) return;
            const key = makeUrlKey(item.id, (item as any).sources);
            if (!seen.has(key)) {
              seen.add(key);
              allItems.push({ id: item.id, sources: (item as any).sources });
            }
          });
        });
        await resolveUrls(allItems);
      },

      clearUrlMap() {
        set({ urlMap: {} });
      },
    }),
    {
      name: "fanjin-image-list-cache",
      partialize: (state) => ({ cacheData: state.cacheData }),
    },
  ),
);
