import type { Knex } from "knex";
import { z } from "zod";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import type { AgentSkillPreferenceSnapshotRef } from "@/agent-runtime/runtimeConfigRegistry";
import type { WorkbenchModelCapability } from "@/lib/workbenchModelCatalog";
import { normalizeVideoResolution } from "@/lib/videoResolutions";

export const AGENT_MESSAGE_CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const AGENT_MESSAGE_ASSET_REF_LIMIT = 50;

export interface AgentMessageContextAssetRefInput {
  assetId: number;
}

export const agentMessageGenerationPreferencesInputSchema = z.discriminatedUnion("generationType", [
  z.object({
    generationType: z.literal("image"),
    model: z.string().trim().min(1).max(200),
    ratio: z.string().trim().regex(/^\d{1,3}:\d{1,3}$/),
    quality: z.string().trim().min(1).max(20),
    count: z.number().int().min(1).max(10),
  }).strict(),
  z.object({
    generationType: z.literal("video"),
    model: z.string().trim().min(1).max(200),
    ratio: z.union([z.literal("adaptive"), z.string().trim().regex(/^\d{1,3}:\d{1,3}$/)]),
    resolution: z.string().trim().min(1).max(20),
    outputFormat: z.enum(["mp4", "mov"]).optional(),
    mode: z.string().trim().min(1).max(100),
    duration: z.union([z.literal(-1), z.number().positive().max(60)]),
    generateAudio: z.boolean(),
  }).strict(),
]);

export type AgentMessageGenerationPreferencesInput = z.input<
  typeof agentMessageGenerationPreferencesInputSchema
>;

export type AgentMessageGenerationPreferences =
  | {
      generationType: "image";
      model: string;
      ratio: string;
      quality: string;
      count: number;
    }
  | {
      generationType: "video";
      model: string;
      ratio: string;
      resolution: string;
      outputFormat?: "mp4" | "mov";
      mode: string;
      duration: number;
      generateAudio: boolean;
    };

/**
 * Client context is only a selection hint. The resolver below reloads every
 * referenced row in the Thread's project/workspace scope before it authors a
 * confirmed snapshot.
 */
export interface AgentMessageContextInput {
  assetRefs?: readonly AgentMessageContextAssetRefInput[];
  style?: string | null;
  generationPreferences?: AgentMessageGenerationPreferencesInput;
}

export interface AgentMessageContextAttachmentInput {
  kind: "image" | "file";
  name: string;
  url?: string;
  assetRef?: string;
}

export interface AgentMessageContextSnapshotAsset {
  assetId: number;
  assetVersionId: string | null;
  name: string | null;
  kind: string | null;
}

export interface AgentMessageContextSnapshotReference {
  assetId: number;
  assetVersionId: string;
  name: string | null;
  kind: string | null;
  source: "message" | "creation_session";
}

export interface AgentMessageContextSnapshotSkill {
  key: string;
  version: string;
  displayName: string;
  contentHash: string;
}

export interface AgentMessageContextSnapshotStyle {
  value: string;
  source: "creation_session" | "project" | "request";
  sourceVersion: number | null;
}

export interface AgentMessageContextSnapshot {
  schemaVersion: typeof AGENT_MESSAGE_CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  status: "confirmed";
  digest: string;
  /**
   * Domain-separated hashes of every CreationSession asset-version selection.
   *
   * Legacy writers accepted opaque strings such as `asset-version-1` and
   * `01`. Those values are intentionally never persisted in this snapshot or
   * exposed through the public DTO, but their hashes still bind idempotency to
   * the exact Session selection (including order and duplicates).
   */
  sessionSelectionDigests?: string[];
  assets: AgentMessageContextSnapshotAsset[];
  attachments: AgentMessageContextSnapshotReference[];
  references: AgentMessageContextSnapshotReference[];
  skills: AgentMessageContextSnapshotSkill[];
  style: AgentMessageContextSnapshotStyle | null;
  generationPreferences?: AgentMessageGenerationPreferences;
}

export interface PublicAgentMessageContextSnapshot {
  schemaVersion: typeof AGENT_MESSAGE_CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  status: "confirmed";
  digest: string;
  assets: Array<{
    assetId: number;
    assetVersionId: string | null;
    name: string;
    kind: string | null;
  }>;
  attachments: Array<{
    assetVersionId: string;
    assetId: number;
    name: string;
    kind: string | null;
  }>;
  references: Array<{
    assetVersionId: string;
    assetId: number;
    name: string;
    kind: string | null;
  }>;
  skills: Array<{
    key: string;
    version: string;
    displayName: string;
  }>;
  style: string | null;
  generationPreferences?: AgentMessageGenerationPreferences;
}

export interface PublicAgentMessageContextUsage {
  schemaVersion: typeof AGENT_MESSAGE_CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  status: "used";
  digest: string;
}

const nullableTextSchema = z.string().nullable();
const snapshotAssetSchema = z.object({
  assetId: z.number().int().positive(),
  assetVersionId: z.string().regex(/^[1-9]\d*$/).nullable(),
  name: nullableTextSchema,
  kind: nullableTextSchema,
}).strict();
const snapshotReferenceSchema = z.object({
  assetId: z.number().int().positive(),
  assetVersionId: z.string().regex(/^[1-9]\d*$/),
  name: nullableTextSchema,
  kind: nullableTextSchema,
  source: z.enum(["message", "creation_session"]),
}).strict();
const snapshotSkillSchema = z.object({
  key: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const snapshotStyleSchema = z.object({
  value: z.string().min(1),
  source: z.enum(["creation_session", "project", "request"]),
  sourceVersion: z.number().int().positive().nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.source === "request") !== (value.sourceVersion === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "request style 不得伪造持久化来源版本",
      path: ["sourceVersion"],
    });
  }
});
const canonicalTextSchema = (max: number) => z.string().min(1).max(max).refine(
  (value) => value === value.trim(),
  "snapshot text must be canonical",
);
const snapshotGenerationPreferencesSchema = z.discriminatedUnion("generationType", [
  z.object({
    generationType: z.literal("image"),
    model: canonicalTextSchema(200),
    ratio: z.string().regex(/^\d{1,3}:\d{1,3}$/),
    quality: canonicalTextSchema(20),
    count: z.number().int().min(1).max(10),
  }).strict(),
  z.object({
    generationType: z.literal("video"),
    model: canonicalTextSchema(200),
    ratio: z.union([z.literal("adaptive"), z.string().regex(/^\d{1,3}:\d{1,3}$/)]),
    resolution: canonicalTextSchema(20),
    outputFormat: z.enum(["mp4", "mov"]).optional(),
    mode: canonicalTextSchema(100),
    duration: z.union([z.literal(-1), z.number().positive().max(60)]),
    generateAudio: z.boolean(),
  }).strict(),
]);
const snapshotBaseSchema = z.object({
  schemaVersion: z.literal(AGENT_MESSAGE_CONTEXT_SNAPSHOT_SCHEMA_VERSION),
  status: z.literal("confirmed"),
  // Optional keeps already-persisted v1 snapshots verifiable. New snapshots
  // always populate the field, including with an empty array.
  sessionSelectionDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  assets: z.array(snapshotAssetSchema),
  attachments: z.array(snapshotReferenceSchema),
  references: z.array(snapshotReferenceSchema),
  skills: z.array(snapshotSkillSchema),
  style: snapshotStyleSchema.nullable(),
  // Optional preserves the digest and readability of already-persisted v1
  // snapshots. Every new web Agent message supplies this field.
  generationPreferences: snapshotGenerationPreferencesSchema.optional(),
}).strict();
const snapshotSchema = snapshotBaseSchema.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const contextUsageSchema = z.object({
  schemaVersion: z.literal(AGENT_MESSAGE_CONTEXT_SNAPSHOT_SCHEMA_VERSION),
  status: z.literal("used"),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

let defaultDatabaseModulePromise: Promise<typeof import("@/utils/db")> | null = null;

async function loadReadyDefaultDatabase(): Promise<Knex> {
  defaultDatabaseModulePromise ??= import("@/utils/db");
  const databaseModule = await defaultDatabaseModulePromise;
  await databaseModule.dbReady;
  return databaseModule.db as unknown as Knex;
}

type AssetRow = {
  id: number | string;
  name: string | null;
  type: string | null;
  imageId: number | string | null;
};

type AssetVersionRow = {
  id: number | string;
  assetId: number | string;
  assetName: string | null;
  assetKind: string | null;
  versionKind: string | null;
};

function nullableText(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function positiveVersion(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function parseStoredRecord(value: unknown, code: string): Record<string, unknown> {
  if (value == null || value === "") return {};
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AgentRuntimeError(409, code, "创作上下文无法安全读取，请刷新后重试");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentRuntimeError(409, code, "创作上下文无法安全读取，请刷新后重试");
  }
  return parsed as Record<string, unknown>;
}

function parseStoredStringArray(value: unknown, code: string): string[] {
  if (value == null || value === "") return [];
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AgentRuntimeError(409, code, "创作上下文无法安全读取，请刷新后重试");
    }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new AgentRuntimeError(409, code, "创作上下文无法安全读取，请刷新后重试");
  }
  return parsed.map((item) => item.trim());
}

function canonicalPositiveId(
  value: unknown,
  status: number,
  code: string,
  message: string,
): string {
  const raw = typeof value === "string" ? value.trim() : String(value ?? "");
  if (!/^[1-9]\d*$/.test(raw)) throw new AgentRuntimeError(status, code, message);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new AgentRuntimeError(status, code, message);
  return String(parsed);
}

function optionalCanonicalPositiveId(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : String(value ?? "");
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function sessionSelectionDigest(value: string): string {
  return hashIdempotencyRequest({
    scope: "agent_message_creation_session_asset_version",
    value,
  });
}

export function normalizeAgentMessageContextInput(
  value: AgentMessageContextInput | undefined,
): {
  assetRefs: AgentMessageContextAssetRefInput[];
  style: string | null | undefined;
  generationPreferences: AgentMessageGenerationPreferencesInput | undefined;
} {
  if (value === undefined) {
    return { assetRefs: [], style: undefined, generationPreferences: undefined };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRuntimeError(400, "message_context_invalid", "contextSnapshot 必须是对象");
  }
  const refs = value.assetRefs ?? [];
  if (!Array.isArray(refs) || refs.length > AGENT_MESSAGE_ASSET_REF_LIMIT) {
    throw new AgentRuntimeError(
      400,
      "message_asset_refs_exceeded",
      `资产选择最多 ${AGENT_MESSAGE_ASSET_REF_LIMIT} 个`,
    );
  }
  const seen = new Set<number>();
  const assetRefs = refs.map((ref, index) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw new AgentRuntimeError(400, "message_asset_ref_invalid", `assetRefs[${index}] 必须是对象`);
    }
    const assetId = Number(ref.assetId);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) {
      throw new AgentRuntimeError(400, "message_asset_ref_invalid", `assetRefs[${index}].assetId 无效`);
    }
    if (seen.has(assetId)) {
      throw new AgentRuntimeError(400, "message_asset_ref_duplicate", `资产 ${assetId} 不能重复选择`);
    }
    seen.add(assetId);
    return { assetId };
  });
  if (value.style !== undefined && value.style !== null && typeof value.style !== "string") {
    throw new AgentRuntimeError(400, "message_style_invalid", "contextSnapshot.style 必须是字符串或 null");
  }
  const style = typeof value.style === "string" ? value.style.trim() : value.style;
  if (typeof style === "string" && style.length > 2_000) {
    throw new AgentRuntimeError(400, "message_style_invalid", "contextSnapshot.style 不能超过 2000 字符");
  }
  const preferences = value.generationPreferences === undefined
    ? undefined
    : agentMessageGenerationPreferencesInputSchema.safeParse(value.generationPreferences);
  if (preferences && !preferences.success) {
    throw new AgentRuntimeError(
      400,
      "message_generation_preferences_invalid",
      "contextSnapshot.generationPreferences 格式无效",
    );
  }
  return {
    assetRefs,
    style,
    generationPreferences: preferences?.success ? preferences.data : undefined,
  };
}

function canonicalCapabilityValue(
  allowed: readonly string[] | undefined,
  requested: string,
  normalize: (value: string) => string = (value) => value,
): string | null {
  const normalized = normalize(requested);
  return (allowed ?? []).find((value) => normalize(value) === normalized) ?? null;
}

function durationSupported(
  value: number,
  duration: WorkbenchModelCapability["duration"],
): boolean {
  if (!duration) return false;
  if (value === -1) return duration.auto === true;
  if (duration.allowed?.length) return duration.allowed.includes(value);
  if (value < duration.min || value > duration.max || duration.step <= 0) return false;
  const steps = (value - duration.min) / duration.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

async function resolveGenerationPreferences(input: {
  workspaceId: string;
  requested: AgentMessageGenerationPreferencesInput | undefined;
  database: Knex | Knex.Transaction;
}): Promise<AgentMessageGenerationPreferences | undefined> {
  if (!input.requested) return undefined;
  const { resolveWorkbenchModelCapability } = await import("@/lib/workbenchModelCatalog");
  const endpointType = input.requested.generationType === "image"
    ? "image_generation"
    : "video_generation";
  const capability = await resolveWorkbenchModelCapability({
    workspaceId: input.workspaceId,
    endpointType,
    model: input.requested.model,
    database: input.database,
  });
  if (!capability || !capability.canSubmit) {
    throw new AgentRuntimeError(
      409,
      "message_generation_preferences_stale",
      "所选生成模型已不可提交，请刷新模型目录后重试",
    );
  }
  const ratio = canonicalCapabilityValue(capability.aspectRatios, input.requested.ratio);
  if (!ratio) {
    throw new AgentRuntimeError(
      409,
      "message_generation_preferences_stale",
      "所选生成比例已不可用，请刷新模型目录后重试",
    );
  }
  if (input.requested.generationType === "image") {
    const quality = canonicalCapabilityValue(
      capability.qualities,
      input.requested.quality,
      (value) => value.toUpperCase(),
    );
    const maxOutputs = Number.isSafeInteger(capability.maxOutputs) && Number(capability.maxOutputs) > 0
      ? Number(capability.maxOutputs)
      : 1;
    if (!quality || input.requested.count > maxOutputs) {
      throw new AgentRuntimeError(
        409,
        "message_generation_preferences_stale",
        "所选图片清晰度或数量已不可用，请刷新模型目录后重试",
      );
    }
    return {
      generationType: "image",
      model: capability.id,
      ratio,
      quality,
      count: input.requested.count,
    };
  }

  const resolution = canonicalCapabilityValue(
    capability.resolutions,
    input.requested.resolution,
    (value) => normalizeVideoResolution(value) ?? value.toLowerCase(),
  );
  const mode = canonicalCapabilityValue(
    capability.modes,
    input.requested.mode,
    (value) => value.toLowerCase(),
  );
  if (
    !resolution
    || !mode
    || !durationSupported(input.requested.duration, capability.duration)
    || (input.requested.generateAudio && capability.supportsGenerateAudio !== true)
    || (input.requested.outputFormat && !capability.videoGeneration?.outputFormats?.includes(input.requested.outputFormat))
  ) {
    throw new AgentRuntimeError(
      409,
      "message_generation_preferences_stale",
      "所选视频清晰度、模式、时长或音频能力已不可用，请刷新模型目录后重试",
    );
  }
  return {
    generationType: "video",
    model: capability.id,
    ratio,
    resolution,
    ...(input.requested.outputFormat ? { outputFormat: input.requested.outputFormat } : {}),
    mode,
    duration: input.requested.duration,
    generateAudio: input.requested.generateAudio,
  };
}

function snapshotDigest(base: z.infer<typeof snapshotBaseSchema>): string {
  return hashIdempotencyRequest(base);
}

function uniqueReferenceRefs(snapshot: AgentMessageContextSnapshot): string[] {
  const refs = new Set<string>();
  for (const asset of snapshot.assets) {
    refs.add(`asset:${asset.assetId}`);
    if (asset.assetVersionId) refs.add(`asset_version:${asset.assetVersionId}`);
  }
  for (const reference of [...snapshot.attachments, ...snapshot.references]) {
    refs.add(`asset:${reference.assetId}`);
    refs.add(`asset_version:${reference.assetVersionId}`);
  }
  return [...refs];
}

/**
 * Execution fence for the denormalized o_agent_message.referenceRefs column.
 * A legacy/unknown snapshot may only accompany an empty ref list; a v1
 * snapshot must pass its digest check and derive exactly the stored refs.
 */
export function agentMessageReferenceRefsMatchContextSnapshot(
  referenceRefs: unknown,
  contextSnapshot: unknown,
): boolean {
  if (!Array.isArray(referenceRefs) || referenceRefs.some((ref) => typeof ref !== "string")) return false;
  const parsed = snapshotSchema.safeParse(contextSnapshot);
  // Only an actually absent snapshot is a legacy message. A present but
  // malformed/tampered snapshot must fail closed even when it happens not to
  // contain resource refs; otherwise style/skill-only snapshots can bypass
  // the digest fence.
  if (!parsed.success) return contextSnapshot == null && referenceRefs.length === 0;
  const { digest, ...base } = parsed.data;
  if (snapshotDigest(base) !== digest) return false;
  const expected = uniqueReferenceRefs(parsed.data as AgentMessageContextSnapshot);
  return expected.length === referenceRefs.length
    && expected.every((ref, index) => referenceRefs[index] === ref);
}

/**
 * A usage marker is authored only after a model-backed Run succeeds. It binds
 * the assistant response to the exact confirmed snapshot without copying
 * private Registry hashes or provenance into assistant metadata.
 */
export function agentMessageContextUsageFromSnapshot(
  value: unknown,
): PublicAgentMessageContextUsage | null {
  const snapshot = publicAgentMessageContextSnapshot(value);
  return snapshot
    ? {
        schemaVersion: AGENT_MESSAGE_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
        status: "used",
        digest: snapshot.digest,
      }
    : null;
}

export function publicAgentMessageContextUsage(
  value: unknown,
): PublicAgentMessageContextUsage | null {
  const parsed = contextUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function resolveAgentMessageContextSnapshot(input: {
  workspaceId: string;
  actorUserId: number;
  threadId: string;
  context?: AgentMessageContextInput;
  attachments?: readonly AgentMessageContextAttachmentInput[];
  skills?: readonly AgentSkillPreferenceSnapshotRef[];
  database?: Knex | Knex.Transaction;
}): Promise<{ snapshot: AgentMessageContextSnapshot; referenceRefs: string[] }> {
  // Pure snapshot readers and callers with an injected transaction must not
  // start the process-wide database migration. When the singleton is needed,
  // await its initialization so no migration/import work can outlive this
  // operation (notably during test-environment teardown).
  const database = input.database ?? await loadReadyDefaultDatabase();
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) {
    throw new AgentRuntimeError(403, "message_context_actor_invalid", "当前用户身份无效");
  }
  const requested = normalizeAgentMessageContextInput(input.context);
  const thread = await (database as any)("o_agent_thread")
    .where({ id: input.threadId, workspaceId: input.workspaceId })
    .select("id", "projectId", "sessionId")
    .first();
  if (!thread) throw new AgentRuntimeError(404, "thread_not_found", "Agent Thread 不存在");

  const projectId = Number(thread.projectId);
  const project = await (database as any)("o_project")
    .where({ id: projectId, workspaceId: input.workspaceId })
    .select("id", "artStyle", "revision")
    .first();
  if (!project) throw new AgentRuntimeError(404, "project_not_found", "项目不存在");

  let sessionVersion = 1;
  let sessionStyle: string | null = null;
  let selectedAssetVersionIds: string[] = [];
  if (thread.sessionId != null) {
    const session = await (database as any)("o_creation_session")
      .where({
        id: String(thread.sessionId),
        workspaceId: input.workspaceId,
        projectId,
        status: "active",
      })
      .whereNull("archivedAt")
      .select("parameters", "selectedAssetVersionIds", "version")
      .first();
    if (!session) {
      throw new AgentRuntimeError(
        409,
        "message_context_session_invalid",
        "Thread 绑定的创作会话不存在或已失效，请刷新后重试",
      );
    }
    const parameters = parseStoredRecord(session.parameters, "message_context_session_invalid");
    selectedAssetVersionIds = parseStoredStringArray(
      session.selectedAssetVersionIds,
      "message_context_session_invalid",
    );
    sessionVersion = positiveVersion(session.version);
    sessionStyle = typeof parameters.style === "string" ? nullableText(parameters.style) : null;
  }

  const projectStyle = nullableText(project.artStyle);
  let style: AgentMessageContextSnapshotStyle | null = sessionStyle
    ? { value: sessionStyle, source: "creation_session", sourceVersion: sessionVersion }
    : projectStyle
      ? { value: projectStyle, source: "project", sourceVersion: positiveVersion(project.revision) }
      : null;
  if (typeof requested.style === "string" && requested.style) {
    if (style && requested.style !== style.value) {
      throw new AgentRuntimeError(
        409,
        "message_style_conflict",
        "所选风格与服务端创作上下文不一致，请刷新后重试",
      );
    }
    if (!style) {
      style = { value: requested.style, source: "request", sourceVersion: null };
    }
  }

  const assetIds = requested.assetRefs.map((ref) => ref.assetId);
  const assetRows = assetIds.length > 0
    ? await (database as any)("o_assets as asset")
        .innerJoin("o_project_asset_ref as ref", "ref.assetId", "asset.id")
        .where({ "ref.projectId": projectId, "ref.workspaceId": input.workspaceId })
        .whereNull("ref.removedAt")
        .whereIn("asset.id", assetIds)
        .distinct()
        .select({ id: "asset.id", name: "asset.name", type: "asset.type", imageId: "asset.imageId" }) as AssetRow[]
    : [];
  const assetRowsById = new Map(assetRows.map((row) => [Number(row.id), row]));
  if (assetRowsById.size !== assetIds.length || assetIds.some((id) => !assetRowsById.has(id))) {
    throw new AgentRuntimeError(404, "message_asset_not_found", "所选资产不存在或不属于当前项目");
  }

  const confirmedAttachmentInputs = (input.attachments ?? []).flatMap((attachment) => {
    const assetVersionId = optionalCanonicalPositiveId(attachment.assetRef);
    return assetVersionId ? [{ attachment, assetVersionId }] : [];
  });
  const attachmentVersionIds = confirmedAttachmentInputs.map((entry) => entry.assetVersionId);
  // Old CreationSession write paths accepted arbitrary strings. Only a safe,
  // canonical positive integer may become a confirmed reference; opaque
  // values are ignored for lookup/execution and represented solely by the
  // non-reversible digest below.
  const sessionVersionIds = selectedAssetVersionIds.flatMap((id) => {
    const canonical = optionalCanonicalPositiveId(id);
    return canonical ? [canonical] : [];
  });
  const sessionSelectionDigests = selectedAssetVersionIds.map(sessionSelectionDigest);
  const currentAssetVersionIdsByAssetId = new Map<number, string>();
  for (const row of assetRows) {
    if (row.imageId == null || row.imageId === "") continue;
    currentAssetVersionIdsByAssetId.set(Number(row.id), canonicalPositiveId(
      row.imageId,
      409,
      "message_context_asset_invalid",
      "资产当前版本无效，请刷新后重试",
    ));
  }
  const currentAssetVersionIds = [...currentAssetVersionIdsByAssetId.values()];
  const allVersionIds = [...new Set([
    ...attachmentVersionIds,
    ...sessionVersionIds,
    ...currentAssetVersionIds,
  ])];
  const versionRows = allVersionIds.length > 0
    ? await (database as any)("o_image as asset_version")
        .innerJoin("o_assets as asset", "asset.id", "asset_version.assetsId")
        .whereIn("asset_version.id", allVersionIds.map(Number))
        .select({
          id: "asset_version.id",
          assetId: "asset.id",
          assetName: "asset.name",
          assetKind: "asset.type",
          versionKind: "asset_version.type",
        }) as AssetVersionRow[]
    : [];
  const versionRowsById = new Map(versionRows.map((row) => [String(Number(row.id)), row]));

  if (attachmentVersionIds.some((id) => !versionRowsById.has(id))) {
    throw new AgentRuntimeError(404, "message_attachment_not_found", "附件资产不存在或不属于当前项目");
  }
  if (sessionVersionIds.some((id) => !versionRowsById.has(id))) {
    throw new AgentRuntimeError(
      409,
      "message_context_reference_invalid",
      "创作会话引用的资产不存在或不属于当前项目，请刷新后重试",
    );
  }
  for (const [assetId, versionId] of currentAssetVersionIdsByAssetId) {
    const currentVersion = versionRowsById.get(versionId);
    if (!currentVersion || Number(currentVersion.assetId) !== assetId) {
      throw new AgentRuntimeError(
        409,
        "message_context_asset_invalid",
        "资产当前版本不存在或不属于该资产，请刷新后重试",
      );
    }
  }

  const assertPermission = async (inputPermission: {
    assetId: number;
    assetVersionId: string | null;
    unavailableCode: string;
    deniedCode: string;
    deniedStatus: number;
    deniedMessage: string;
  }): Promise<void> => {
    const { AssetLibraryError, assertProjectAssetReferencePermission } =
      await import("@/lib/accountWorkspaceAssetLibrary");
    try {
      await assertProjectAssetReferencePermission({
        database,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        projectId,
        assetId: inputPermission.assetId,
        assetVersionId: inputPermission.assetVersionId,
        permission: "use",
      });
    } catch (error) {
      if (error instanceof AssetLibraryError) {
        throw new AgentRuntimeError(
          error.status === 503 ? 503 : inputPermission.deniedStatus,
          error.status === 503 ? inputPermission.unavailableCode : inputPermission.deniedCode,
          error.status === 503
            ? "账号与工作区资产库尚未完成数据库升级"
            : inputPermission.deniedMessage,
        );
      }
      throw error;
    }
  };

  for (const assetId of assetIds) {
    await assertPermission({
      assetId,
      assetVersionId: currentAssetVersionIdsByAssetId.get(assetId) ?? null,
      unavailableCode: "message_asset_library_unavailable",
      deniedCode: "message_asset_not_found",
      deniedStatus: 404,
      deniedMessage: "所选资产不存在、未加入当前项目或当前账号无权使用",
    });
  }
  for (const { assetVersionId } of confirmedAttachmentInputs) {
    const row = versionRowsById.get(assetVersionId)!;
    await assertPermission({
      assetId: Number(row.assetId),
      assetVersionId,
      unavailableCode: "message_asset_library_unavailable",
      deniedCode: "message_attachment_not_found",
      deniedStatus: 404,
      deniedMessage: "附件资产不存在、未加入当前项目或当前账号无权使用",
    });
  }
  for (const assetVersionId of sessionVersionIds) {
    const row = versionRowsById.get(assetVersionId)!;
    await assertPermission({
      assetId: Number(row.assetId),
      assetVersionId,
      unavailableCode: "message_asset_library_unavailable",
      deniedCode: "message_context_reference_invalid",
      deniedStatus: 409,
      deniedMessage: "创作会话引用的资产不存在、未加入当前项目或当前账号无权使用，请刷新后重试",
    });
  }

  const assets: AgentMessageContextSnapshotAsset[] = assetIds.map((assetId) => {
    const row = assetRowsById.get(assetId)!;
    const assetVersionId = currentAssetVersionIdsByAssetId.get(assetId) ?? null;
    return {
      assetId,
      assetVersionId,
      name: nullableText(row.name),
      kind: nullableText(row.type),
    };
  });
  const attachments: AgentMessageContextSnapshotReference[] = confirmedAttachmentInputs.map(({ attachment, assetVersionId: versionId }) => {
    const row = versionRowsById.get(versionId)!;
    return {
      assetId: Number(row.assetId),
      assetVersionId: versionId,
      // A caller-controlled filename is only a legacy fallback. Once an
      // assetRef resolves, the database asset name is the confirmed label.
      name: nullableText(row.assetName) ?? nullableText(attachment.name),
      kind: nullableText(row.versionKind) ?? nullableText(row.assetKind) ?? attachment.kind,
      source: "message" as const,
    };
  });
  const references: AgentMessageContextSnapshotReference[] = sessionVersionIds.map((versionId) => {
    const row = versionRowsById.get(versionId)!;
    return {
      assetId: Number(row.assetId),
      assetVersionId: versionId,
      name: nullableText(row.assetName),
      kind: nullableText(row.versionKind) ?? nullableText(row.assetKind),
      source: "creation_session",
    };
  });
  const skills: AgentMessageContextSnapshotSkill[] = (input.skills ?? []).map((skill) => ({
    key: skill.key,
    version: skill.version,
    displayName: nullableText(skill.displayName) ?? skill.key,
    contentHash: skill.contentHash,
  }));
  const generationPreferences = await resolveGenerationPreferences({
    workspaceId: input.workspaceId,
    requested: requested.generationPreferences,
    database,
  });

  const base = snapshotBaseSchema.parse({
    schemaVersion: AGENT_MESSAGE_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    status: "confirmed",
    sessionSelectionDigests,
    assets,
    attachments,
    references,
    skills,
    style,
    ...(generationPreferences ? { generationPreferences } : {}),
  });
  const snapshot: AgentMessageContextSnapshot = { ...base, digest: snapshotDigest(base) };
  return { snapshot, referenceRefs: uniqueReferenceRefs(snapshot) };
}

/**
 * Public DTO deliberately drops Registry content hashes and internal
 * provenance/version fields. Invalid or pre-snapshot metadata maps to null so
 * old messages remain readable.
 */
export function publicAgentMessageContextSnapshot(value: unknown): PublicAgentMessageContextSnapshot | null {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  const { digest, ...base } = parsed.data;
  if (snapshotDigest(base) !== digest) return null;
  const publicReference = (reference: z.infer<typeof snapshotReferenceSchema>) => ({
    assetVersionId: reference.assetVersionId,
    assetId: reference.assetId,
    name: reference.name ?? `资产 ${reference.assetId}`,
    kind: reference.kind,
  });
  return {
    schemaVersion: parsed.data.schemaVersion,
    status: parsed.data.status,
    digest,
    assets: parsed.data.assets.map((asset) => ({
      assetId: asset.assetId,
      assetVersionId: asset.assetVersionId,
      name: asset.name ?? `资产 ${asset.assetId}`,
      kind: asset.kind,
    })),
    attachments: parsed.data.attachments.map(publicReference),
    references: parsed.data.references.map(publicReference),
    skills: parsed.data.skills.map((skill) => ({
      key: skill.key,
      version: skill.version,
      displayName: skill.displayName,
    })),
    style: parsed.data.style?.value ?? null,
    ...(parsed.data.generationPreferences
      ? { generationPreferences: parsed.data.generationPreferences }
      : {}),
  };
}
