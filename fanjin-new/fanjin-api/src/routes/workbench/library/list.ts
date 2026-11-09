import { isRelayPortraitPreparing, relayPortraitPreparationView } from "@/lib/relayPortraitPreparation";
import { publicModelId } from "@/lib/minimaxH3PublicIdentity";
import { HISTORY_VISIBILITY } from "@/lib/migrations/assetFileManager";
import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { listViewableAssetIds } from "@/lib/accountWorkspaceAssetLibrary";
import { listReadableProjectIds } from "@/middleware/projectAccess";
import { requireProjectPermission } from "@/middleware/projectAccess";
import {
  friendlyGenerationFailureReason,
  publicMediaAssetError,
  publicMediaAssetMetadata,
  publicMediaAssetUrl,
} from "@/lib/publicMediaAsset";
import {
  publicContentSha256,
  publicCreationPrompt,
  publicCreationCorrelation,
  readPublicCreationTokenKey,
} from "@/lib/publicCreationObservability";
import { buildPublicGenerationHistory } from "@/lib/publicGenerationHistory";

const router = express.Router();

function parseJsonObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveAssetModel(
  assetType: unknown,
  relayTaskModel: unknown,
  metadataValue: unknown,
): string {
  const taskModel = typeof relayTaskModel === "string"
    ? relayTaskModel.trim()
    : "";
  if (taskModel) return publicModelId(taskModel);
  if (assetType !== "image") return "";
  const metadata = parseJsonObject(metadataValue);
  return typeof metadata.model === "string" ? metadata.model.trim() : "";
}

function projectAssetLink(metadataValue: unknown): {
  assetId: number;
  assetVersionId: number;
} | null {
  const metadata = typeof metadataValue === "string"
    ? parseJsonObject(metadataValue)
    : metadataValue && typeof metadataValue === "object"
      ? metadataValue as Record<string, any>
      : {};
  const assetId = Number(metadata.assetId);
  const assetVersionId = Number(metadata.assetVersionId);
  if (
    !Number.isSafeInteger(assetId)
    || assetId <= 0
    || !Number.isSafeInteger(assetVersionId)
    || assetVersionId <= 0
  ) {
    return null;
  }
  return { assetId, assetVersionId };
}

function extractProjectId(requestId?: string | null, payload: Record<string, any> = {}): number | null {
  const match = String(requestId || "").match(/^(?:quick-create|workbench):(\d+):/);
  if (match) return Number(match[1]);
  const value = Number(payload.projectId || 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function resolveProjectId(
  assetProjectId: unknown,
  taskProjectId: unknown,
  requestId?: string | null,
  payload: Record<string, any> = {},
): number | null {
  // projectId persisted on the media row is the authoritative ownership
  // binding. Only legacy rows, created before that column was backfilled, may
  // fall back to the relay task binding and then its request metadata.
  if (assetProjectId !== null && assetProjectId !== undefined) {
    const value = Number(assetProjectId);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  const persistedTaskProjectId = Number(taskProjectId);
  if (Number.isSafeInteger(persistedTaskProjectId) && persistedTaskProjectId > 0) {
    return persistedTaskProjectId;
  }
  return extractProjectId(requestId, payload);
}

function applyProjectScope(query: any, projectId: number) {
  query.andWhere((builder: any) => {
    builder.where("asset.projectId", projectId).orWhere((legacy: any) => {
      legacy.whereNull("asset.projectId").andWhere((fallback: any) => {
        fallback
          .where("task.projectId", projectId)
          .orWhere("task.requestId", "like", `workbench:${projectId}:%`)
          .orWhere("task.requestId", "like", `quick-create:${projectId}:%`)
          .orWhere("task.requestPayload", "like", `%\"projectId\":${projectId}%`)
          .orWhere("task.requestPayload", "like", `%\"projectId\":\"${projectId}\"%`);
      });
    });
  });
}

const requireLibraryProjectRead: express.RequestHandler = (req, res, next) => {
  if (req.body?.projectId != null) {
    return requireProjectPermission("project:read")(req, res, next);
  }
  return next();
};

function sourceLabel(requestId?: string | null): string {
  const value = String(requestId || "");
  if (value.startsWith("quick-create:")) return "快速创作";
  if (value.startsWith("workbench:")) return "项目创作";
  return "API";
}

async function browserMediaAssetUrl(row: Record<string, any>): Promise<string> {
  const storageKey = typeof row.storageKey === "string"
    ? row.storageKey.trim()
    : "";
  if (storageKey) {
    try {
      // storageKey is the durable authority. Generate a fresh URL on every
      // read so signed object-storage links are never persisted past expiry.
      return await u.oss.getFileUrl(storageKey);
    } catch {
      return "";
    }
  }
  // Legacy records may still contain a stable application/CDN URL. Arbitrary
  // provider URLs continue to fail closed until the audited backfill copies
  // them into Fanjin object storage and assigns storageKey.
  return publicMediaAssetUrl(row.url);
}

function preferredUsage(rows: Record<string, any>[]): Record<string, any> | null {
  const priority: Record<string, number> = {
    charged: 5,
    free: 4,
    pending_reconcile: 3,
    reserved: 2,
    released: 1,
    refunded: 1,
  };
  return [...rows].sort((left, right) => (
    (priority[String(right.status || "").toLowerCase()] || 0)
    - (priority[String(left.status || "").toLowerCase()] || 0)
    || Number(right.createTime || 0) - Number(left.createTime || 0)
  ))[0] || null;
}

export default router.post(
  "/",
  validateFields({
    page: z.number().optional(),
    limit: z.number().optional(),
    projectId: z.number().int().positive().optional().nullable(),
    type: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    keyword: z.string().optional().nullable(),
    hidden: z.boolean().optional(),
    correlation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }),
  requireLibraryProjectRead,
  async (req, res) => {
    const tokenKey = await readPublicCreationTokenKey(u.db);
    const page = Math.max(1, Number(req.body.page || 1));
    const limit = Math.min(60, Math.max(1, Number(req.body.limit || 24)));
    const offset = (page - 1) * limit;
    const type = String(req.body.type || "");
    const status = String(req.body.status || "");
    const keyword = String(req.body.keyword || "").trim();
    const projectId = req.body.projectId == null ? null : Number(req.body.projectId);
    const workspaceId = (req as any).auth?.workspaceId || "default";

    const baseQuery = u
      .db("o_media_asset as asset")
      .leftJoin("o_relay_task as task", "task.id", "asset.taskId")
      .modify((query: any) => {
        query.andWhere("asset.deletionState", "active");
        // Synthetic provider output is never part of the real creative
        // library. Apply this before both count and pagination so mocked rows
        // cannot create ghost pages or inflate totals.
        query.andWhere((builder: any) => {
          builder.whereNull("task.status").orWhereNot("task.status", "mocked");
        });
        {
          query.andWhere((builder: any) => {
            builder
              .where((owned: any) => {
                owned
                  .where("asset.workspaceId", workspaceId)
                  .where((taskScope: any) => {
                    taskScope.whereNull("task.id").orWhere("task.workspaceId", workspaceId);
                  });
              })
              .orWhere((legacy: any) => {
                legacy.whereNull("asset.workspaceId").where("task.workspaceId", workspaceId);
              });
          });
        }
        if (type) query.andWhere("asset.assetType", type);
        if (status) query.andWhere("task.status", status);
        if (projectId !== null) applyProjectScope(query, projectId);

      });

    if (await u.db.schema.hasTable(HISTORY_VISIBILITY)) {
      const hidden = u.db(HISTORY_VISIBILITY).select("mediaId")
        .where({ workspaceId, userId: Number((req as any).auth?.user?.id || 0) })
        .whereRaw('"o_generation_history_visibility"."mediaId" = "asset"."id"');
      if (req.body.hidden === true) baseQuery.whereExists(hidden);
      else baseQuery.whereNotExists(hidden);
    }

    // Authorize identity rows before pagination and URL signing. Workspace
    // membership alone does not grant access to private account-owned files.
    const identities = await baseQuery.clone().select("asset.id", "asset.workspaceId", "asset.projectId", "asset.taskId", "asset.metadata",
      "task.projectId as taskProjectId", "task.requestId", "task.requestPayload", "task.model", "asset.assetType")
      .orderBy("asset.createTime", "desc").orderBy("asset.id", "desc");
    const actorUserId = Number((req as any).auth?.user?.id || 0);
    const candidates = (identities as Record<string, any>[]).map(row => ({ row,
      projectId: resolveProjectId(row.projectId, row.taskProjectId, row.requestId, parseJsonObject(row.requestPayload)),
      link: projectAssetLink(row.metadata),
    }));
    const projects = await listReadableProjectIds({ database: u.db, workspaceId, userId: actorUserId,
      role: (req as any).auth?.user?.role, projectIds: candidates.map(item => item.projectId).filter((id): id is number => id !== null) });
    const assets = await listViewableAssetIds({ database: u.db, workspaceId, actorUserId,
      assetIds: candidates.filter(item => item.projectId && projects.has(item.projectId) && item.link).map(item => item.link!.assetId) });
    const authorizedIds: string[] = [];
    for (const { row, projectId: resolvedProjectId, link } of candidates) {
      if (!resolvedProjectId || !projects.has(resolvedProjectId)) continue;
      if (link && assets !== null && !assets.has(link.assetId)) continue;
      if (req.body.correlation && publicCreationCorrelation({ tokenKey, workspaceId: row.workspaceId || workspaceId,
        projectId: resolvedProjectId, taskId: row.taskId || `asset:${row.id}`, assetId: row.id }).generationDigest !== req.body.correlation) continue;
      if (keyword) {
        const visibleText = [row.id, row.taskId, row.requestId, resolveAssetModel(row.assetType, row.model, row.metadata),
          publicCreationPrompt(row.requestPayload, parseJsonObject(row.metadata).prompt)].join("\n").toLocaleLowerCase();
        if (!visibleText.includes(keyword.toLocaleLowerCase())) continue;
      }
      authorizedIds.push(row.id);
    }
    // Identities are already sorted and authorized. Fetch full payloads only
    // for this page, avoiding a second count and an unbounded SQL IN list.
    baseQuery.whereIn("asset.id", authorizedIds.slice(offset, offset + limit));
    const rows = await baseQuery
      .clone()
      .select(
        "asset.id as id",
        "asset.taskId as taskId",
        "asset.workspaceId as workspaceId",
        "asset.projectId as projectId",
        "asset.assetType as assetType",
        "asset.source as source",
        "asset.url as url",
        "asset.localPath as localPath",
        "asset.storageKey as storageKey",
        "asset.mimeType as mimeType",
        "asset.width as width",
        "asset.height as height",
        "asset.durationMs as durationMs",
        "asset.metadata as metadata",
        "asset.createTime as createdAt",
        "task.status as status",
        "task.projectId as taskProjectId",
        "task.endpointType as endpointType",
        "task.model as model",
        "task.requestId as requestId",
        "task.requestPayload as requestPayload",
        "task.resultPayload as resultPayload",
        "task.providerTaskId as providerTaskId",
        "task.errorMessage as errorMessage",
      )
      .orderBy("asset.createTime", "desc")
      .orderBy("asset.id", "desc")
      .limit(limit);

    const taskIds = Array.from(new Set<string>(
      rows.map((row: any) => String(row.taskId || "").trim()).filter(Boolean),
    ));
    const usageRows = taskIds.length
      ? await u.db("o_usage_record")
          .whereIn("taskId", taskIds)
          .select("taskId", "workspaceId", "status", "currency", "costMicros", "createTime")
      : [];
    const usageByTaskId = new Map<string, Record<string, any>[]>();
    for (const usage of usageRows as Record<string, any>[]) {
      const taskId = String(usage.taskId || "").trim();
      if (!taskId) continue;
      const current = usageByTaskId.get(taskId) || [];
      current.push(usage);
      usageByTaskId.set(taskId, current);
    }

    const browserUrls = await Promise.all(
      rows.map((row: any) => browserMediaAssetUrl(row)),
    );
    const data = rows.map((row: any, index: number) => {
      const payload = parseJsonObject(row.requestPayload);
      const assetLink = projectAssetLink(row.metadata);
      const resolvedProjectId = resolveProjectId(
        row.projectId,
        row.taskProjectId,
        row.requestId,
        payload,
      );
      const contentSha256 = publicContentSha256(row.metadata);
      const publicWorkspaceId = row.workspaceId || workspaceId;
      const usage = preferredUsage(
        (usageByTaskId.get(String(row.taskId || "")) || []).filter((candidate) => (
          !candidate.workspaceId
          || String(candidate.workspaceId) === String(publicWorkspaceId)
        )),
      );
      return {
        id: row.id,
        taskId: row.taskId,
        assetId: assetLink?.assetId ?? null,
        assetVersionId: assetLink?.assetVersionId ?? null,
        assetType: row.assetType,
        url: browserUrls[index],
        mimeType: row.mimeType || "",
        width: row.width ?? null,
        height: row.height ?? null,
        durationMs: row.durationMs ?? null,
        status: row.status || "succeeded",
        ...relayPortraitPreparationView({ status: row.status || "succeeded", providerTaskId: row.providerTaskId, resultPayload: parseJsonObject(row.resultPayload) }),
        endpointType: row.endpointType || "",
        model: resolveAssetModel(row.assetType, row.model, row.metadata),
        source: sourceLabel(row.requestId),
        requestId: row.requestId || "",
        prompt: publicCreationPrompt(row.requestPayload, parseJsonObject(row.metadata).prompt),
        projectId: resolvedProjectId,
        correlation: publicCreationCorrelation({
          tokenKey,
          workspaceId: publicWorkspaceId,
          projectId: resolvedProjectId,
          taskId: row.taskId || `asset:${row.id}`,
          assetId: row.id,
        }),
        generationHistory: buildPublicGenerationHistory({
          tokenKey,
          workspaceId: publicWorkspaceId,
          projectId: resolvedProjectId,
          assetSource: row.source,
          assetMetadata: row.metadata,
          requestPayload: row.requestPayload,
          resultPayload: row.resultPayload,
          usage,
        }),
        ...(contentSha256 ? { contentSha256 } : {}),
        errorMessage: publicMediaAssetError(row.errorMessage, row.status === "failed"),
        metadata: publicMediaAssetMetadata(row.metadata),
        createdAt: Number(row.createdAt || 0),
      };
    });

    // Registration waiting and terminal failure both have a durable generation
    // task before any output asset exists. Show those checkpoints in history.
    const taskOnlyRows = page === 1 && !req.body.correlation
      ? (await u.db("o_relay_task as task")
          .leftJoin("o_media_asset as asset", "asset.taskId", "task.id")
          .whereNull("asset.id")
          .where("task.workspaceId", workspaceId)
          .where((builder: any) => builder.where("task.status", "failed").orWhere((waiting: any) => {
            waiting.where("task.status", "queued").where("task.resultPayload", "like", '%"portraitPreparation"%');
          }))
          .whereIn("task.endpointType", ["video_generation", "image_generation"])
          .modify((query: any) => {
            if (projectId !== null) query.andWhere("task.projectId", projectId);
            if (type) {
              const wanted = type === "video" ? "video_generation" : type === "image" ? "image_generation" : "";
              if (wanted) query.andWhere("task.endpointType", wanted);
              else query.whereRaw("1=0");
            }
            if (status) query.andWhere("task.status", status);
            if (keyword) {
              const like = `%${keyword.toLowerCase()}%`;
              query.andWhere((builder: any) => {
                builder.whereRaw("LOWER(task.requestPayload) LIKE ?", [like])
                  .orWhereRaw("LOWER(coalesce(task.errorMessage,'')) LIKE ?", [like]);
              });
            }
          })
          .orderBy("task.createTime", "desc")
          .limit(Math.min(limit, 20))
          .select(
            "task.id as taskId",
            "task.workspaceId as workspaceId",
            "task.projectId as taskProjectId",
            "task.model as model",
            "task.requestId as requestId",
            "task.requestPayload as requestPayload",
            "task.resultPayload as resultPayload",
            "task.status as status",
            "task.providerTaskId as providerTaskId",
            "task.errorMessage as errorMessage",
            "task.createTime as createdAt",
            "task.endpointType as endpointType",
          )) as Record<string, any>[]
      : [];
    const taskOnlyCandidates = taskOnlyRows.map(row => ({
      row,
      projectId: resolveProjectId(null, row.taskProjectId, row.requestId, parseJsonObject(row.requestPayload)),
    }));
    const readableTaskProjects = await listReadableProjectIds({ database: u.db, workspaceId, userId: actorUserId,
      role: (req as any).auth?.user?.role,
      projectIds: taskOnlyCandidates.map(item => item.projectId).filter((id): id is number => id !== null),
    });
    const taskOnlyItems = taskOnlyCandidates.filter(({ row, projectId: taskProjectId }) => (
      taskProjectId !== null && readableTaskProjects.has(taskProjectId)
      && (row.status === "failed" || isRelayPortraitPreparing({
        status: row.status, providerTaskId: row.providerTaskId, resultPayload: parseJsonObject(row.resultPayload),
      }))
    )).map(({ row }) => {
      const payload = parseJsonObject(row.requestPayload);
      const resolvedProjectId = resolveProjectId(null, row.taskProjectId, row.requestId, payload);
      const prompt = publicCreationPrompt(row.requestPayload, payload.prompt);
      const preparation = relayPortraitPreparationView({ status: row.status, providerTaskId: row.providerTaskId, resultPayload: parseJsonObject(row.resultPayload) });
      const reason = row.status === "failed" ? friendlyGenerationFailureReason(row.errorMessage) : "";
      return {
        id: `${row.status === "failed" ? "failed" : "preparing"}:${row.taskId}`,
        taskId: row.taskId,
        assetId: null,
        assetVersionId: null,
        assetType: String(row.endpointType || "").startsWith("image") ? "image" : "video",
        url: "",
        mimeType: "",
        width: null,
        height: null,
        durationMs: null,
        status: row.status,
        ...preparation,
        endpointType: row.endpointType || "",
        model: resolveAssetModel("video", row.model, {}),
        source: sourceLabel(row.requestId),
        requestId: row.requestId || "",
        prompt,
        projectId: resolvedProjectId,
        correlation: publicCreationCorrelation({
          tokenKey,
          workspaceId: row.workspaceId || workspaceId,
          projectId: resolvedProjectId,
          taskId: row.taskId,
          assetId: 0,
        }),
        generationHistory: buildPublicGenerationHistory({
          tokenKey,
          workspaceId: row.workspaceId || workspaceId,
          projectId: resolvedProjectId,
          assetSource: "API",
          assetMetadata: {},
          requestPayload: row.requestPayload,
          resultPayload: row.resultPayload,
          usage: [],
        }),
        errorMessage: reason,
        metadata: {},
        createdAt: Number(row.createdAt || 0),
      };
    });

    const merged = [...taskOnlyItems, ...data].sort(
      (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0),
    );

    res.status(200).send(
      success({
        data: page === 1 ? merged : data,
        total: authorizedIds.length + taskOnlyItems.length,
        page,
        limit,
      }),
    );
  },
);
