import {
  fetchAuthenticatedReferencePreview,
  isAuthenticatedReferencePreviewUrl,
} from "@/features/quick-create/attachments/AuthenticatedReferenceMedia";

export async function fetchCanvasMediaBlob(source: string): Promise<Blob> {
  if (isAuthenticatedReferencePreviewUrl(source)) return fetchAuthenticatedReferencePreview(source);
  // External/signed storage URLs must never receive workspace credentials.
  const response = await fetch(source);
  if (!response.ok) throw new Error(`下载失败 ${response.status}`);
  return response.blob();
}
