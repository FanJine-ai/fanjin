import crypto from "node:crypto";
import { z } from "zod";

import {
  editorTimelineV2Schema,
  type EditorTimelineV2,
} from "@/lib/editorTimelineV2";

export const EDITOR_TIMELINE_LEDGER_VERSION = "editor-timeline-ledger.v1" as const;
export const EDITOR_TIMELINE_LEDGER_MAX_REVISIONS = 30;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const editorTimelineRevisionSchema = z.object({
  id: z.string().min(1).max(80),
  digest: digestSchema,
  createdAt: z.number().int().nonnegative(),
  restoredFromVersionId: z.string().min(1).max(80).nullable(),
  draft: editorTimelineV2Schema,
}).strict();

export const editorTimelineDraftLedgerSchema = z.object({
  version: z.literal(EDITOR_TIMELINE_LEDGER_VERSION),
  currentVersionId: z.string().min(1).max(80),
  current: editorTimelineV2Schema,
  revisions: z.array(editorTimelineRevisionSchema)
    .min(1)
    .max(EDITOR_TIMELINE_LEDGER_MAX_REVISIONS),
}).strict().superRefine((ledger, context) => {
  const ids = new Set<string>();
  for (const [index, revision] of ledger.revisions.entries()) {
    if (ids.has(revision.id)) {
      context.addIssue({
        code: "custom",
        path: ["revisions", index, "id"],
        message: "剪辑版本 ID 不能重复",
      });
    }
    ids.add(revision.id);
    if (timelineDraftDigest(revision.draft) !== revision.digest) {
      context.addIssue({
        code: "custom",
        path: ["revisions", index, "digest"],
        message: "剪辑版本摘要与内容不一致",
      });
    }
  }
  const current = ledger.revisions.find(
    (revision) => revision.id === ledger.currentVersionId,
  );
  if (!current || current.digest !== timelineDraftDigest(ledger.current)) {
    context.addIssue({
      code: "custom",
      path: ["currentVersionId"],
      message: "当前剪辑版本指针无效",
    });
  }
});

export type EditorTimelineRevision = z.infer<typeof editorTimelineRevisionSchema>;
export type EditorTimelineDraftLedger = z.infer<typeof editorTimelineDraftLedgerSchema>;

export function timelineDraftDigest(draft: EditorTimelineV2): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    version: draft.version,
    timeline: draft.timeline,
    soundtrack: draft.soundtrack,
  })).digest("hex");
}

function revisionId(digest: string, createdAt: number, salt: string): string {
  const suffix = crypto.createHash("sha256")
    .update(`${digest}:${createdAt}:${salt}`)
    .digest("hex")
    .slice(0, 20);
  return `edit-${createdAt}-${suffix}`;
}

function createRevision(input: {
  draft: EditorTimelineV2;
  createdAt?: number;
  restoredFromVersionId?: string | null;
  salt?: string;
}): EditorTimelineRevision {
  const createdAt = Math.max(0, Number(input.createdAt ?? input.draft.savedAt) || 0);
  const digest = timelineDraftDigest(input.draft);
  return {
    id: revisionId(digest, createdAt, input.salt || "save"),
    digest,
    createdAt,
    restoredFromVersionId: input.restoredFromVersionId || null,
    draft: input.draft,
  };
}

export function parseEditorTimelineDraftLedger(
  value: unknown,
): EditorTimelineDraftLedger | null {
  const ledger = editorTimelineDraftLedgerSchema.safeParse(value);
  if (ledger.success) return ledger.data;

  const legacyDraft = editorTimelineV2Schema.safeParse(value);
  if (!legacyDraft.success) return null;
  const revision = createRevision({
    draft: legacyDraft.data,
    createdAt: legacyDraft.data.savedAt,
    salt: "legacy",
  });
  return {
    version: EDITOR_TIMELINE_LEDGER_VERSION,
    currentVersionId: revision.id,
    current: legacyDraft.data,
    revisions: [revision],
  };
}

export function appendEditorTimelineRevision(input: {
  ledger: EditorTimelineDraftLedger | null;
  draft: EditorTimelineV2;
  restoredFromVersionId?: string | null;
  salt?: string;
}): EditorTimelineDraftLedger {
  const digest = timelineDraftDigest(input.draft);
  const latest = input.ledger?.revisions.at(-1);
  if (
    input.ledger
    && latest?.digest === digest
    && !input.restoredFromVersionId
  ) {
    return {
      ...input.ledger,
      currentVersionId: latest.id,
      current: input.draft,
      revisions: input.ledger.revisions.map((revision) => (
        revision.id === latest.id
          ? { ...revision, draft: input.draft }
          : revision
      )),
    };
  }
  const revision = createRevision({
    draft: input.draft,
    createdAt: input.draft.savedAt,
    restoredFromVersionId: input.restoredFromVersionId,
    salt: input.salt,
  });
  const revisions = [
    ...(input.ledger?.revisions || []),
    revision,
  ].slice(-EDITOR_TIMELINE_LEDGER_MAX_REVISIONS);
  return {
    version: EDITOR_TIMELINE_LEDGER_VERSION,
    currentVersionId: revision.id,
    current: input.draft,
    revisions,
  };
}

export function restoreEditorTimelineRevision(input: {
  ledger: EditorTimelineDraftLedger;
  versionId: string;
  savedAt: number;
}): EditorTimelineDraftLedger | null {
  const target = input.ledger.revisions.find(
    (revision) => revision.id === input.versionId,
  );
  if (!target) return null;
  const restoredDraft: EditorTimelineV2 = {
    ...target.draft,
    timeline: target.draft.timeline.map((clip) => ({ ...clip })),
    soundtrack: { ...target.draft.soundtrack },
    savedAt: input.savedAt,
  };
  return appendEditorTimelineRevision({
    ledger: input.ledger,
    draft: restoredDraft,
    restoredFromVersionId: target.id,
    salt: `restore:${target.id}`,
  });
}

export function serializeBoundedEditorTimelineLedger(input: {
  ledger: EditorTimelineDraftLedger;
  maxBytes: number;
}): { ledger: EditorTimelineDraftLedger; serialized: string } {
  let revisions = [...input.ledger.revisions];
  while (revisions.length) {
    const currentIncluded = revisions.some(
      (revision) => revision.id === input.ledger.currentVersionId,
    );
    if (!currentIncluded) {
      const current = input.ledger.revisions.find(
        (revision) => revision.id === input.ledger.currentVersionId,
      );
      if (current) revisions = [current, ...revisions].slice(-EDITOR_TIMELINE_LEDGER_MAX_REVISIONS);
    }
    const ledger = { ...input.ledger, revisions };
    const serialized = JSON.stringify(ledger);
    if (Buffer.byteLength(serialized, "utf8") <= input.maxBytes) {
      return { ledger, serialized };
    }
    const removableIndex = revisions.findIndex(
      (revision) => revision.id !== input.ledger.currentVersionId,
    );
    if (removableIndex < 0) break;
    revisions.splice(removableIndex, 1);
  }
  throw new Error("EDITOR_TIMELINE_LEDGER_TOO_LARGE");
}
