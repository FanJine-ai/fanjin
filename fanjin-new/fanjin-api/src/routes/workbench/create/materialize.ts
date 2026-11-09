import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { normalizeDirectorPlan } from "@/lib/quickCreate";
import { db } from "@/utils/db";
import { insertAndReturnId } from "@/lib/dbDialect";
import { resolveWorkbenchModelCapability } from "@/lib/workbenchModelCatalog";
import {
  beginDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
} from "@/lib/durableCommandIdempotency";
import { ensureInspirationWorkspaceProject } from "@/lib/inspirationWorkspaceProject";

const router = express.Router();

const ratioSchema = z.string().regex(/^\d{1,3}:\d{1,3}$/);
const shotSchema = z.object({
  title: z.string(),
  script: z.string(),
  visual: z.string(),
  prompt: z.string(),
  duration: z.number(),
  track: z.string(),
});
const planSchema = z.object({
  title: z.string(),
  simpleScript: z.string(),
  stylePrompt: z.string(),
  ratio: ratioSchema,
  duration: z.number(),
  shots: z.array(shotSchema).min(1),
});

const SUBMITTABLE_CAPABILITY_STATUSES = new Set(["verified", "configured", "legacy"]);

type WorkbenchCapabilityLike = {
  id?: unknown;
  capabilityStatus?: unknown;
  canSubmit?: unknown;
  unavailableReason?: unknown;
  qualities?: unknown;
  defaultQuality?: unknown;
  aspectRatios?: unknown;
  duration?: unknown;
};

type QuickCreateMaterializeActor =
  | {
    ok: true;
    workspaceId: string;
    userId: number;
  }
  | {
    ok: false;
    status: 401 | 403;
    body: {
      message: string;
      code: "AUTH_IDENTITY_REQUIRED" | "WORKSPACE_CONTEXT_REQUIRED";
    };
  };

export function resolveQuickCreateMaterializeActor(auth: unknown): QuickCreateMaterializeActor {
  const context = auth && typeof auth === "object"
    ? auth as { workspaceId?: unknown; user?: { id?: unknown } | null }
    : {};
  const userId = Number(context.user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return {
      ok: false,
      status: 401,
      body: {
        message: "登录身份无效",
        code: "AUTH_IDENTITY_REQUIRED",
      },
    };
  }

  const workspaceId = typeof context.workspaceId === "string"
    ? context.workspaceId.trim()
    : "";
  if (!workspaceId) {
    return {
      ok: false,
      status: 403,
      body: {
        message: "缺少工作区上下文",
        code: "WORKSPACE_CONTEXT_REQUIRED",
      },
    };
  }

  return {
    ok: true,
    workspaceId,
    userId,
  };
}

function canSubmitCapability(entry: WorkbenchCapabilityLike | null | undefined): entry is WorkbenchCapabilityLike & {
  id: string;
  capabilityStatus: string;
  canSubmit: true;
} {
  return Boolean(
    entry
    && typeof entry.id === "string"
    && entry.id.trim()
    && entry.canSubmit === true
    && SUBMITTABLE_CAPABILITY_STATUSES.has(String(entry.capabilityStatus)),
  );
}

function capabilityValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function supportsDuration(durationCapability: unknown, requestedDuration: number): boolean {
  if (!durationCapability || typeof durationCapability !== "object") return false;
  const duration = durationCapability as {
    min?: unknown;
    max?: unknown;
    step?: unknown;
    allowed?: unknown;
  };
  if (Array.isArray(duration.allowed) && duration.allowed.length > 0) {
    return duration.allowed.some((item) => typeof item === "number" && item === requestedDuration);
  }

  const min = Number(duration.min);
  const max = Number(duration.max);
  const step = Number(duration.step);
  if (![min, max, step].every(Number.isFinite) || step <= 0 || requestedDuration < min || requestedDuration > max) {
    return false;
  }
  const stepsFromMin = (requestedDuration - min) / step;
  return Math.abs(stepsFromMin - Math.round(stepsFromMin)) < 1e-9;
}

function requestedValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function quickCreateProjectId(now: number): number {
  return now;
}

function quickCreateTrackId(now: number, index: number): number {
  return now + 1000 + index;
}

export default router.post(
  "/",
  requireActiveWorkspacePermission("project:write"),
  validateFields({
    plan: planSchema,
    brief: z.string().optional().nullable(),
    targetType: z.string().optional().nullable(),
    imageModel: z.string().optional().nullable(),
    videoModel: z.string().optional().nullable(),
    imageQuality: z.string().optional().nullable(),
    generationMode: z.enum(["image", "video", "closed_loop"]).optional(),
    sourceProjectId: z.number().int().positive().optional().nullable(),
    purpose: z.enum(["project", "inspiration"]).optional(),
  }),
  async (req, res) => {
    try {
      const actor = resolveQuickCreateMaterializeActor((req as any).auth);
      if (!actor.ok) return res.status(actor.status).send(actor.body);

      const { workspaceId, userId } = actor;
      const rawPlan = req.body.plan;
      const plan = normalizeDirectorPlan(rawPlan, {
        brief: req.body.brief || rawPlan.title || rawPlan.simpleScript,
        style: rawPlan.stylePrompt,
        targetType: req.body.targetType || "快速创作",
        ratio: rawPlan.ratio,
        duration: rawPlan.duration,
        shotCount: rawPlan.shots.length,
      });
      const now = Date.now();
      const requestedImageModel = requestedValue(req.body.imageModel);
      const requestedVideoModel = requestedValue(req.body.videoModel);
      const [imageCapability, videoCapability] = await Promise.all([
        resolveWorkbenchModelCapability({
          workspaceId,
          endpointType: "image_generation",
          model: requestedImageModel,
        }),
        resolveWorkbenchModelCapability({
          workspaceId,
          endpointType: "video_generation",
          model: requestedVideoModel,
        }),
      ]);

      if (!canSubmitCapability(imageCapability)) {
        if (!requestedImageModel) {
          return res.status(503).send({ message: "当前工作区没有可用的默认图片模型" });
        }
        return res.status(422).send({
          message: typeof imageCapability?.unavailableReason === "string" && imageCapability.unavailableReason.trim()
            ? imageCapability.unavailableReason
            : "所选图片模型当前不可提交",
        });
      }
      if (!canSubmitCapability(videoCapability)) {
        if (!requestedVideoModel) {
          return res.status(503).send({ message: "当前工作区没有可用的默认视频模型" });
        }
        return res.status(422).send({
          message: typeof videoCapability?.unavailableReason === "string" && videoCapability.unavailableReason.trim()
            ? videoCapability.unavailableReason
            : "所选视频模型当前不可提交",
        });
      }

      const imageModel = imageCapability.id;
      const videoModel = videoCapability.id;
      const requestedImageQuality = requestedValue(req.body.imageQuality);
      const defaultImageQuality = typeof imageCapability.defaultQuality === "string"
        ? imageCapability.defaultQuality
        : undefined;
      const imageQuality = requestedImageQuality || defaultImageQuality;
      const imageQualities = capabilityValues(imageCapability.qualities);
      if (!imageQuality || !imageQualities.includes(imageQuality)) {
        return res.status(requestedImageQuality ? 422 : 503).send({
          message: requestedImageQuality ? "所选图片清晰度不受当前模型支持" : "图片模型缺少可用的默认清晰度",
        });
      }

      const imageRatios = capabilityValues(imageCapability.aspectRatios);
      const videoRatios = capabilityValues(videoCapability.aspectRatios);
      // Reference-image dimensions and video output dimensions are independent.
      // Older clients do not send generationMode, so accept a ratio supported by
      // either model and let the concrete generation endpoint enforce its model.
      const generationMode = req.body.generationMode;
      const ratioSupported = generationMode === "image"
        ? imageRatios.includes(plan.ratio)
        : generationMode === "video"
          ? videoRatios.includes(plan.ratio)
          : generationMode === "closed_loop"
            ? imageRatios.includes(plan.ratio) && videoRatios.includes(plan.ratio)
            : imageRatios.includes(plan.ratio) || videoRatios.includes(plan.ratio);
      if (!ratioSupported) {
        return res.status(422).send({ message: "所选生成模型不支持当前输出比例" });
      }
      if (plan.shots.some((shot) => !supportsDuration(videoCapability.duration, shot.duration))) {
        return res.status(422).send({ message: "一个或多个镜头时长不受当前视频模型支持" });
      }

      let commandReservation;
      try {
        commandReservation = await beginDurableCommand<{
          project: Record<string, unknown>;
          script: Record<string, unknown>;
          shots: Array<Record<string, unknown>>;
        }>({
          workspaceId,
          actorUserId: userId,
          scope: "workbench:create:materialize",
          idempotencyKey: req.header("idempotency-key"),
          request: {
            plan,
            brief: req.body.brief || null,
            targetType: req.body.targetType || null,
            imageModel,
            videoModel,
            imageQuality,
            generationMode: req.body.generationMode || "closed_loop",
            sourceProjectId: req.body.sourceProjectId ?? null,
            purpose: req.body.purpose || "project",
          },
          ...(Number.isSafeInteger(Number(req.body.sourceProjectId))
            && Number(req.body.sourceProjectId) > 0
            ? {
                resourceType: "project",
                resourceId: Number(req.body.sourceProjectId),
              }
            : {}),
          // Project materialization is a single database transaction. A stale
          // reservation can therefore be reclaimed safely because the project
          // rows and replay response are committed atomically below.
          reservationStaleAfterMs: 30 * 1_000,
        });
        if (commandReservation.kind === "replay") {
          return res
            .status(commandReservation.responseStatus)
            .send(success(commandReservation.responseBody));
        }
      } catch (error) {
        if (error instanceof DurableCommandIdempotencyError) {
          return res.status(error.status).send({ message: error.message, code: error.code });
        }
        throw error;
      }

      const result = await db.transaction(async (trx: any) => {
        const inspirationPurpose = req.body.purpose === "inspiration";
        const project = inspirationPurpose
          ? await ensureInspirationWorkspaceProject({
              database: trx,
              workspaceId,
              userId,
              imageModel,
              videoModel,
              imageQuality,
              videoRatio: plan.ratio,
              now,
            })
          : {
              id: quickCreateProjectId(now),
              workspaceId,
              projectType: "script",
              name: plan.title,
              intro: req.body.brief || plan.simpleScript,
              type: req.body.targetType || "快速创作",
              artStyle: plan.stylePrompt,
              videoRatio: plan.ratio,
              directorManual: plan.stylePrompt,
              userId,
              imageModel,
              videoModel,
              createTime: now,
              updatedAt: now,
              revision: 1,
              imageQuality,
              mode: "quick-create",
            };
        const projectId = Number(project.id);
        if (!inspirationPurpose) await trx("o_project").insert(project);

        const scriptId = await insertAndReturnId(trx, "o_script", {
          name: `${plan.title} · 简单剧本`,
          content: plan.simpleScript,
          projectId,
          extractState: 2,
          createTime: now,
        });

        const shots = [];
        for (const [index, shot] of plan.shots.entries()) {
          const trackId = quickCreateTrackId(now, index);
          await trx("o_videoTrack").insert({
            id: trackId,
            projectId,
            scriptId,
            duration: shot.duration,
            state: "待生成",
            prompt: shot.prompt,
          });
          const storyboardId = await insertAndReturnId(trx, "o_storyboard", {
            prompt: shot.prompt,
            duration: String(shot.duration),
            state: "待生成",
            scriptId,
            projectId,
            trackId,
            track: shot.track || `镜头${index + 1}`,
            videoDesc: [shot.title, shot.visual, shot.script].filter(Boolean).join("\n"),
            shouldGenerateImage: 0,
            createTime: now + index,
            index: index + 1,
          });
          shots.push({
            ...shot,
            storyboardId,
            trackId,
            scriptId,
            projectId,
          });
        }

        const materialized = {
          project,
          script: {
            id: scriptId,
            name: `${plan.title} · 简单剧本`,
            content: plan.simpleScript,
          },
          shots,
        };
        await completeDurableCommand(commandReservation, materialized, 200, { database: trx });
        return materialized;
      });

      res.status(200).send(success(result));
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      console.error("[quick-create] materialize failed", {
        requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
      });
      res.status(500).send({
        code: 500,
        data: null,
        message: "草稿项目创建失败",
      });
    }
  },
);
