import { apiPost, readApiSettings } from "./http";

export type FeedbackScreenshotPayload = {
  fileName: string;
  mimeType: string;
  dataUrl: string;
};

export function submitFeedback(payload: {
  description: string;
  pageTitle: string;
  pageUrl: string;
  screenshots: FeedbackScreenshotPayload[];
}) {
  return apiPost<{ id: string; feedbackNo: string }>("/feedback", payload);
}

export async function fetchFeedbackAttachment(id: string, signal?: AbortSignal): Promise<Blob> {
  const settings = readApiSettings();
  const response = await fetch(`${settings.baseUrl}/feedback/attachments/${encodeURIComponent(id)}`, {
    credentials: "same-origin",
    signal,
    headers: settings.token ? { Authorization: settings.token } : {},
  });
  if (!response.ok) throw new Error(response.status === 404 ? "截图不存在或无权查看" : "截图加载失败，请稍后重试");
  return response.blob();
}
