/** Tab-local handoff only: never persist credentials, files, or a generation request. */
export type GuestDraft = {
  brief: string;
  mode: "视频生成" | "图片生成" | "创意导演" | "Agent 模式";
  owner?: string;
  sourceCaseId?: string;
  sourceIdea?: string;
};
const KEY = "fanjin:guest-creation-draft:v1";
let memory: GuestDraft | null = null;

export function readGuestDraft(): GuestDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (
      !value ||
      typeof value.brief !== "string" ||
      !["视频生成", "图片生成", "创意导演", "Agent 模式"].includes(value.mode)
    )
      return null;
    return {
      brief: value.brief.slice(0, 20_000),
      mode: value.mode,
      ...(typeof value.sourceCaseId === "string" && /^ark-(small-hero|wind)-\d+$/.test(value.sourceCaseId) ? {sourceCaseId: value.sourceCaseId, sourceIdea: typeof value.sourceIdea === "string" ? value.sourceIdea.slice(0, 4000) : ""} : {}),
      ...(typeof value.owner === "string" ? { owner: value.owner } : {}),
    };
  } catch {
    return memory;
  }
}

export function saveGuestDraft(draft: GuestDraft) {
  memory = draft;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    /* Keep this tab's in-memory draft. */
  }
}

export function bindGuestDraft(userId: string | number) {
  const draft = readGuestDraft();
  if (draft && !draft.owner)
    saveGuestDraft({ ...draft, owner: String(userId) });
}

export function clearGuestDraft() {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* Storage may be unavailable. */
  }
}
