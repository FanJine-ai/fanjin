import { MembershipError } from "@/lib/membershipCatalog";
import crypto from "node:crypto";
import express from "express";
import type { Knex } from "knex";
import { z } from "zod";

import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  beginDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
  mutateDurableCommandCheckpoint,
  type DurableCommandReservation,
} from "@/lib/durableCommandIdempotency";
import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
} from "@/lib/durableObjectWrite";
import { insertAndReturnId } from "@/lib/dbDialect";
import { resolveProjectAssetVersion } from "@/lib/projectAssetVersion";
import {
  commitObjectWriteIntentInTransaction,
  createObjectWriteMediaReferenceEvidence,
  getObjectWriteIntent,
  type ObjectWriteIntentClaim,
} from "@/lib/objectWriteIntent";
import { normalizeObjectKey } from "@/lib/objectStorage";
import {
  renderProjectFinalVideo,
  resolveFinalRenderDimensions,
} from "@/lib/projectFinalRender";
import { shouldQuarantineRelayArtifacts } from "@/lib/relayMockPolicy";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import u from "@/utils";
import { db } from "@/utils/db";

const router = express.Router();

const MAX_COMPOSE_CLIPS = 100;
const MAX_CLIP_SECONDS = 24 * 60 * 60;
const TASK_CLASS = "Canvas 视频合成";
const RENDER_MODEL = "ffmpeg";
const COMMAND_SCOPE = "workbench:canvas:compose-video";

const timelineSecondsSchema = z.number()
  .finite()
  .min(0)
  .max(MAX_CLIP_SECONDS);

const clipSchema = z.object({
  assetVersionId: z.number().int().positive(),
  trimStartSeconds: timelineSecondsSchema,
  trimEndSeconds: timelineSecondsSchema,
  speed: z.number().finite().min(0.25).max(4),
  volume: z.number().finite().min(0).max(2),
}).strict().superRefine((clip, context) => {
  if (clip.trimEndSeconds - clip.trimStartSeconds < 0.05) {
    context.addIssue({
      code: "custom",
      path: ["trimEndSeconds"],
      message: "视频片段裁剪后至少保留 0.05 秒",
    });
  }
});

type RequestedClip = z.infer<typeof clipSchema>;

type ControlledClip = RequestedClip & {
  assetId: number;
  storageKey: string;
  state: string;
  type: "clip" | "video";
  sourceDurationSeconds: number | null;
};

type ComposeSnapshot = {
  version: "canvas-video-compose-selection.v1";
  workspaceId: string;
  projectId: number;
  ratio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  clips: ControlledClip[];
};

type ComposeAuthority = {
  projectName: string;
  snapshot: ComposeSnapshot;
};

type RenderMetadata = {
  width: number;
  height: number;
  durationMs: number;
  audioIncluded: boolean;
};

type StoredObject = {
  url: string;
  claim: ObjectWriteIntentClaim;
};

type ComposeCheckpoint = {
  version: "canvas-video-compose-command.v1";
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  snapshotHash: string;
  composeIdentity: string;
  mediaAssetId: string;
  taskId: number | null;
  object: {
    attempt: number;
    intentId: string;
    storageKey: string;
    rendered: RenderMetadata | null;
    stored: StoredObject | null;
  };
};

type PublicComposeAsset = {
  id: string;
  taskId: string;
  assetId: number;
  assetVersionId: number;
  url: string;
  width: number;
  height: number;
  durationMs: number;
  createdAt: number;
};

type ComposeOutcome =
  | {
      kind: "success";
      data: {
        asset: PublicComposeAsset;
        reused: false;
      };
    }
  | {
      kind: "error";
      code: string;
      message: string;
    };

const renderMetadataSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  audioIncluded: z.boolean(),
}).strict();

const checkpointSchema = z.object({
  version: z.literal("canvas-video-compose-command.v1"),
  workspaceId: z.string().min(1),
  actorUserId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  composeIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  mediaAssetId: z.string().uuid(),
  taskId: z.number().int().positive().nullable(),
  object: z.object({
    attempt: z.number().int().positive().max(100),
    intentId: z.string().min(1).max(200),
    storageKey: z.string().min(1).max(1024),
    rendered: renderMetadataSchema.nullable(),
    stored: z.object({
      url: z.string().min(1).max(4096),
      claim: z.object({
        id: z.string().min(1).max(200),
        owner: z.string().min(1).max(255),
        fence: z.number().int().positive(),
      }).strict(),
    }).strict().nullable(),
  }).strict(),
}).strict();

const publicAssetSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().min(1),
  assetId: z.number().int().positive(),
  assetVersionId: z.number().int().positive(),
  url: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  createdAt: z.number().int().positive(),
}).strict();

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("success"),
    data: z.object({
      asset: publicAssetSchema,
      reused: z.literal(false),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("error"),
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict(),
]);

class ComposeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ComposeRequestError";
  }
}

class ComposeRecoveryRequiredError extends Error {
  constructor(message = "Canvas 视频合成正在恢复，请使用相同 Idempotency-Key 重试") {
    super(message);
    this.name = "ComposeRecoveryRequiredError";
  }
}

class ComposeSourceChangedError extends Error {
  readonly status = 409;
  readonly code = "canvas_compose_source_changed";

  constructor() {
    super("合成源资产已变化，请刷新画布并使用新的 Idempotency-Key");
    this.name = "ComposeSourceChangedError";
  }
}

function uuidFromDigest(digest: string): string {
  const value = digest.slice(0, 32).split("");
  value[12] = "4";
  value[16] = ((Number.parseInt(value[16], 16) & 0x3) | 0x8).toString(16);
  return [
    value.slice(0, 8).join(""),
    value.slice(8, 12).join(""),
    value.slice(12, 16).join(""),
    value.slice(16, 20).join(""),
    value.slice(20, 32).join(""),
  ].join("-");
}

function objectIdentity(
  projectId: number,
  composeIdentity: string,
  attempt: number,
): { intentId: string; storageKey: string } {
  const suffix = crypto
    .createHash("sha256")
    .update(`${composeIdentity}:${attempt}`)
    .digest("hex")
    .slice(0, 24);
  const intentId = `canvas-video-compose-${suffix}`;
  return {
    intentId,
    storageKey: `${projectId}/canvas/compositions/${intentId}.mp4`,
  };
}

function parseOutcome(value: unknown): ComposeOutcome {
  const parsed = outcomeSchema.safeParse(value);
  if (!parsed.success) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_record_invalid",
      "Canvas 视频合成幂等响应格式无效",
    );
  }
  return parsed.data;
}

function sendOutcome(
  res: express.Response,
  outcome: ComposeOutcome,
  status: number,
) {
  if (outcome.kind === "success") {
    return res.status(status).send(success(outcome.data));
  }
  return res.status(status).send({
    code: outcome.code,
    message: outcome.message,
  });
}

function parseCheckpoint(
  value: unknown,
  expected: {
    workspaceId: string;
    actorUserId: number;
    projectId: number;
    composeIdentity: string;
    mediaAssetId: string;
  },
): ComposeCheckpoint {
  const parsed = checkpointSchema.safeParse(value);
  const checkpoint = parsed.success ? parsed.data : null;
  const expectedObject = checkpoint
    ? objectIdentity(
        expected.projectId,
        expected.composeIdentity,
        checkpoint.object.attempt,
      )
    : null;
  if (
    !checkpoint
    || checkpoint.workspaceId !== expected.workspaceId
    || checkpoint.actorUserId !== expected.actorUserId
    || checkpoint.projectId !== expected.projectId
    || checkpoint.composeIdentity !== expected.composeIdentity
    || checkpoint.mediaAssetId !== expected.mediaAssetId
    || checkpoint.object.intentId !== expectedObject?.intentId
    || normalizeObjectKey(checkpoint.object.storageKey)
      !== expectedObject?.storageKey
    || (
      checkpoint.object.stored !== null
      && (
        checkpoint.object.rendered === null
        || checkpoint.object.stored.claim.id !== checkpoint.object.intentId
      )
    )
  ) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_checkpoint_invalid",
      "Canvas 视频合成恢复检查点无效",
    );
  }
  return checkpoint;
}

function initialCheckpoint(input: {
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  snapshotHash: string;
  composeIdentity: string;
  mediaAssetId: string;
}): ComposeCheckpoint {
  return {
    version: "canvas-video-compose-command.v1",
    ...input,
    taskId: null,
    object: {
      attempt: 1,
      ...objectIdentity(input.projectId, input.composeIdentity, 1),
      rendered: null,
      stored: null,
    },
  };
}

function taskRelatedObjects(input: {
  snapshotHash: string;
  mediaAssetId?: string;
  assetId?: number;
  assetVersionId?: number;
}) {
  return JSON.stringify({
    version: "canvas-video-compose-task.v1",
    snapshotHash: input.snapshotHash,
    ...(input.mediaAssetId ? { mediaAssetId: input.mediaAssetId } : {}),
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(input.assetVersionId ? { assetVersionId: input.assetVersionId } : {}),
  });
}

function normalizedStorageKey(row: {
  storageKey?: unknown;
  filePath?: unknown;
}): string {
  const raw = String(row.storageKey || row.filePath || "").trim();
  if (!raw) return "";
  try {
    return normalizeObjectKey(raw);
  } catch {
    return "";
  }
}

async function loadComposeAuthority(
  database: Knex | Knex.Transaction,
  input: {
    workspaceId: string;
    actorUserId: number;
    projectId: number;
    ratio: ComposeSnapshot["ratio"];
    clips: RequestedClip[];
    lock?: boolean;
  },
): Promise<ComposeAuthority> {
  let projectQuery = database("o_project")
    .where({
      id: input.projectId,
      workspaceId: input.workspaceId,
    })
    .select("id", "name", "deletionState");
  if (input.lock) projectQuery = projectQuery.forUpdate();
  const project = await projectQuery.first();
  if (!project) {
    throw new ComposeRequestError(404, "project_not_found", "项目不存在");
  }
  if (String(project.deletionState || "active") !== "active") {
    throw new ComposeRequestError(
      409,
      "project_not_active",
      "项目正在删除或已不可用",
    );
  }

  const versionIds = Array.from(new Set(
    input.clips.map((clip) => clip.assetVersionId),
  ));
  const authorizedVersions = await Promise.all(versionIds.map((assetVersionId) => resolveProjectAssetVersion({
    database, workspaceId: input.workspaceId, projectId: input.projectId,
    actorUserId: input.actorUserId, assetVersionId,
  })));
  const sourceProjectByVersion = new Map(authorizedVersions.flatMap((version) => (
    version ? [[version.id, version.sourceProjectId] as const] : []
  )));
  let versionQuery = database("o_image as version")
    .innerJoin("o_assets as asset", "asset.id", "version.assetsId")
    .whereIn("version.id", [...sourceProjectByVersion.keys()])
    .where({
      "asset.deletionState": "active",
      "version.deletionState": "active",
    })
    .whereIn("version.type", ["clip", "video"])
    .whereRaw("asset.type = version.type")
    .select(
      "version.id as assetVersionId",
      "version.assetsId as assetId",
      "version.storageKey",
      "version.filePath",
      "version.state",
      "version.type",
    );
  if (input.lock) versionQuery = versionQuery.forUpdate();
  const versions = await versionQuery;
  const versionById = new Map<number, any>(
    versions.map((version: any) => [Number(version.assetVersionId), version]),
  );

  const storageKeys = versions
    .map((version: any) => normalizedStorageKey(version))
    .filter(Boolean);
  const durationsByStorageKey = new Map<string, number>();
  const quarantinedStorageKeys = new Set<string>();
  if (storageKeys.length) {
    let mediaQuery = database("o_media_asset as media")
      .where({
        "media.workspaceId": input.workspaceId,
        "media.assetType": "video",
      })
      .whereIn("media.projectId", [...new Set(sourceProjectByVersion.values())])
      .whereIn("media.storageKey", storageKeys)
      .select(
        "media.storageKey",
        "media.taskId",
        "media.durationMs",
        "media.createTime",
      )
      .orderBy("media.createTime", "desc");
    if (input.lock) mediaQuery = mediaQuery.forUpdate();
    const mediaRows = await mediaQuery;
    const relayTaskIds = Array.from(new Set(
      mediaRows.map((media: any) => String(media.taskId || "").trim())
        .filter(Boolean),
    ));
    const relayRows = relayTaskIds.length
      ? await database("o_relay_task")
        .whereIn("id", relayTaskIds)
        .select("id", "status")
      : [];
    const relayStatusByTaskId = new Map(
      relayRows.map((relay: any) => [
        String(relay.id),
        String(relay.status || ""),
      ]),
    );
    for (const media of mediaRows) {
      const key = normalizedStorageKey(media);
      const relayStatus = relayStatusByTaskId.get(
        String(media.taskId || ""),
      );
      if (key && shouldQuarantineRelayArtifacts(relayStatus)) {
        quarantinedStorageKeys.add(key);
        continue;
      }
      const durationMs = Number(media.durationMs || 0);
      if (
        key
        && !durationsByStorageKey.has(key)
        && Number.isFinite(durationMs)
        && durationMs > 0
        && durationMs <= MAX_CLIP_SECONDS * 1_000
      ) {
        durationsByStorageKey.set(key, durationMs / 1_000);
      }
    }
  }

  const controlledClips = input.clips.map((clip): ControlledClip => {
    const version = versionById.get(clip.assetVersionId);
    const storageKey = version ? normalizedStorageKey(version) : "";
    const sourceDurationSeconds = durationsByStorageKey.get(storageKey) ?? null;
    if (
      !version
      || !["已完成", "生成成功"].includes(String(version.state || ""))
      || !storageKey
      || quarantinedStorageKeys.has(storageKey)
      || !storageKey.startsWith(`${sourceProjectByVersion.get(clip.assetVersionId)}/`)
    ) {
      throw new ComposeRequestError(
        422,
        "canvas_compose_clip_invalid",
        `素材版本 ${clip.assetVersionId} 不可使用或未进入受控存储`,
      );
    }
    if (
      sourceDurationSeconds !== null
      && clip.trimEndSeconds > sourceDurationSeconds + 0.05
    ) {
      throw new ComposeRequestError(
        422,
        "canvas_compose_trim_invalid",
        `素材版本 ${clip.assetVersionId} 的裁剪范围超过源视频时长`,
      );
    }
    return {
      ...clip,
      assetId: Number(version.assetId),
      storageKey,
      state: String(version.state),
      type: String(version.type) as "clip" | "video",
      sourceDurationSeconds,
    };
  });
  const totalDurationSeconds = controlledClips.reduce(
    (sum, clip) => sum
      + (clip.trimEndSeconds - clip.trimStartSeconds) / clip.speed,
    0,
  );
  if (totalDurationSeconds > MAX_CLIP_SECONDS) {
    throw new ComposeRequestError(
      422,
      "canvas_compose_duration_too_long",
      "Canvas 合成视频总时长不能超过 24 小时",
    );
  }

  return {
    projectName: String(project.name || "项目"),
    snapshot: {
      version: "canvas-video-compose-selection.v1",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ratio: input.ratio,
      clips: controlledClips,
    },
  };
}

function renderMetadata(
  dimensions: { width: number; height: number },
  clips: ControlledClip[],
  audioIncluded: boolean,
): RenderMetadata {
  return {
    width: dimensions.width,
    height: dimensions.height,
    durationMs: Math.max(1, Math.round(clips.reduce(
      (sum, clip) => sum
        + ((clip.trimEndSeconds - clip.trimStartSeconds) / clip.speed) * 1_000,
      0,
    ))),
    audioIncluded,
  };
}

async function completeFailedCommand(input: {
  reservation: DurableCommandReservation<ComposeOutcome>;
  expected: Parameters<typeof parseCheckpoint>[1];
  status: number;
  code: string;
  message: string;
}): Promise<{ outcome: ComposeOutcome; status: number }> {
  if (input.reservation.kind !== "resume") {
    throw new ComposeRecoveryRequiredError();
  }
  const reservation = input.reservation;
  const outcome: ComposeOutcome = {
    kind: "error",
    code: input.code,
    message: input.message,
  };
  return await db.transaction(async (transaction) => {
    const row = await transaction("o_agent_idempotency")
      .where({ id: reservation.id })
      .forUpdate()
      .select("status", "responseStatus", "responseBody")
      .first();
    if (!row) throw new ComposeRecoveryRequiredError();
    if (String(row.status) === "completed") {
      return {
        outcome: parseOutcome(JSON.parse(String(row.responseBody || ""))),
        status: Number(row.responseStatus || 200),
      };
    }
    const checkpoint = parseCheckpoint(
      JSON.parse(String(row.responseBody || "")),
      input.expected,
    );
    if (checkpoint.taskId) {
      const task = await transaction("o_tasks")
        .where({
          id: checkpoint.taskId,
          projectId: checkpoint.projectId,
          taskClass: TASK_CLASS,
        })
        .forUpdate()
        .select("id", "state")
        .first();
      if (!task) throw new ComposeRecoveryRequiredError();
      if (String(task.state) === "进行中") {
        const updated = await transaction("o_tasks")
          .where({
            id: checkpoint.taskId,
            projectId: checkpoint.projectId,
            state: "进行中",
          })
          .update({
            state: "生成失败",
            reason: input.message,
          });
        if (Number(updated) !== 1) throw new ComposeRecoveryRequiredError();
      } else if (String(task.state) !== "生成失败") {
        throw new ComposeRecoveryRequiredError();
      }
    }
    await completeDurableCommand(
      {
        kind: "resume",
        id: reservation.id,
        checkpoint,
      },
      outcome,
      input.status,
      { database: transaction as any },
    );
    return { outcome, status: input.status };
  });
}

async function queueCheckpointObjectCompensation(
  checkpoint: ComposeCheckpoint,
): Promise<boolean> {
  const intent = await getObjectWriteIntent(
    checkpoint.object.intentId,
    { database: db },
  );
  if (!intent || intent.status === "compensated") return true;
  if ([
    "compensation_pending",
    "compensating",
    "dead",
  ].includes(intent.status)) {
    return true;
  }
  if (intent.status === "committed") return false;
  const claim = checkpoint.object.stored?.claim
    ?? (
      intent.leaseOwner
        ? {
            id: intent.id,
            owner: intent.leaseOwner,
            fence: intent.leaseFence,
          }
        : null
    );
  if (!claim) return false;
  try {
    await queueDurableObjectWriteCompensation(
      claim,
      Object.assign(new Error("canvas compose source changed"), {
        code: "CANVAS_COMPOSE_SOURCE_CHANGED",
      }),
      { database: db },
    );
    return true;
  } catch {
    const current = await getObjectWriteIntent(
      checkpoint.object.intentId,
      { database: db },
    ).catch(() => null);
    return Boolean(current && [
      "compensation_pending",
      "compensating",
      "compensated",
      "dead",
    ].includes(current.status));
  }
}

async function terminalizeExistingSourceChangedCommand(input: {
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  ratio: ComposeSnapshot["ratio"];
  clips: RequestedClip[];
  idempotencyKey: string;
  expected: Parameters<typeof parseCheckpoint>[1];
}): Promise<
  | { kind: "completed"; outcome: ComposeOutcome; status: number }
  | { kind: "recovery" }
  | null
> {
  const scopeKey = [
    COMMAND_SCOPE,
    input.workspaceId,
    input.actorUserId,
  ].join(":");
  const requestHash = hashIdempotencyRequest({
    projectId: input.projectId,
    ratio: input.ratio,
    clips: input.clips,
  });
  const command = await db("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      scopeKey,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      status: "checkpointed",
    })
    .select("id", "responseBody")
    .first();
  if (!command) return null;
  let checkpoint: ComposeCheckpoint;
  try {
    checkpoint = parseCheckpoint(
      JSON.parse(String(command.responseBody || "")),
      input.expected,
    );
  } catch {
    return { kind: "recovery" };
  }
  const safeToTerminalize = await queueCheckpointObjectCompensation(
    checkpoint,
  ).catch(() => false);
  if (!safeToTerminalize) return { kind: "recovery" };
  try {
    const completed = await completeFailedCommand({
      reservation: {
        kind: "resume",
        id: String(command.id),
        checkpoint,
      },
      expected: input.expected,
      status: 409,
      code: "canvas_compose_source_changed",
      message: "合成源资产已变化，请刷新画布并使用新的 Idempotency-Key",
    });
    return {
      kind: "completed",
      outcome: completed.outcome,
      status: completed.status,
    };
  } catch {
    return { kind: "recovery" };
  }
}

async function replayCompletedCommand(input: {
  workspaceId: string;
  actorUserId: number;
  idempotencyKey: string;
  request: {
    projectId: number;
    ratio: ComposeSnapshot["ratio"];
    clips: RequestedClip[];
  };
}): Promise<{ outcome: ComposeOutcome; status: number } | null> {
  const scopeKey = [
    COMMAND_SCOPE,
    input.workspaceId,
    input.actorUserId,
  ].join(":");
  const row = await db("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      scopeKey,
      idempotencyKey: input.idempotencyKey,
    })
    .where("expiresAt", ">", Date.now())
    .select("requestHash", "status", "responseStatus", "responseBody")
    .first();
  if (!row) return null;
  if (String(row.requestHash) !== hashIdempotencyRequest(input.request)) {
    throw new DurableCommandIdempotencyError(
      409,
      "idempotency_conflict",
      "同一 Idempotency-Key 已被不同请求使用",
    );
  }
  if (String(row.status) !== "completed") return null;
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(String(row.responseBody || ""));
  } catch {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_record_invalid",
      "Canvas 视频合成幂等响应格式无效",
    );
  }
  return {
    outcome: parseOutcome(responseBody),
    status: Number(row.responseStatus || 200),
  };
}

export default router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    projectId: z.number().int().positive(),
    ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]),
    clips: z.array(clipSchema).min(1).max(MAX_COMPOSE_CLIPS),
  }),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const ratio = req.body.ratio as ComposeSnapshot["ratio"];
    const clips = req.body.clips as RequestedClip[];
    const workspaceId = String(
      (req as any).project?.workspaceId
      || (req as any).auth?.workspaceId
      || "",
    ).trim();
    const actorUserId = Number((req as any).auth?.user?.id || 0);
    const idempotencyKey = String(req.header("idempotency-key") || "").trim();
    if (!idempotencyKey) {
      return res.status(400).send({
        code: "idempotency_key_required",
        message: "Canvas 视频合成必须提供 Idempotency-Key，以便中断后安全恢复",
      });
    }
    const composeIdentity = crypto
      .createHash("sha256")
      .update(`${workspaceId}:${actorUserId}:${projectId}:${idempotencyKey}`)
      .digest("hex");
    const mediaAssetId = uuidFromDigest(
      crypto
        .createHash("sha256")
        .update(`${composeIdentity}:media-asset`)
        .digest("hex"),
    );
    const expected = {
      workspaceId,
      actorUserId,
      projectId,
      composeIdentity,
      mediaAssetId,
    };
    try {
      const replay = await replayCompletedCommand({
        workspaceId,
        actorUserId,
        idempotencyKey,
        request: { projectId, ratio, clips },
      });
      if (replay) return sendOutcome(res, replay.outcome, replay.status);
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }

    let authority: ComposeAuthority;
    try {
      authority = await loadComposeAuthority(db, {
        workspaceId,
        actorUserId,
        projectId,
        ratio,
        clips,
      });
    } catch (error) {
      if (error instanceof ComposeRequestError) {
        const terminalized = await terminalizeExistingSourceChangedCommand({
          workspaceId,
          actorUserId,
          projectId,
          ratio,
          clips,
          idempotencyKey,
          expected,
        }).catch(() => ({ kind: "recovery" as const }));
        if (terminalized?.kind === "completed") {
          return sendOutcome(
            res,
            terminalized.outcome,
            terminalized.status,
          );
        }
        if (terminalized?.kind === "recovery") {
          return res.status(503).send({
            code: "canvas_compose_recovery_required",
            message: "旧 Canvas 合成任务正在终止，请使用相同 Idempotency-Key 重试",
          });
        }
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }

    const snapshotHash = hashIdempotencyRequest(authority.snapshot);
    let reservation: DurableCommandReservation<ComposeOutcome>;
    try {
      reservation = await beginDurableCommand<ComposeOutcome>({
        workspaceId,
        actorUserId,
        scope: COMMAND_SCOPE,
        idempotencyKey,
        request: { projectId, ratio, clips },
        initialCheckpoint: initialCheckpoint({
          ...expected,
          snapshotHash,
        }),
      });
      if (reservation.kind === "replay") {
        return sendOutcome(
          res,
          parseOutcome(reservation.responseBody),
          reservation.responseStatus,
        );
      }
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
    if (reservation.kind !== "resume") {
      return res.status(500).send({
        code: "idempotency_checkpoint_invalid",
        message: "Canvas 视频合成命令未建立恢复检查点",
      });
    }
    let checkpoint = parseCheckpoint(reservation.checkpoint, expected);

    type Replayed = { outcome: ComposeOutcome; status: number };
    const advanceCheckpoint = async (
      mutate: (
        current: ComposeCheckpoint,
        transaction: Knex.Transaction,
      ) => Promise<ComposeCheckpoint>,
    ): Promise<Replayed | null> => {
      if (reservation.kind !== "resume") {
        throw new ComposeRecoveryRequiredError();
      }
      const advanced = await mutateDurableCommandCheckpoint<
        ComposeOutcome,
        ComposeCheckpoint
      >(reservation, async (current, transaction) => {
        return await mutate(parseCheckpoint(current, expected), transaction);
      });
      if (advanced.kind === "replay") {
        return {
          outcome: parseOutcome(advanced.responseBody),
          status: advanced.responseStatus,
        };
      }
      reservation = advanced;
      checkpoint = parseCheckpoint(advanced.checkpoint, expected);
      return null;
    };

    const terminalFailure = async (
      status: number,
      code: string,
      message: string,
    ) => {
      try {
        const completed = await completeFailedCommand({
          reservation,
          expected,
          status,
          code,
          message,
        });
        return sendOutcome(res, completed.outcome, completed.status);
      } catch {
        return res.status(503).send({
          code: "canvas_compose_recovery_required",
          message: "Canvas 视频合成失败状态待恢复，请使用相同 Idempotency-Key 重试",
        });
      }
    };

    if (checkpoint.snapshotHash !== snapshotHash) {
      const safeToTerminalize = await queueCheckpointObjectCompensation(
        checkpoint,
      ).catch(() => false);
      if (!safeToTerminalize) {
        return res.status(503).send({
          code: "canvas_compose_recovery_required",
          message: "旧合成对象正在清理，请稍后使用相同 Idempotency-Key 重试",
        });
      }
      return await terminalFailure(
        409,
        "canvas_compose_source_changed",
        "合成源资产已变化，请刷新画布并使用新的 Idempotency-Key",
      );
    }

    try {
      const replay = await advanceCheckpoint(async (current, transaction) => {
        if (current.taskId) {
          const task = await transaction("o_tasks")
            .where({
              id: current.taskId,
              projectId,
              taskClass: TASK_CLASS,
            })
            .forUpdate()
            .select("id", "state", "relatedObjects")
            .first();
          let related: Record<string, unknown> = {};
          try {
            related = JSON.parse(String(task?.relatedObjects || "{}"));
          } catch {
            related = {};
          }
          if (
            !task
            || String(related.snapshotHash || "") !== snapshotHash
            || !["进行中", "已完成", "生成失败"].includes(String(task.state || ""))
          ) {
            throw new DurableCommandIdempotencyError(
              409,
              "canvas_compose_task_conflict",
              "Canvas 视频合成任务恢复记录与项目不一致",
            );
          }
          return current;
        }
        const taskId = await insertAndReturnId(transaction, "o_tasks", {
          projectId,
          taskClass: TASK_CLASS,
          relatedObjects: taskRelatedObjects({ snapshotHash }),
          model: RENDER_MODEL,
          describe: `${authority.projectName} · Canvas 视频合成`,
          state: "进行中",
          startTime: Date.now(),
          reason: null,
        });
        const linked = await transaction("o_agent_idempotency")
          .where({
            id: reservation.kind === "resume" ? reservation.id : "",
            status: "checkpointed",
          })
          .update({
            resourceType: "canvas_video_compose_task",
            resourceId: String(taskId),
            updatedAt: Date.now(),
          });
        if (Number(linked) !== 1) {
          throw new DurableCommandIdempotencyError(
            409,
            "canvas_compose_task_conflict",
            "Canvas 视频合成任务与恢复命令绑定失败",
          );
        }
        return { ...current, taskId };
      });
      if (replay) return sendOutcome(res, replay.outcome, replay.status);
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      return res.status(503).send({
        code: "canvas_compose_recovery_required",
        message: "Canvas 视频合成任务初始化待恢复，请使用相同 Idempotency-Key 重试",
      });
    }

    let storedObject = checkpoint.object.stored;
    if (!storedObject) {
      let existingIntent;
      try {
        existingIntent = await getObjectWriteIntent(
          checkpoint.object.intentId,
          { database: db },
        );
      } catch {
        return res.status(503).send({
          code: "canvas_compose_recovery_required",
          message: "Canvas 合成对象状态读取失败，请使用相同 Idempotency-Key 重试",
        });
      }
      if (existingIntent?.status === "stored") {
        if (
          !checkpoint.object.rendered
          || existingIntent.objectKey !== checkpoint.object.storageKey
          || !existingIntent.leaseOwner
          || !existingIntent.leaseExpiresAt
          || existingIntent.leaseExpiresAt <= Date.now()
        ) {
          return res.status(503).send({
            code: "canvas_compose_recovery_required",
            message: "Canvas 合成对象正在等待安全恢复，请稍后重试",
          });
        }
        try {
          const recovered: StoredObject = {
            url: await u.oss.getFileUrl(checkpoint.object.storageKey),
            claim: {
              id: existingIntent.id,
              owner: existingIntent.leaseOwner,
              fence: existingIntent.leaseFence,
            },
          };
          const replay = await advanceCheckpoint(async (current) => ({
            ...current,
            object: {
              ...current.object,
              stored: recovered,
            },
          }));
          if (replay) return sendOutcome(res, replay.outcome, replay.status);
          storedObject = checkpoint.object.stored;
        } catch {
          return res.status(503).send({
            code: "canvas_compose_recovery_required",
            message: "Canvas 合成对象恢复检查点写入失败，请使用相同 Idempotency-Key 重试",
          });
        }
      } else if (existingIntent?.status === "compensated") {
        try {
          const replay = await advanceCheckpoint(async (current) => {
            const attempt = current.object.attempt + 1;
            if (attempt > 100) {
              throw new DurableCommandIdempotencyError(
                500,
                "canvas_compose_attempts_exhausted",
                "Canvas 视频合成对象恢复次数已达上限",
              );
            }
            return {
              ...current,
              object: {
                attempt,
                ...objectIdentity(projectId, composeIdentity, attempt),
                rendered: null,
                stored: null,
              },
            };
          });
          if (replay) return sendOutcome(res, replay.outcome, replay.status);
        } catch (error) {
          if (error instanceof DurableCommandIdempotencyError) {
            return res.status(error.status).send({
              code: error.code,
              message: error.message,
            });
          }
          return res.status(503).send({
            code: "canvas_compose_recovery_required",
            message: "Canvas 合成对象重试检查点写入失败，请使用相同 Idempotency-Key 重试",
          });
        }
      } else if (existingIntent) {
        return res.status(503).send({
          code: "canvas_compose_recovery_required",
          message: "Canvas 合成对象仍在写入或清理，请稍后重试",
        });
      }
    }

    if (!storedObject) {
      let rendered;
      try {
        const sourceBodies = await Promise.all(
          authority.snapshot.clips.map((clip) => u.oss.getFile(clip.storageKey)),
        );
        rendered = await renderProjectFinalVideo({
          clips: sourceBodies,
          ratio,
          clipDurationsSeconds: authority.snapshot.clips.map(
            (clip) => clip.sourceDurationSeconds ?? clip.trimEndSeconds,
          ),
          clipEdits: authority.snapshot.clips.map((clip) => ({
            trimStartSeconds: clip.trimStartSeconds,
            trimEndSeconds: clip.trimEndSeconds,
            speed: clip.speed,
            volume: clip.volume,
          })),
          strictClipEdits: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("ENOENT") || message.includes("NoSuchKey")) {
          return await terminalFailure(
            409,
            "canvas_compose_source_missing",
            "合成源视频文件不存在，请重新上传或生成后再试",
          );
        }
        if (message.includes("FINAL_RENDER_CLIP_EDIT_INVALID")) {
          return await terminalFailure(
            422,
            "canvas_compose_trim_invalid",
            "裁剪范围超过源视频时长，请刷新画布后重新设置",
          );
        }
        if (message.includes("FINAL_RENDER_PROBE_FAILED")) {
          return await terminalFailure(
            422,
            "canvas_compose_source_unreadable",
            "源视频无法读取，请重新上传或生成后再试",
          );
        }
        if (message.includes("FINAL_RENDER_TIMEOUT")) {
          return await terminalFailure(
            504,
            "canvas_compose_timeout",
            "Canvas 视频合成超时，请减少片段数量后重试",
          );
        }
        return await terminalFailure(
          500,
          "canvas_compose_failed",
          "Canvas 视频合成失败，请检查源视频格式后重试",
        );
      }

      const metadata = renderMetadata(
        rendered.dimensions,
        authority.snapshot.clips,
        rendered.audioIncluded,
      );
      if (
        checkpoint.object.rendered
        && JSON.stringify(checkpoint.object.rendered) !== JSON.stringify(metadata)
      ) {
        return await terminalFailure(
          409,
          "canvas_compose_output_changed",
          "相同时间线产生了不一致的输出参数，请使用新的 Idempotency-Key",
        );
      }
      try {
        const replay = await advanceCheckpoint(async (current) => ({
          ...current,
          object: {
            ...current.object,
            rendered: metadata,
          },
        }));
        if (replay) return sendOutcome(res, replay.outcome, replay.status);
      } catch {
        return res.status(503).send({
          code: "canvas_compose_recovery_required",
          message: "Canvas 渲染结果待恢复，请使用相同 Idempotency-Key 重试",
        });
      }

      let durable;
      try {
        durable = await writeObjectWithDurableIntent({
          purpose: "relay_final",
          acceptedGeneration: false,
          workspaceId,
          projectId,
          body: rendered.body,
          storageKey: () => checkpoint.object.storageKey,
          writerIdPrefix: `canvas-video-compose-${crypto.randomUUID()}`,
          putTimeoutMs: 30 * 60_000,
        }, {
          database: db,
          idFactory: () => checkpoint.object.intentId,
          writer: u.oss,
        });
      } catch (error) {
        if (error instanceof MembershipError) return res.status(error.status).send({ code: error.code, message: error.message });
        return res.status(503).send({
          code: "canvas_compose_recovery_required",
          message: "Canvas 合成对象正在写入或恢复，请使用相同 Idempotency-Key 重试",
        });
      }
      try {
        const stored: StoredObject = {
          url: durable.url,
          claim: durable.claim,
        };
        const replay = await advanceCheckpoint(async (current) => ({
          ...current,
          object: {
            ...current.object,
            stored,
          },
        }));
        if (replay) return sendOutcome(res, replay.outcome, replay.status);
        storedObject = checkpoint.object.stored;
      } catch {
        return res.status(503).send({
          code: "canvas_compose_recovery_required",
          message: "Canvas 合成对象已保存，正在恢复资产登记，请使用相同 Idempotency-Key 重试",
        });
      }
    }

    if (
      !storedObject
      || !checkpoint.object.rendered
      || !checkpoint.taskId
      || reservation.kind !== "resume"
    ) {
      return res.status(503).send({
        code: "canvas_compose_recovery_required",
        message: "Canvas 视频合成交付检查点不完整，请使用相同 Idempotency-Key 重试",
      });
    }

    try {
      const finalized = await db.transaction(async (transaction) => {
        const commandRow = await transaction("o_agent_idempotency")
          .where({ id: reservation.kind === "resume" ? reservation.id : "" })
          .forUpdate()
          .select("status", "responseStatus", "responseBody")
          .first();
        if (!commandRow) throw new ComposeRecoveryRequiredError();
        if (String(commandRow.status) === "completed") {
          return {
            outcome: parseOutcome(
              JSON.parse(String(commandRow.responseBody || "")),
            ),
            status: Number(commandRow.responseStatus || 200),
          };
        }
        const current = parseCheckpoint(
          JSON.parse(String(commandRow.responseBody || "")),
          expected,
        );
        if (
          !current.taskId
          || !current.object.rendered
          || !current.object.stored
        ) {
          throw new ComposeRecoveryRequiredError();
        }
        const currentAuthority = await loadComposeAuthority(transaction, {
          workspaceId,
          actorUserId,
          projectId,
          ratio,
          clips,
          lock: true,
        });
        if (
          hashIdempotencyRequest(currentAuthority.snapshot)
          !== current.snapshotHash
        ) {
          throw new ComposeSourceChangedError();
        }

        const createdAt = Date.now();
        const assetId = await insertAndReturnId(transaction, "o_assets", {
          type: "clip",
          projectId,
          name: `${authority.projectName} Canvas 合成`.slice(0, 80),
          prompt: null,
          startTime: createdAt,
        });
        const assetVersionId = await insertAndReturnId(
          transaction,
          "o_image",
          {
            filePath: current.object.storageKey,
            storageKey: current.object.storageKey,
            type: "clip",
            assetsId: assetId,
            model: RENDER_MODEL,
            resolution:
              `${current.object.rendered.width}x${current.object.rendered.height}`,
            state: "已完成",
          },
        );
        const linked = await transaction("o_assets")
          .where({ id: assetId, projectId })
          .update({ imageId: assetVersionId });
        if (Number(linked) !== 1) throw new ComposeRecoveryRequiredError();

        const metadata = {
          version: "canvas-video-compose.v1",
          controlledStorage: true,
          projectId,
          ratio,
          clips: authority.snapshot.clips,
          audioIncluded: current.object.rendered.audioIncluded,
          objectIntentId: current.object.intentId,
          snapshotHash: current.snapshotHash,
          taskId: current.taskId,
          assetId,
          assetVersionId,
        };
        await transaction("o_media_asset").insert({
          id: current.mediaAssetId,
          taskId: String(current.taskId),
          workspaceId,
          projectId,
          assetType: "video",
          source: "canvas-video-compose",
          url: current.object.stored.url,
          localPath: current.object.storageKey,
          storageKey: current.object.storageKey,
          mimeType: "video/mp4",
          width: current.object.rendered.width,
          height: current.object.rendered.height,
          durationMs: current.object.rendered.durationMs,
          metadata: JSON.stringify(metadata),
          createTime: createdAt,
        });
        await commitObjectWriteIntentInTransaction(
          transaction,
          current.object.stored.claim,
          createObjectWriteMediaReferenceEvidence({
            rowId: current.mediaAssetId,
            workspaceId,
            projectId,
            storageKey: current.object.storageKey,
            publicUrl: current.object.stored.url,
          }),
        );
        const taskUpdated = await transaction("o_tasks")
          .where({
            id: current.taskId,
            projectId,
            taskClass: TASK_CLASS,
            state: "进行中",
          })
          .update({
            state: "已完成",
            reason: null,
            relatedObjects: taskRelatedObjects({
              snapshotHash: current.snapshotHash,
              mediaAssetId: current.mediaAssetId,
              assetId,
              assetVersionId,
            }),
          });
        if (Number(taskUpdated) !== 1) {
          throw new ComposeRecoveryRequiredError();
        }

        const asset: PublicComposeAsset = {
          id: current.mediaAssetId,
          taskId: String(current.taskId),
          assetId,
          assetVersionId,
          url: current.object.stored.url,
          width: current.object.rendered.width,
          height: current.object.rendered.height,
          durationMs: current.object.rendered.durationMs,
          createdAt,
        };
        const outcome: ComposeOutcome = {
          kind: "success",
          data: {
            asset,
            reused: false,
          },
        };
        await completeDurableCommand(
          {
            kind: "resume",
            id: reservation.kind === "resume" ? reservation.id : "",
            checkpoint: current,
          },
          outcome,
          200,
          { database: transaction as any },
        );
        return { outcome, status: 200 };
      });
      return sendOutcome(res, finalized.outcome, finalized.status);
    } catch (error) {
      if (error instanceof ComposeSourceChangedError) {
        const queued = await queueCheckpointObjectCompensation(
          checkpoint,
        ).catch(() => false);
        if (!queued) {
          return res.status(503).send({
            code: "canvas_compose_recovery_required",
            message: "旧 Canvas 合成对象等待清理，请稍后重试",
          });
        }
        return await terminalFailure(error.status, error.code, error.message);
      }
      return res.status(503).send({
        code: "canvas_compose_recovery_required",
        message: "Canvas 视频合成资产登记待恢复，请使用相同 Idempotency-Key 重试",
      });
    }
  },
);
