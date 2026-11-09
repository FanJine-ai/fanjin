export function readAgentThreadId(search: string): string | null {
  const params = new URLSearchParams(search);
  // Both the project route and embedded conversation use the same thread key.
  const value = params.get("threadId")?.trim();
  return value || null;
}

export function buildGenerateSearch(
  search: string,
  mode: string,
  threadId?: string | null,
): string {
  const params = new URLSearchParams(search);
  params.set("mode", mode);
  params.delete("ai_feature_name");
  params.delete("thread");

  const normalizedThreadId = threadId?.trim() || null;
  if (mode === "agent" && normalizedThreadId) {
    params.set("threadId", normalizedThreadId);
  } else {
    params.delete("threadId");
    params.delete("thread");
  }

  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : "";
}
