import type {AttachmentQueueItem} from "../../features/quick-create/attachments/uploadQueue.types";

export function appendReferenceMentions(brief: string, referenceNumbers: number[]): string {
  const existing = new Set(Array.from(brief.matchAll(/@参考([1-9]\d*)(?!\d)/gu), match => Number(match[1])));
  const additions = referenceNumbers.filter(number => !existing.has(number));
  if (!additions.length) return brief;
  const prefix = brief.replace(/@\s*$/u, "").trimEnd();
  return `${[prefix, ...additions.map(number => `@参考${number}`)].filter(Boolean).join(" ")} `;
}

/** Numbers follow the same ordered queue used to submit assetVersionIds.
 * Rewrite in one pass so moving/removing a card cannot bind text to another file. */
export function remapReferenceMentions(brief: string, before: AttachmentQueueItem[], after: AttachmentQueueItem[]): string {
  return brief.replace(/@参考([1-9]\d*)(?!\d)/gu, (token, raw: string) => {
    const original = before[Number(raw) - 1];
    if (!original) return token;
    const index = after.findIndex(item => item.clientId === original.clientId);
    return index < 0 ? "" : `@参考${index + 1}`;
  });
}
