import { apiPost, readApiSettings } from "./http";

export interface ManagedFile {
  assetId: number; versionId: number | null; name: string; type: string; createdAt: number;
  fileRevision: number; tags: string[]; source: "uploaded" | "generated";
  refId: string | null; refRevision: number; folderId: string | null; trashedAt: number | null;
  permissions: { view: boolean; use: boolean; manage: boolean };
  assetUsage?: "role" | "scene" | "tool" | "action" | "audio" | "camera" | "style" | "composition" | "other" | null;
  assetUsageExplicit?: boolean;
  assetGroup?: { id: string; name: string; usage: "role" | "scene" | "tool" | "action" | "audio" | "camera" | "style" | "composition" | "other" } | null;
}
export interface FileFolder { id: string; name: string; parentId: string | null; projectId: number; revision: number }
export type FileQuery = {
  projectId?: number; folderId?: string | null; trash?: boolean; source?: "uploaded" | "generated";
  type?: string; usage?: "role" | "scene" | "tool" | "action" | "audio" | "camera" | "style" | "composition" | "other" | "uncategorized";
  keyword?: string; page: number; limit: number;
}
export const listManagedFiles = (query: FileQuery, signal?: AbortSignal) =>
  apiPost<{ items: ManagedFile[]; total: number }, FileQuery>("/file-manager/list", query, undefined, { signal });
export const listFileFolders = (projectId: number, signal?: AbortSignal) =>
  apiPost<FileFolder[], { projectId: number }>("/file-manager/folders", { projectId }, undefined, { signal });
export const updateFile = (input: { assetId: number; expectedRevision: number; name?: string; tags?: string[]; action?: "trash" | "restore" }) =>
  apiPost("/file-manager/update", input);
export const writeFileFolder = (input: { projectId: number; id?: string; name?: string; parentId?: string | null; expectedRevision?: number; remove?: boolean }) =>
  apiPost<FileFolder, typeof input>("/file-manager/folder", input);
export const placeProjectFile = (input: { projectId: number; refId: string; folderId: string | null; expectedRevision: number }) =>
  apiPost("/file-manager/place", input);
export const setHistoryHidden = (ids: string[], hidden: boolean) => apiPost("/file-manager/history-visibility", { ids, hidden });
export interface HistoryImportResult {
  mediaId: string; projectId: number; assetId: number; versionId: number; refId: string; outcome: "imported" | "existing";
}
export const importHistoryAsset = (mediaId: string, projectId: number, signal?: AbortSignal) =>
  apiPost<HistoryImportResult, { mediaId: string; projectId: number }>("/file-manager/history-import", { mediaId, projectId }, undefined, { signal });

let inFlight = 0;
const queue: Array<() => void> = [];
// Limit signed-URL requests and local preview reads while a grid enters the viewport.
export async function filePreviewUrl(file: Pick<ManagedFile, "assetId" | "versionId">, signal?: AbortSignal): Promise<string> {
  if (!file.versionId) throw new Error("文件尚未保存完成");
  await new Promise<void>(resolve => { queue.push(resolve); drain(); });
  try {
    signal?.throwIfAborted();
    const identity = { assetId: file.assetId, versionId: file.versionId };
    const result = await apiPost<{ url: string | null }, typeof identity>("/file-manager/url", identity, undefined, { signal });
    if (result.url) return result.url;
    const { baseUrl, token } = readApiSettings();
    const response = await fetch(`${baseUrl}/file-manager/content`, { method: "POST", signal,
      headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify(identity) });
    if (!response.ok) throw new Error("文件暂时无法读取，请重试");
    const blob = await response.blob();
    signal?.throwIfAborted();
    return URL.createObjectURL(blob);
  } finally { inFlight--; drain(); }
}
function drain() { while (inFlight < 4 && queue.length) { inFlight++; queue.shift()!(); } }
export function releasePreviewUrl(url: string) { if (url.startsWith("blob:")) URL.revokeObjectURL(url); }
export async function downloadManagedFile(file: ManagedFile) {
  if (!file.versionId) throw new Error("文件尚未保存完成");
  const { baseUrl, token } = readApiSettings();
  const response = await fetch(`${baseUrl}/file-manager/content`, { method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ assetId: file.assetId, versionId: file.versionId }) });
  if (!response.ok) throw new Error("文件下载失败，请重试");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export function fileKind(type: string): "image" | "video" | "audio" | "document" {
  if (["image", "role", "scene", "tool"].includes(type)) return "image";
  if (["video", "clip"].includes(type)) return "video";
  return type === "audio" ? "audio" : "document";
}
