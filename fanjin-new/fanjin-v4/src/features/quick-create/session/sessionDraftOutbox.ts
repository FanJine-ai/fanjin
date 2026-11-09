const QUICK_CREATE_DRAFT_OUTBOX_PREFIX = "fanjin:quick-create-draft-outbox:v1";
const QUICK_CREATE_DRAFT_OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type QuickCreateDraftPayload = {
  goal: string;
  mode: "quick_create";
  parameters: Record<string, unknown>;
  selectedAssetVersionIds: string[];
};

export type QuickCreateDraftOutboxEntry = {
  version: 1;
  scope: string;
  projectId: number;
  sessionId: string;
  baseVersion: number;
  baseFingerprint: string;
  fingerprint: string;
  savedAt: number;
  payload: QuickCreateDraftPayload;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function storageOrNull(storage?: DraftStorage): DraftStorage | null {
  if (storage) return storage;
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

function outboxKey(scope: string, projectId: number, sessionId: string) {
  return `${QUICK_CREATE_DRAFT_OUTBOX_PREFIX}:${encodeURIComponent(scope)}:${projectId}:${encodeURIComponent(sessionId)}`;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

export function quickCreateDraftFingerprint(payload: QuickCreateDraftPayload) {
  return JSON.stringify(stableJsonValue(payload));
}

function normalizePayload(value: unknown): QuickCreateDraftPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value.goal !== "string" || value.mode !== "quick_create") return null;
  if (!isRecord(value.parameters) || !Array.isArray(value.selectedAssetVersionIds)) return null;
  if (!value.selectedAssetVersionIds.every((item) => typeof item === "string")) return null;
  return {
    goal: value.goal,
    mode: "quick_create",
    parameters: value.parameters,
    selectedAssetVersionIds: [...new Set(value.selectedAssetVersionIds.map((item) => item.trim()).filter(Boolean))],
  };
}

export function writeQuickCreateDraftOutbox(
  entry: QuickCreateDraftOutboxEntry,
  storage?: DraftStorage,
) {
  const target = storageOrNull(storage);
  if (!target) return false;
  try {
    target.setItem(outboxKey(entry.scope, entry.projectId, entry.sessionId), JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

export function readQuickCreateDraftOutbox(
  scope: string,
  projectId: number,
  sessionId: string,
  options: { storage?: DraftStorage; now?: number } = {},
): QuickCreateDraftOutboxEntry | null {
  const target = storageOrNull(options.storage);
  if (!target) return null;
  const key = outboxKey(scope, projectId, sessionId);
  try {
    const parsed = JSON.parse(target.getItem(key) || "null") as unknown;
    if (!isRecord(parsed)) return null;
    const payload = normalizePayload(parsed.payload);
    const savedAt = Number(parsed.savedAt);
    const baseVersion = Number(parsed.baseVersion);
    const baseFingerprint = typeof parsed.baseFingerprint === "string"
      ? parsed.baseFingerprint
      : "";
    const fingerprint = typeof parsed.fingerprint === "string"
      ? parsed.fingerprint
      : "";
    const now = options.now ?? Date.now();
    const valid = parsed.version === 1
      && parsed.projectId === projectId
      && parsed.scope === scope
      && parsed.sessionId === sessionId
      && Number.isSafeInteger(baseVersion)
      && baseVersion > 0
      && baseFingerprint.length > 0
      && fingerprint.length > 0
      && Number.isFinite(savedAt)
      && savedAt > 0
      && savedAt <= now + 60_000
      && now - savedAt <= QUICK_CREATE_DRAFT_OUTBOX_MAX_AGE_MS
      && payload !== null;
    if (!valid) {
      target.removeItem(key);
      return null;
    }
    return {
      version: 1,
      scope,
      projectId,
      sessionId,
      baseVersion,
      baseFingerprint,
      fingerprint,
      savedAt,
      payload,
    };
  } catch {
    try {
      target.removeItem(key);
    } catch {
      // Invalid browser storage must never block the creation page.
    }
    return null;
  }
}

export function clearQuickCreateDraftOutbox(
  scope: string,
  projectId: number,
  sessionId: string,
  options: { storage?: DraftStorage; fingerprint?: string } = {},
) {
  const target = storageOrNull(options.storage);
  if (!target) return false;
  const key = outboxKey(scope, projectId, sessionId);
  try {
    if (options.fingerprint) {
      const current = readQuickCreateDraftOutbox(scope, projectId, sessionId, {
        storage: target,
      });
      if (!current || current.fingerprint !== options.fingerprint) return false;
    }
    target.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
