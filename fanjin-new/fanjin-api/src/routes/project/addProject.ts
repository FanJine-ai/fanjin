import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import {
  resolveWorkbenchModelCapability,
  type WorkbenchModelCapability,
} from "@/lib/workbenchModelCatalog";
import { validateFields } from "@/middleware/middleware";
import { requireWorkspacePermission } from "@/middleware/permissions";
import { ensureProjectDefaultAgentThread } from "@/agent-runtime/service";
import { ensureCreationSession } from "@/lib/creationSessionService";
import { db } from "@/utils/db";
import { insertAndReturnId } from "@/lib/dbDialect";
const router = express.Router();

const SUBMITTABLE_CAPABILITY_STATUSES = new Set(["verified", "configured", "legacy"]);

function capabilityValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
    : [];
}

export function projectImageConfigurationError(
  capability: WorkbenchModelCapability | null,
  input: {
    imageModel: string;
    imageQuality: string;
    videoRatio: string;
  },
): string | null {
  if (
    !capability
    || capability.canSubmit !== true
    || !SUBMITTABLE_CAPABILITY_STATUSES.has(capability.capabilityStatus)
  ) {
    return capability?.unavailableReason || "所选图片模型当前不可提交";
  }
  if (capability.id !== input.imageModel && !capability.aliases?.includes(input.imageModel)) {
    return "所选图片模型不在当前工作区能力目录中";
  }
  if (!capabilityValues(capability.qualities).includes(input.imageQuality)) {
    return "所选图片清晰度不受当前图片模型支持";
  }
  if (!capabilityValues(capability.aspectRatios).includes(input.videoRatio)) {
    return "所选画面比例不受当前图片模型支持";
  }
  return null;
}

// 新增项目
export default router.post(
  "/",
  validateFields({
    projectType: z.string(),
    name: z.string().trim().min(1, "项目名称不能为空").max(255),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    directorManual: z.string(),
    videoRatio: z.string().trim().min(1),
    imageModel: z.string().trim().min(1),
    videoModel: z.string(),
    imageQuality: z.enum(["1K", "2K", "4K"]),
    mode: z.string(),
  }),
  requireWorkspacePermission("project:write"),
  async (req, res) => {
    const { projectType, name, intro, type, directorManual, artStyle, videoRatio, imageModel, videoModel, imageQuality, mode } = req.body;
    const workspaceId = (req as any).auth?.workspaceId || "default";
    const imageCapability = await resolveWorkbenchModelCapability({
      workspaceId,
      endpointType: "image_generation",
      model: imageModel,
    });
    const configurationError = projectImageConfigurationError(imageCapability, {
      imageModel,
      imageQuality,
      videoRatio,
    });
    if (configurationError) {
      return res.status(422).send(error(configurationError));
    }
    const project = {
      workspaceId,
      projectType,
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      directorManual,
      userId: Number((req as any).auth?.user?.id || 1),
      imageModel,
      videoModel,
      createTime: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      imageQuality,
      mode,
    };

    const created = await db.transaction(async (trx: any) => {
      const id = await insertAndReturnId(trx, "o_project", project);
      const ensuredSession = await ensureCreationSession({
        workspaceId,
        projectId: id,
        draft: { mode: mode === "canvas" ? "canvas" : "quick_create" },
        createdBy: project.userId,
        now: project.createTime,
        database: trx,
      });
      const ensuredThread = await ensureProjectDefaultAgentThread({
        database: trx,
        workspaceId,
        projectId: id,
        sessionId: ensuredSession.session.id,
        title: name,
        createdBy: project.userId,
        now: project.createTime,
      });
      return {
        id,
        defaultSessionId: ensuredSession.session.id,
        defaultThreadId: ensuredThread.thread.id,
      };
    });

    res.status(200).send(success({ message: "新增项目成功", project: { ...project, id: created.id }, ...created }));
  },
);
