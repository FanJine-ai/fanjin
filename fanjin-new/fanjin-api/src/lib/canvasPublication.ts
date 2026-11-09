import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Knex } from "knex";

import {
  CANVAS_SHARE_TABLE,
  FJTV_PUBLICATION_TABLE,
} from "@/lib/migrations/accountWorkspaceAssetLibrary";

const CANVAS_TABLE = "o_workflow_graph";
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_PUBLIC_NODES = 2_000;
const MAX_PUBLIC_EDGES = 4_000;
const MAX_PUBLIC_GROUPS = 500;

export type CanvasPublicationStatus =
  | "pending_review"
  | "published"
  | "rejected"
  | "unpublished";

export class CanvasPublicationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CanvasPublicationError";
    this.status = status;
    this.code = code;
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function parseJsonArray(raw: unknown, label: string, maximum: number): unknown[] {
  let value: unknown;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new CanvasPublicationError(409, "CANVAS_SNAPSHOT_INVALID", `${label} 不是有效 JSON`);
  }
  if (!Array.isArray(value) || value.length > maximum) {
    throw new CanvasPublicationError(409, "CANVAS_SNAPSHOT_INVALID", `${label} 数量无效`);
  }
  return value;
}

function parseJsonObject(raw: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : fallback;
  } catch {
    return fallback;
  }
}

function boundedText(value: unknown, maximum: number): string {
  return String(value ?? "").trim().slice(0, maximum);
}

function safeNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function publicMediaUrl(value: unknown): string | null {
  const raw = boundedText(value, 8_192);
  if (!raw || raw.startsWith("blob:") || raw.startsWith("data:")) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    const sensitiveQuery = Array.from(url.searchParams.keys()).some((key) => (
      /^(?:token|authorization|credential|signature|expires|ossaccesskeyid|x-amz-(?:credential|signature|security-token)|x-oss-(?:credential|signature|security-token)|x-tos-(?:credential|signature|security-token)|q-(?:sign-algorithm|ak|key-time|signature|security-token))$/i.test(key)
    ));
    return sensitiveQuery ? null : url.toString();
  } catch {
    return null;
  }
}

const PUBLIC_NODE_TEXT_FIELDS = [
  "id", "type", "title", "ratio", "prompt", "quality", "resolution",
  "cameraControl", "panorama", "quantity", "duration", "outputText",
  "fileName", "textBackgroundColor", "textHeading", "textListStyle",
  "storyboardCellKey",
] as const;
const PUBLIC_NODE_NUMBER_FIELDS = [
  "x", "y", "width", "height", "mediaNaturalWidth", "mediaNaturalHeight",
  "mediaDurationMs", "videoTrimStart", "videoTrimEnd", "cropX", "cropY",
  "cropWidth", "cropHeight", "imageRotation", "textFontSize",
] as const;
const PUBLIC_NODE_BOOLEAN_FIELDS = [
  "videoLoopSelection", "videoSnapToWholeSecond", "imageFlipX", "imageFlipY",
  "textBold", "textItalic", "textDivider", "textExpanded", "composeMuted",
] as const;
const PUBLIC_NODE_URL_FIELDS = [
  "imageUrl", "primaryImageUrl", "videoUrl", "videoPosterUrl", "audioUrl",
  "referenceAssetPreviewUrl",
] as const;

function publicNodeProjection(value: unknown): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = boundedText(source.id, 200);
  const type = boundedText(source.type, 30);
  if (!id || !["image", "video", "audio", "text", "compose", "script"].includes(type)) return null;
  const output: Record<string, JsonValue> = { id, type };
  for (const field of PUBLIC_NODE_TEXT_FIELDS) {
    const text = boundedText(source[field], field === "prompt" || field === "outputText" ? 100_000 : 1_000);
    if (text) output[field] = text;
  }
  for (const field of PUBLIC_NODE_NUMBER_FIELDS) {
    const number = safeNumber(source[field]);
    if (number !== null) output[field] = number;
  }
  for (const field of PUBLIC_NODE_BOOLEAN_FIELDS) {
    if (typeof source[field] === "boolean") output[field] = source[field] as boolean;
  }
  for (const field of PUBLIC_NODE_URL_FIELDS) {
    const url = publicMediaUrl(source[field]);
    if (url) output[field] = url;
  }
  if (Array.isArray(source.generatedImages)) {
    const images = source.generatedImages.slice(0, 16).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      const url = publicMediaUrl(row.url ?? row.imageUrl);
      if (!url) return [];
      const image: Record<string, JsonValue> = { url };
      const width = safeNumber(row.width);
      const height = safeNumber(row.height);
      if (width !== null) image.width = width;
      if (height !== null) image.height = height;
      return [image];
    });
    if (images.length) output.generatedImages = images;
  }
  return output;
}

function publicEdgeProjection(value: unknown): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = boundedText(source.id, 200);
  const fromNodeId = boundedText(source.fromNodeId, 200);
  const toNodeId = boundedText(source.toNodeId, 200);
  if (!id || !fromNodeId || !toNodeId) return null;
  return {
    id,
    fromNodeId,
    toNodeId,
    fromSide: boundedText(source.fromSide, 30),
    toSide: boundedText(source.toSide, 30),
  };
}

function publicGroupProjection(value: unknown): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = boundedText(source.id, 200);
  if (!id) return null;
  return {
    id,
    nodeIds: Array.isArray(source.nodeIds)
      ? source.nodeIds.map((item) => boundedText(item, 200)).filter(Boolean).slice(0, 500)
      : [],
    title: boundedText(source.title, 500),
    layoutMode: boundedText(source.layoutMode, 50),
    themeColor: boundedText(source.themeColor, 50),
  };
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new CanvasPublicationError(400, "INVALID_ID", `${label} 无效`);
  }
  return id;
}

function expectedRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new CanvasPublicationError(400, "INVALID_REVISION", "expectedRevision 必须是正安全整数");
  }
  return revision;
}

function safeIdempotencyKey(value: unknown): string {
  const key = boundedText(value, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key)) {
    throw new CanvasPublicationError(400, "INVALID_IDEMPOTENCY_KEY", "idempotencyKey 无效");
  }
  return key;
}

function safeSlug(): string {
  return randomBytes(24).toString("base64url");
}

async function canvasSnapshot(
  database: Knex | Knex.Transaction,
  input: { projectId: number; canvasId: number; expectedRevision: number; lock?: boolean },
) {
  let query = database(CANVAS_TABLE).where({ id: input.canvasId, projectId: input.projectId });
  if (input.lock) query = query.forShare();
  const row = await query.first();
  if (!row) throw new CanvasPublicationError(404, "CANVAS_NOT_FOUND", "画布不存在");
  const revision = Number(row.revision || 1);
  if (revision !== input.expectedRevision) {
    throw new CanvasPublicationError(409, "CANVAS_REVISION_CONFLICT", "画布已更新，请刷新后重新发布");
  }
  const nodes = parseJsonArray(row.nodes ?? "[]", "nodes", MAX_PUBLIC_NODES)
    .map(publicNodeProjection).filter(Boolean) as Record<string, JsonValue>[];
  const nodeIds = new Set(nodes.map((node) => String(node.id)));
  const edges = parseJsonArray(row.edges ?? row.connections ?? "[]", "edges", MAX_PUBLIC_EDGES)
    .map(publicEdgeProjection).filter((edge): edge is Record<string, JsonValue> => Boolean(
      edge && nodeIds.has(String(edge.fromNodeId)) && nodeIds.has(String(edge.toNodeId)),
    ));
  const groups = parseJsonArray(row.groups ?? "[]", "groups", MAX_PUBLIC_GROUPS)
    .map(publicGroupProjection).filter(Boolean) as Record<string, JsonValue>[];
  const viewportSource = parseJsonObject(row.viewport, { x: 0, y: 0, zoom: 1 });
  const snapshot: JsonValue = {
    version: "fanjin.public-canvas-snapshot/v1",
    canvas: {
      id: input.canvasId,
      projectId: input.projectId,
      revision,
      name: boundedText(row.name, 500) || "未命名画布",
      nodes,
      edges,
      groups,
      viewport: {
        x: safeNumber(viewportSource.x) ?? 0,
        y: safeNumber(viewportSource.y) ?? 0,
        zoom: safeNumber(viewportSource.zoom) ?? 1,
      },
    },
  };
  const snapshotJson = `${canonicalJson(snapshot)}\n`;
  if (Buffer.byteLength(snapshotJson, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new CanvasPublicationError(413, "CANVAS_SNAPSHOT_TOO_LARGE", "公开画布快照超过 5 MiB");
  }
  return {
    title: boundedText(row.name, 500) || "未命名画布",
    revision,
    snapshotJson,
    snapshotHash: createHash("sha256").update(snapshotJson).digest("hex"),
  };
}

function shareProjection(row: any) {
  return {
    id: String(row.id),
    slug: String(row.slug),
    projectId: Number(row.projectId),
    canvasId: Number(row.canvasId),
    title: String(row.title),
    snapshotRevision: Number(row.snapshotRevision),
    snapshotHash: String(row.snapshotHash),
    status: String(row.status),
    revision: Number(row.revision),
    expiresAt: row.expiresAt == null ? null : Number(row.expiresAt),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    revokedAt: row.revokedAt == null ? null : Number(row.revokedAt),
  };
}

function publicationProjection(row: any, includeModeration = true) {
  return {
    id: String(row.id),
    slug: String(row.slug),
    projectId: Number(row.projectId),
    canvasId: Number(row.canvasId),
    title: String(row.title),
    description: String(row.description || ""),
    coverUrl: row.coverUrl == null ? null : String(row.coverUrl),
    snapshotRevision: Number(row.snapshotRevision),
    snapshotHash: String(row.snapshotHash),
    status: String(row.status) as CanvasPublicationStatus,
    revision: Number(row.revision),
    ...(includeModeration ? {
      moderationReason: row.moderationReason == null ? null : String(row.moderationReason),
      moderatedAt: row.moderatedAt == null ? null : Number(row.moderatedAt),
    } : {}),
    publishedAt: row.publishedAt == null ? null : Number(row.publishedAt),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export async function createCanvasShare(database: Knex, input: {
  workspaceId: string;
  projectId: unknown;
  canvasId: unknown;
  expectedRevision: unknown;
  userId: unknown;
  idempotencyKey: unknown;
  title?: unknown;
  expiresAt?: unknown;
}) {
  const projectId = positiveId(input.projectId, "projectId");
  const canvasId = positiveId(input.canvasId, "canvasId");
  const userId = positiveId(input.userId, "userId");
  const idempotencyKey = safeIdempotencyKey(input.idempotencyKey);
  const expected = expectedRevision(input.expectedRevision);
  const workspaceId = boundedText(input.workspaceId, 200);
  if (!workspaceId) throw new CanvasPublicationError(400, "INVALID_WORKSPACE", "workspaceId 无效");
  const expiresAt = input.expiresAt == null ? null : Number(input.expiresAt);
  const now = Date.now();
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 365 * 24 * 60 * 60 * 1_000)) {
    throw new CanvasPublicationError(400, "INVALID_EXPIRY", "分享有效期必须在未来一年内");
  }
  return database.transaction(async (trx) => {
    const replay = await trx(CANVAS_SHARE_TABLE).where({ workspaceId, canvasId, idempotencyKey }).first();
    if (replay) return shareProjection(replay);
    const snapshot = await canvasSnapshot(trx, { projectId, canvasId, expectedRevision: expected, lock: true });
    const row = {
      id: randomUUID(),
      slug: safeSlug(),
      workspaceId,
      projectId,
      canvasId,
      snapshotRevision: snapshot.revision,
      snapshotHash: snapshot.snapshotHash,
      snapshotJson: snapshot.snapshotJson,
      title: boundedText(input.title, 500) || snapshot.title,
      createdBy: userId,
      status: "active",
      idempotencyKey,
      revision: 1,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    };
    await trx(CANVAS_SHARE_TABLE).insert(row);
    return shareProjection(row);
  });
}

export async function listCanvasShares(database: Knex, input: {
  workspaceId: string; projectId: unknown; canvasId: unknown;
}) {
  const projectId = positiveId(input.projectId, "projectId");
  const canvasId = positiveId(input.canvasId, "canvasId");
  return (await database(CANVAS_SHARE_TABLE)
    .where({ workspaceId: input.workspaceId, projectId, canvasId })
    .orderBy("createdAt", "desc")
    .limit(100))
    .map(shareProjection);
}

export async function revokeCanvasShare(database: Knex, input: {
  workspaceId: string; projectId: unknown; shareId: unknown; expectedRevision: unknown;
}) {
  const projectId = positiveId(input.projectId, "projectId");
  const shareId = boundedText(input.shareId, 100);
  const expected = expectedRevision(input.expectedRevision);
  return database.transaction(async (trx) => {
    const row = await trx(CANVAS_SHARE_TABLE)
      .where({ id: shareId, workspaceId: input.workspaceId, projectId })
      .forUpdate().first();
    if (!row) throw new CanvasPublicationError(404, "SHARE_NOT_FOUND", "分享不存在");
    if (Number(row.revision) !== expected) {
      throw new CanvasPublicationError(409, "SHARE_REVISION_CONFLICT", "分享状态已更新");
    }
    if (row.status === "revoked") return shareProjection(row);
    const now = Date.now();
    await trx(CANVAS_SHARE_TABLE).where({ id: shareId }).update({
      status: "revoked", revision: expected + 1, revokedAt: now, updatedAt: now,
    });
    return shareProjection({ ...row, status: "revoked", revision: expected + 1, revokedAt: now, updatedAt: now });
  });
}

export async function getPublicCanvasShare(database: Knex, slugInput: unknown) {
  const slug = boundedText(slugInput, 100);
  if (!/^[A-Za-z0-9_-]{32}$/.test(slug)) throw new CanvasPublicationError(404, "SHARE_NOT_FOUND", "分享不存在");
  const row = await database(CANVAS_SHARE_TABLE).where({ slug, status: "active" }).first();
  if (!row || (row.expiresAt != null && Number(row.expiresAt) <= Date.now())) {
    throw new CanvasPublicationError(404, "SHARE_NOT_FOUND", "分享不存在或已失效");
  }
  return {
    ...shareProjection(row),
    snapshot: JSON.parse(String(row.snapshotJson)),
  };
}

export async function submitFjtvPublication(database: Knex, input: {
  workspaceId: string;
  projectId: unknown;
  canvasId: unknown;
  expectedRevision: unknown;
  userId: unknown;
  idempotencyKey: unknown;
  title?: unknown;
  description?: unknown;
  coverUrl?: unknown;
}) {
  const projectId = positiveId(input.projectId, "projectId");
  const canvasId = positiveId(input.canvasId, "canvasId");
  const userId = positiveId(input.userId, "userId");
  const expected = expectedRevision(input.expectedRevision);
  const idempotencyKey = safeIdempotencyKey(input.idempotencyKey);
  const workspaceId = boundedText(input.workspaceId, 200);
  const coverUrl = input.coverUrl == null ? null : publicMediaUrl(input.coverUrl);
  if (input.coverUrl && !coverUrl) {
    throw new CanvasPublicationError(400, "INVALID_PUBLIC_COVER", "封面必须是无鉴权参数的 HTTPS 地址");
  }
  const now = Date.now();
  return database.transaction(async (trx) => {
    const replay = await trx(FJTV_PUBLICATION_TABLE).where({ workspaceId, canvasId, idempotencyKey }).first();
    if (replay) return publicationProjection(replay);
    const snapshot = await canvasSnapshot(trx, { projectId, canvasId, expectedRevision: expected, lock: true });
    const row = {
      id: randomUUID(),
      slug: safeSlug(),
      workspaceId,
      projectId,
      canvasId,
      snapshotRevision: snapshot.revision,
      snapshotHash: snapshot.snapshotHash,
      snapshotJson: snapshot.snapshotJson,
      title: boundedText(input.title, 500) || snapshot.title,
      description: boundedText(input.description, 5_000),
      coverUrl,
      submittedBy: userId,
      status: "pending_review",
      idempotencyKey,
      revision: 1,
      moderatedBy: null,
      moderationReason: null,
      moderatedAt: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await trx(FJTV_PUBLICATION_TABLE).insert(row);
    return publicationProjection(row);
  });
}

export async function listOwnFjtvPublications(database: Knex, input: {
  workspaceId: string; projectId: unknown; canvasId: unknown;
}) {
  const projectId = positiveId(input.projectId, "projectId");
  const canvasId = positiveId(input.canvasId, "canvasId");
  return (await database(FJTV_PUBLICATION_TABLE)
    .where({ workspaceId: input.workspaceId, projectId, canvasId })
    .orderBy("createdAt", "desc").limit(100))
    .map((row) => publicationProjection(row));
}

export async function listFjtvModerationQueue(database: Knex, statusInput: unknown = "pending_review") {
  const status = boundedText(statusInput, 50);
  if (!["pending_review", "published", "rejected", "unpublished"].includes(status)) {
    throw new CanvasPublicationError(400, "INVALID_STATUS", "审核状态无效");
  }
  return (await database(FJTV_PUBLICATION_TABLE).where({ status }).orderBy("createdAt", "asc").limit(200))
    .map((row) => publicationProjection(row));
}

export async function reviewFjtvPublication(database: Knex, input: {
  publicationId: unknown;
  expectedRevision: unknown;
  decision: unknown;
  moderatorUserId: unknown;
  reason?: unknown;
  audit?: (
    publication: ReturnType<typeof publicationProjection>,
    previousStatus: CanvasPublicationStatus,
    transaction: Knex.Transaction,
  ) => Promise<void>;
}) {
  const publicationId = boundedText(input.publicationId, 100);
  const expected = expectedRevision(input.expectedRevision);
  const moderatorUserId = positiveId(input.moderatorUserId, "moderatorUserId");
  const decision = boundedText(input.decision, 30);
  if (!["publish", "reject", "unpublish"].includes(decision)) {
    throw new CanvasPublicationError(400, "INVALID_DECISION", "审核决定无效");
  }
  return database.transaction(async (trx) => {
    const row = await trx(FJTV_PUBLICATION_TABLE).where({ id: publicationId }).forUpdate().first();
    if (!row) throw new CanvasPublicationError(404, "PUBLICATION_NOT_FOUND", "投稿不存在");
    if (Number(row.revision) !== expected) {
      throw new CanvasPublicationError(409, "PUBLICATION_REVISION_CONFLICT", "投稿状态已更新");
    }
    const transitions: Record<string, { from: string[]; to: CanvasPublicationStatus }> = {
      publish: { from: ["pending_review", "rejected"], to: "published" },
      reject: { from: ["pending_review"], to: "rejected" },
      unpublish: { from: ["published"], to: "unpublished" },
    };
    const transition = transitions[decision];
    if (!transition.from.includes(String(row.status))) {
      throw new CanvasPublicationError(409, "INVALID_PUBLICATION_TRANSITION", "投稿状态不允许该操作");
    }
    const now = Date.now();
    const patch = {
      status: transition.to,
      revision: expected + 1,
      moderatedBy: moderatorUserId,
      moderationReason: boundedText(input.reason, 2_000) || null,
      moderatedAt: now,
      publishedAt: transition.to === "published" ? now : row.publishedAt,
      updatedAt: now,
    };
    await trx(FJTV_PUBLICATION_TABLE).where({ id: publicationId }).update(patch);
    const publication = publicationProjection({ ...row, ...patch });
    if (input.audit) {
      await input.audit(publication, String(row.status) as CanvasPublicationStatus, trx);
    }
    return publication;
  });
}

export async function listPublicFjtv(database: Knex, limitInput: unknown = 24) {
  const limit = Math.max(1, Math.min(100, Number(limitInput) || 24));
  return (await database(FJTV_PUBLICATION_TABLE)
    .where({ status: "published" })
    .orderBy("publishedAt", "desc")
    .limit(limit))
    .map((row) => publicationProjection(row, false));
}

export async function getPublicFjtvPublication(database: Knex, slugInput: unknown) {
  const slug = boundedText(slugInput, 100);
  if (!/^[A-Za-z0-9_-]{32}$/.test(slug)) throw new CanvasPublicationError(404, "PUBLICATION_NOT_FOUND", "作品不存在");
  const row = await database(FJTV_PUBLICATION_TABLE).where({ slug, status: "published" }).first();
  if (!row) throw new CanvasPublicationError(404, "PUBLICATION_NOT_FOUND", "作品不存在");
  return {
    ...publicationProjection(row, false),
    snapshot: JSON.parse(String(row.snapshotJson)),
  };
}
