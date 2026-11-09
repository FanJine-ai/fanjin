import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { checkProjectPermission } from "@/middleware/projectAccess";
import { isPlatformAdmin } from "@/middleware/permissions";
import { publicTaskModelLabel, relayProjectId, toRelayTaskCenterRow } from "@/lib/taskCenter";
import { getRelayTaskProgress, parseRelayTask } from "@/lib/relay";
import {
  RELAY_SYNTHETIC_QUARANTINE_MESSAGE,
  shouldQuarantineRelayArtifacts,
} from "@/lib/relayMockPolicy";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import { publicMediaAssetUrl } from "@/lib/publicMediaAsset";
import {
  buildPublicCreationObservability,
  publicContentSha256,
  publicCreationCorrelation,
  readPublicCreationTokenKey,
} from "@/lib/publicCreationObservability";
const router = express.Router();

const publicTaskResultAssetTypes = new Set(["video", "image", "audio", "file"]);

function redactTaskDetail<T extends Record<string, any>>(data: T): T {
  return {
    ...data,
    model: publicTaskModelLabel(data.model),
    relatedObjects: data.relatedObjects ? redactSensitiveText(data.relatedObjects) : data.relatedObjects,
    describe: data.describe ? redactSensitiveText(data.describe) : data.describe,
    reason: data.reason ? redactSensitiveText(data.reason) : data.reason,
  };
}

async function taskResultMediaAssets(input: {
  taskId: string;
  projectId: number | null;
  workspaceId?: string | null;
  tokenKey: string;
}) {
  const query = u
    .db("o_media_asset")
    .where("taskId", input.taskId)
    .andWhere("deletionState", "active")
    .whereNotNull("url")
    .select("id", "assetType", "url", "mimeType", "metadata", "createTime")
    .orderBy("createTime", "asc")
    .limit(20);
  if (input.projectId !== null) query.andWhere("projectId", input.projectId);
  if (input.workspaceId) query.andWhere("workspaceId", input.workspaceId);
  const rows = await query;
  const seen = new Set<string>();
  return rows.flatMap((row: any) => {
    const assetType = String(row.assetType || "").trim().toLowerCase();
    const url = publicMediaAssetUrl(row.url);
    if (!publicTaskResultAssetTypes.has(assetType) || !url || seen.has(url)) {
      return [];
    }
    seen.add(url);
    const contentSha256 = publicContentSha256(row.metadata);
    return [{
      assetType,
      url,
      mimeType: typeof row.mimeType === "string" ? row.mimeType : "",
      correlation: publicCreationCorrelation({
        tokenKey: input.tokenKey,
        workspaceId: input.workspaceId || "default",
        projectId: input.projectId,
        taskId: input.taskId,
        assetId: row.id,
      }),
      ...(contentSha256 ? { contentSha256 } : {}),
    }];
  });
}

async function ensureRelayTaskAccess(req: express.Request, relayTask: any, projectId: number | null) {
  if (isPlatformAdmin(req)) return { allowed: true, status: 200, message: "ok" };

  const workspaceId = (req as any).auth?.workspaceId || "default";
  if (projectId) {
    const user = (req as any).auth?.user || (req as any).user || {};
    return await checkProjectPermission({
      projectId,
      userId: Number(user.id || 0),
      role: user.role,
      permission: "project:read",
      authWorkspaceId: workspaceId,
    });
  }

  if (relayTask.workspaceId && String(relayTask.workspaceId) === String(workspaceId)) {
    return { allowed: true, status: 200, message: "ok" };
  }

  return { allowed: false, status: 403, message: "无权访问该任务" };
}

export default router.post(
  "/",
  validateFields({
    taskId: z.union([z.number(), z.string()]),
    source: z.enum(["legacy", "relay"]).optional().nullable(),
    projectId: z.number().int().positive().optional().nullable(),
  }),
  async (req, res) => {
    const tokenKey = await readPublicCreationTokenKey(u.db);
    const { taskId, source } = req.body;
    const expectedProjectId = req.body.projectId == null
      ? null
      : Number(req.body.projectId);
    if (source === "relay" || (typeof taskId === "string" && !/^\d+$/.test(taskId))) {
      const relayTask = await u.db("o_relay_task").where("id", String(taskId)).first();
      if (!relayTask) return res.status(404).send({ message: "任务不存在" });
      const relayVideo = await u
        .db("o_video")
        .where("relayTaskId", String(taskId))
        .select("o_video.projectId", "o_video.id as videoId", "o_video.videoTrackId")
        .first();
      const projectId = relayProjectId(relayTask)
        ?? (relayVideo?.projectId ? Number(relayVideo.projectId) : null);
      if (expectedProjectId !== null && projectId !== expectedProjectId) {
        return res.status(404).send({ message: "任务不属于指定项目" });
      }
      const access = await ensureRelayTaskAccess(req, relayTask, projectId);
      if (!access.allowed) return res.status(access.status).send({ message: access.message });
      const project = projectId
        ? await u.db("o_project").where("id", projectId).select("id", "name").first()
        : null;
      const relatedVideo = relayVideo && (
        projectId === null || Number(relayVideo.projectId) === projectId
      )
        ? relayVideo
        : null;
      const row = toRelayTaskCenterRow(
        relayTask,
        projectId && project?.name ? new Map([[projectId, String(project.name)]]) : new Map(),
      );
      const parsedRelayTask = parseRelayTask(relayTask);
      const syntheticQuarantined = shouldQuarantineRelayArtifacts(
        relayTask.status,
      );
      const mediaAssets = syntheticQuarantined
        ? []
        : await taskResultMediaAssets({
            taskId: String(taskId),
            projectId,
            workspaceId: String(relayTask.workspaceId || "").trim() || null,
            tokenKey,
          });
      const observability = buildPublicCreationObservability({
        tokenKey,
        workspaceId: relayTask.workspaceId || (req as any).auth?.workspaceId || "default",
        projectId,
        taskId: relayTask.id,
        requestId: relayTask.requestId,
        requestPayload: relayTask.requestPayload,
        fallbackPrompt: row.describe,
      });
      return res.status(200).send(
        success({
          ...redactTaskDetail(row as any),
          observability,
          relay: {
            progress: getRelayTaskProgress(parsedRelayTask),
            submittedAt: relayTask.submittedAt,
            completedAt: relayTask.completedAt,
          },
          mediaAssets,
          video: relatedVideo && !syntheticQuarantined
            ? {
                id: relatedVideo.videoId,
                videoTrackId: relatedVideo.videoTrackId,
              }
            : null,
          syntheticQuarantine: syntheticQuarantined
            ? {
                active: true,
                reason: RELAY_SYNTHETIC_QUARANTINE_MESSAGE,
              }
            : null,
        }),
      );
    }

    const data = await u.db("o_tasks").where("id", taskId).select("*").first();
    if (!data) return res.status(404).send({ message: "任务不存在" });

    const projectId = Number(data.projectId || 0);
    if (expectedProjectId !== null && projectId !== expectedProjectId) {
      return res.status(404).send({ message: "任务不属于指定项目" });
    }
    if (!projectId) {
      if (!isPlatformAdmin(req)) return res.status(403).send({ message: "任务缺少项目归属，无法验证访问权限" });
      return res.status(200).send(success({
        ...redactTaskDetail(data),
        mediaAssets: [],
        observability: buildPublicCreationObservability({
          tokenKey,
          workspaceId: (req as any).auth?.workspaceId || "default",
          projectId: null,
          taskId: data.id,
          requestId: data.id,
          requestPayload: data.relatedObjects,
          fallbackPrompt: data.describe,
        }),
      }));
    }

    const user = (req as any).auth?.user || (req as any).user || {};
    const result = await checkProjectPermission({
      projectId,
      userId: Number(user.id || 0),
      role: user.role,
      permission: "project:read",
    });
    if (!result.allowed) return res.status(result.status).send({ message: result.message });

    const mediaAssets = await taskResultMediaAssets({
      taskId: String(taskId),
      projectId,
      workspaceId: (req as any).auth?.workspaceId || "default",
      tokenKey,
    });
    res.status(200).send(success({
      ...redactTaskDetail(data),
      mediaAssets,
      observability: buildPublicCreationObservability({
        tokenKey,
        workspaceId: (req as any).auth?.workspaceId || "default",
        projectId,
        taskId: data.id,
        requestId: data.id,
        requestPayload: data.relatedObjects,
        fallbackPrompt: data.describe,
      }),
    }));
  }
);
