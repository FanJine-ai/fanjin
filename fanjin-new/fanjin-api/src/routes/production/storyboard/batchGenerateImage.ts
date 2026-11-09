import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveWorkbenchModelCapability, type WorkbenchModelCapability } from "@/lib/workbenchModelCatalog";
import { requireProjectPermission } from "@/middleware/projectAccess";
import {
  beginProjectImageTask,
  cancelProjectImageTask,
  ProjectImageTaskError,
  projectImageTaskCancelHandlers,
  projectImageTaskStatusHandlers,
  type ProjectImageTaskReservation,
} from "@/lib/projectImageTask";
import {
  runStoryboardImageTaskBatch,
  type StoryboardImageTaskResponse,
} from "@/lib/storyboardImageTaskWorker";
import { resolveVolcengineImageSize } from "@/lib/volcengineImageSize";
// 原 productionAgent 链条已删除(阶段 3.1);assetItemSchema 就地内化,保持 AssetData 导出契约不变。
const deriveAssetSchema = z.object({
  id: z.number().describe("衍生资产ID,如果新增则为空"),
  assetsId: z.number().describe("关联的资产ID"),
  prompt: z.string().describe("生成提示词"),
  name: z.string().describe("衍生资产名称"),
  desc: z.string().describe("衍生资产描述"),
  src: z.string().nullable().describe("衍生资产资源路径"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).describe("衍生资产生成状态"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("衍生资产类型"),
});
const assetItemSchema = z.object({
  id: z.number().describe("资产唯一标识"),
  name: z.string().describe("资产名称"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("资产类型"),
  prompt: z.string().describe("生成提示词"),
  desc: z.string().describe("资产描述"),
  derive: z.array(deriveAssetSchema).describe("衍生资产列表"),
});
const router = express.Router();
export type AssetData = z.infer<typeof assetItemSchema>;
type AssetRow = {
  id: number;
  name: string;
  type: string;
  describe?: string | null;
  imageId?: number | null;
};

type StoryboardRow = {
  id: number;
  prompt?: string | null;
  videoDesc?: string | null;
  track?: string | null;
};

const SUBMITTABLE_CAPABILITY_STATUSES = new Set(["verified", "configured", "legacy"]);
const STORYBOARD_IMAGE_RECOVERY_GRACE_MS = 30_000;
const STORYBOARD_IMAGE_BATCH_MAX_ITEMS = 100;
const STORYBOARD_IMAGE_BATCH_MAX_CONCURRENCY = 5;

function capabilityValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
}

function canSubmitCapability(
  capability: WorkbenchModelCapability | null,
): capability is WorkbenchModelCapability & { canSubmit: true } {
  return Boolean(
    capability
    && capability.canSubmit === true
    && SUBMITTABLE_CAPABILITY_STATUSES.has(capability.capabilityStatus),
  );
}

router.post("/tasks/status", ...projectImageTaskStatusHandlers);
router.post("/tasks/cancel", ...projectImageTaskCancelHandlers);

export default router.post(
  "/",
  requireProjectPermission("generation:create"),
  validateFields({
    storyboardIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(STORYBOARD_IMAGE_BATCH_MAX_ITEMS)
      .refine((ids) => new Set(ids).size === ids.length, "分镜 ID 不能重复"),
    projectId: z.number().int().positive(),
    scriptId: z.number().int().positive(),
    concurrentCount: z
      .number()
      .int()
      .min(1)
      .max(STORYBOARD_IMAGE_BATCH_MAX_CONCURRENCY)
      .optional(),
    compulsory: z.boolean().optional(),
  }),
  async (req, res) => {
    const {
      storyboardIds,
      projectId,
      scriptId,
      concurrentCount = 5,
      compulsory = false,
    }: {
      storyboardIds: number[];
      projectId: number;
      scriptId: number;
      concurrentCount: number;
      compulsory: boolean;
    } = req.body;
    const projectSettingData = await u
      .db("o_project")
      .where({ id: projectId, deletionState: "active" })
      .select("imageModel", "imageQuality", "artStyle", "videoRatio")
      .first();
    if (!projectSettingData) {
      return res.status(409).send(error("项目正在删除或已不可用"));
    }
    const generationDisabled = process.env.FANJIN_DISABLE_STORYBOARD_IMAGE_GENERATION === "1";
    const workspaceId = String((req as any).auth?.workspaceId || "").trim();
    const imageModel = String(projectSettingData.imageModel || "").trim();
    const imageQuality = String(projectSettingData.imageQuality || "").trim().toUpperCase();
    const videoRatio = String(projectSettingData.videoRatio || "").trim();
    const commandKey = String(req.header("idempotency-key") || "").trim();
    if (!generationDisabled && !commandKey) {
      return res.status(400).send({
        message: "分镜图片生成必须提供 Idempotency-Key，才能安全恢复且避免重复扣费",
        code: "idempotency_key_required",
      });
    }
    const imageCapability = generationDisabled
      ? null
      : await resolveWorkbenchModelCapability({
          workspaceId,
          endpointType: "image_generation",
          model: imageModel,
        });
    if (!generationDisabled && !canSubmitCapability(imageCapability)) {
      return res.status(422).send(error(imageCapability?.unavailableReason || "项目图片模型当前不可提交"));
    }
    if (!generationDisabled && !capabilityValues(imageCapability?.qualities).includes(imageQuality)) {
      return res.status(422).send(error("项目图片清晰度不受当前模型支持"));
    }
    if (!generationDisabled && !capabilityValues(imageCapability?.aspectRatios).includes(videoRatio)) {
      return res.status(422).send(error("项目画面比例不受当前图片模型支持"));
    }
    const imageSize = generationDisabled
      ? null
      : resolveVolcengineImageSize(imageQuality, videoRatio);
    if (!generationDisabled && !imageSize) {
      return res.status(422).send(error("项目图片清晰度与比例没有已验证的上游尺寸映射"));
    }
    // 当没有 storyboardIds 时，通过 AI 生成新的分镜面板数据
    let finalStoryboardIds: number[] = storyboardIds || [];
    // shouldGenerateImage === 0 的分镜标记为「未生成」，其余标记为「生成中」
    const storyboardData = await u.db("o_storyboard").where("scriptId", scriptId).where("projectId", projectId).whereIn("id", finalStoryboardIds);
    const matchedStoryboardIds = new Set(storyboardData.map((item) => Number(item.id)));
    if (
      storyboardData.length !== finalStoryboardIds.length
      || finalStoryboardIds.some((id) => !matchedStoryboardIds.has(id))
    ) {
      return res.status(404).send(error("部分分镜不存在或不属于当前项目，批次未启动"));
    }
    const storyIds = storyboardData.map((i) => i.id);

    const projectAssets: AssetRow[] = await u
      .db("o_assets")
      .where("projectId", projectId)
      .whereIn("type", ["role", "scene", "tool"])
      .select("id", "name", "type", "describe", "imageId");

    // 按显式 sortOrder 顺序查出每个 storyboard 关联的 assetId 有序列表
    let assets2StoryboardRows = await u
      .db("o_assets2Storyboard")
      .whereIn("storyboardId", storyIds)
      .orderBy("sortOrder", "asc")
      .orderBy("assetId", "asc")
      .select("storyboardId", "assetId");

    await backfillInferredStoryboardAssets(storyboardData as StoryboardRow[], projectAssets, assets2StoryboardRows);
    assets2StoryboardRows = await u
      .db("o_assets2Storyboard")
      .whereIn("storyboardId", storyIds)
      .orderBy("sortOrder", "asc")
      .orderBy("assetId", "asc")
      .select("storyboardId", "assetId");

    // 收集所有 assetId，批量查对应的 imageId
    const allAssetIds = [...new Set(assets2StoryboardRows.map((r: any) => r.assetId))];
    const assetById = new Map(projectAssets.map((asset) => [Number(asset.id), asset]));
    const assetImageMap: Record<number, number> = {};
    if (allAssetIds.length > 0) {
      const assetRows = await u
        .db("o_assets")
        .where({ projectId })
        .whereIn("id", allAssetIds)
        .select("id", "imageId");
      assetRows.forEach((row: any) => {
        assetImageMap[row.id] = row.imageId;
      });
    }

    // 按 sortOrder 顺序重建 assetRecord，值为有序的 imageId 列表
    const assetRecord: Record<number, number[]> = {};
    const assetDetailRecord: Record<number, AssetRow[]> = {};
    assets2StoryboardRows.forEach((item: any) => {
      if (!assetRecord[item.storyboardId]) {
        assetRecord[item.storyboardId] = [];
      }
      if (!assetDetailRecord[item.storyboardId]) {
        assetDetailRecord[item.storyboardId] = [];
      }
      const assetDetail = assetById.get(Number(item.assetId));
      if (assetDetail) {
        assetDetailRecord[item.storyboardId].push(assetDetail);
      }
      const imageId = assetImageMap[item.assetId];
      if (imageId != null) {
        assetRecord[item.storyboardId].push(imageId);
      }
    });

    const generateList = compulsory
      ? storyboardData
      : storyboardData.filter((item) => item.shouldGenerateImage !== 0);
    const missingReferences = generateList.flatMap((item) => {
      const missing = (assetDetailRecord[item.id!] || []).filter((asset) => !(Number(asset.imageId) > 0));
      return missing.length ? [{ storyboardId: item.id, assets: missing.map((asset) => ({ id: asset.id, name: asset.name })) }] : [];
    });
    if (missingReferences.length) {
      return res.status(422).send({
        code: "storyboard_reference_image_missing",
        message: `请先生成分镜所引用的资产图片：${[...new Set(missingReferences.flatMap((item) => item.assets.map((asset) => asset.name || `资产 ${asset.id}`)))].join("、")}`,
        data: { missingReferences },
      });
    }
    const taskEntries: Array<{
      item: (typeof storyboardData)[number];
      task: ProjectImageTaskReservation<StoryboardImageTaskResponse> | null;
      imageTaskId: number | null;
    }> = [];
    if (!generationDisabled) {
      try {
        for (const item of generateList) {
          const referenceAssets = assetDetailRecord[item.id!] || [];
          const finalPrompt = buildStoryboardImagePrompt(
            item.prompt || "",
            item.videoDesc || "",
            referenceAssets,
          );
          const itemKey = `${commandKey}:${String(item.id)}`;
          const started = await beginProjectImageTask<StoryboardImageTaskResponse>({
            workspaceId,
            actorUserId: Number((req as any).auth?.user?.id || 0),
            projectId,
            flow: "storyboard",
            scope: "production:storyboard:image",
            idempotencyKey: itemKey,
            request: {
              projectId,
              scriptId,
              storyboardId: item.id,
              model: imageCapability!.id,
              prompt: item.prompt || "",
              videoDesc: item.videoDesc || "",
              finalPrompt,
              ratio: videoRatio,
              quality: imageQuality,
              referenceImageIds: assetRecord[item.id!] || [],
              referenceAssetIds: referenceAssets.map((asset) => asset.id),
            },
            scriptId,
            storyboardId: item.id,
            model: imageCapability!.id,
            prompt: item.prompt || item.videoDesc || "分镜图片",
            finalPrompt,
            ratio: videoRatio,
            quality: imageQuality,
            resolution: imageSize!,
            requestId: String(
              (req as any).requestId || req.header("x-request-id") || "",
            ).trim() || null,
            referenceImageIds: assetRecord[item.id!] || [],
            metadata: {
              trackId: item.trackId,
              referenceAssetIds: referenceAssets.map((asset) => asset.id),
              // The request dispatches inline only after publishing the initial
              // storyboard state. Keep the recovery worker from racing that
              // initialization and overwriting a fast successful result.
              recoveryAvailableAt:
                Date.now() + STORYBOARD_IMAGE_RECOVERY_GRACE_MS,
            },
          });
          if (started.kind === "replay") {
            if (started.responseStatus !== 200) {
              throw new ProjectImageTaskError(
                409,
                "image_task_batch_retry_requires_new_key",
                "此前的分镜图片批次未完整启动，请使用新的 Idempotency-Key 重试",
              );
            }
            const replayBody = started.responseBody as unknown as Record<string, unknown>;
            taskEntries.push({
              item,
              task: null,
              imageTaskId: Number(
                replayBody.imageTaskId ?? replayBody.taskId ?? 0,
              ) || null,
            });
          } else {
            taskEntries.push({
              item,
              task: started,
              imageTaskId: started.checkpoint.taskId,
            });
          }
        }
      } catch (taskError) {
        const pendingTaskIds = taskEntries
          .filter((entry) => entry.task?.checkpoint.phase === "queued")
          .map((entry) => entry.task?.checkpoint.taskId)
          .filter((taskId): taskId is number => Number.isSafeInteger(taskId));
        if (pendingTaskIds.length) {
          const cancellationResults = await Promise.allSettled(
            pendingTaskIds.map((taskId) =>
              cancelProjectImageTask({ workspaceId, projectId, taskId })
            ),
          );
          const cancellationFailures = cancellationResults.filter(
            (result) => result.status === "rejected",
          ).length;
          if (cancellationFailures) {
            console.warn(
              "[storyboard-image-task] failed to cancel partially initialized batch",
              { count: cancellationFailures },
            );
          }
        }
        if (taskError instanceof ProjectImageTaskError) {
          return res.status(taskError.status).send({
            message: taskError.message,
            code: taskError.code,
          });
        }
        throw taskError;
      }
    }

    if (generationDisabled && compulsory) {
      await u.db("o_storyboard")
        .whereIn("id", storyIds)
        .where({ scriptId, projectId })
        .update({ state: "生成中", shouldGenerateImage: 1, reason: "" });
    } else if (generationDisabled) {
      await u.db("o_storyboard")
        .whereIn("id", storyIds)
        .where({ scriptId, projectId })
        .where("shouldGenerateImage", 0)
        .update({ state: "未生成" });
      await u.db("o_storyboard")
        .whereIn("id", storyIds)
        .where({ scriptId, projectId })
        .where("shouldGenerateImage", 1)
        .update({ state: "生成中", reason: "" });
    } else {
      if (compulsory) {
        await u.db("o_storyboard")
          .whereIn("id", storyIds)
          .where({ scriptId, projectId })
          .update({ shouldGenerateImage: 1 });
      } else {
        await u.db("o_storyboard")
          .whereIn("id", storyIds)
          .where({ scriptId, projectId })
          .where("shouldGenerateImage", 0)
          .update({ state: "未生成" });
      }
      // beginProjectImageTask publishes "生成中" atomically with each new
      // durable task. Do not repeat that write here: a retry can hold a stale
      // active checkpoint while the original worker commits success, and this
      // late update would regress the storyboard back to "生成中".
    }

    const taskIdByStoryboard = new Map(
      taskEntries.map((entry) => [Number(entry.item.id), entry.imageTaskId]),
    );
    const realStoryData = await u.db("o_storyboard")
      .where("scriptId", scriptId)
      .where("projectId", projectId)
      .whereIn("id", storyIds);
    res.status(200).send(
      success(
        realStoryData.map((i) => ({
          id: i.id,
          prompt: i.prompt,
          associateAssetsIds: assetRecord[i.id!],
          src: null,
          state: i.state,
          videoDesc: i.videoDesc,
          shouldGenerateImage: i.shouldGenerateImage,
          imageTaskId: taskIdByStoryboard.get(Number(i.id)) ?? null,
        })),
      ),
    );
    if (generationDisabled) return;

    void runStoryboardImageTaskBatch(
      taskEntries.flatMap((entry) => entry.task ? [entry.task as ProjectImageTaskReservation<unknown>] : []),
      concurrentCount,
    ).catch((generationError) => {
      console.error(
        "[storyboard-image-task] generation queue failed:",
        u.error(generationError).message,
      );
    });
  },
);

async function backfillInferredStoryboardAssets(storyboardData: StoryboardRow[], projectAssets: AssetRow[], existingRows: any[]) {
  const existingByStoryboard = existingRows.reduce<Record<number, Set<number>>>((acc, row) => {
    const storyboardId = Number(row.storyboardId);
    if (!acc[storyboardId]) acc[storyboardId] = new Set();
    acc[storyboardId].add(Number(row.assetId));
    return acc;
  }, {});

  const rowsToInsert: { storyboardId: number; assetId: number; sortOrder: number }[] = [];
  for (const storyboard of storyboardData) {
    const existingIds = existingByStoryboard[storyboard.id] || new Set<number>();
    if (existingIds.size) continue;

    const inferredAssets = inferStoryboardAssets(storyboard, projectAssets);
    inferredAssets.forEach((asset, index) => {
      if (!existingIds.has(asset.id)) {
        rowsToInsert.push({ storyboardId: storyboard.id, assetId: asset.id, sortOrder: index });
        existingIds.add(asset.id);
      }
    });
  }

  if (rowsToInsert.length) {
    await u.db("o_assets2Storyboard").insert(rowsToInsert);
  }
}

function inferStoryboardAssets(storyboard: StoryboardRow, projectAssets: AssetRow[]) {
  const context = [storyboard.videoDesc, storyboard.prompt, storyboard.track].filter(Boolean).join("\n");
  if (!context.trim()) return [];

  const scored = projectAssets
    .map((asset) => ({ asset, score: scoreAssetMatch(asset, context) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || getAssetTypeRank(a.asset.type) - getAssetTypeRank(b.asset.type));

  const selected: AssetRow[] = [];
  const typeCount: Record<string, number> = {};
  for (const item of scored) {
    const type = item.asset.type || "asset";
    const limit = type === "scene" ? 1 : 3;
    if ((typeCount[type] || 0) >= limit) continue;
    selected.push(item.asset);
    typeCount[type] = (typeCount[type] || 0) + 1;
    if (selected.length >= 5) break;
  }
  return selected;
}

function scoreAssetMatch(asset: AssetRow, context: string) {
  const name = String(asset.name || "").trim();
  if (!name) return 0;

  let score = 0;
  if (context.includes(name)) score += 100;

  const coreName = getAssetCoreName(name, asset.type);
  if (coreName && coreName !== name && context.includes(coreName)) score += 72;

  if (asset.type === "scene") {
    getSceneKeywords(name, asset.describe || "").forEach((keyword) => {
      if (keyword && context.includes(keyword)) score += 26;
    });
  }

  if (asset.type === "role" && name === "黑衣人" && /黑色|黑衣|连帽|人影/.test(context)) {
    score += 68;
  }

  if (asset.type === "tool") {
    const objectKeywords = getObjectKeywords(name);
    objectKeywords.forEach((keyword) => {
      if (keyword && context.includes(keyword)) score += 30;
    });
  }

  return score;
}

function getAssetCoreName(name: string, type: string) {
  if (type === "scene") {
    return name.replace(/^(夜晚|深夜|白天|清晨|黄昏|雨后|废弃|城市)/g, "");
  }
  return name.replace(/^(旧|老旧|银色|黑色|小型|三号)/g, "");
}

function getSceneKeywords(name: string, describe: string) {
  const text = `${name} ${describe}`;
  const keywords = ["天台", "咖啡馆", "地铁", "站台", "储物柜", "城市", "雨后", "废弃"].filter((keyword) => text.includes(keyword));
  return [...new Set(keywords)];
}

function getObjectKeywords(name: string) {
  const keywords = ["照片", "手机", "储物柜", "录音笔", "地铁票", "芯片", "控制台"].filter((keyword) => name.includes(keyword));
  return [...new Set(keywords)];
}

function getAssetTypeRank(type: string) {
  const rank: Record<string, number> = { role: 0, scene: 1, tool: 2 };
  return rank[type] ?? 3;
}

function buildStoryboardImagePrompt(prompt: string, videoDesc: string, assets: AssetRow[]) {
  const assetGuide = assets
    .map((asset, index) => `参考图${index + 1}: ${formatAssetType(asset.type)}「${asset.name}」${asset.describe ? `，${asset.describe}` : ""}`)
    .join("\n");
  return [
    assetGuide
      ? `请严格参考以下已生成资产图，保持角色长相、服装、场景空间和道具外观一致，不要重新发明造型：\n${assetGuide}`
      : "",
    videoDesc ? `分镜画面描述：${videoDesc}` : "",
    prompt ? `分镜提示词：${prompt}` : "",
    "生成单张分镜图，画面必须服务于当前分镜，不要加入未提到的新角色、新场景或新道具。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatAssetType(type: string) {
  const typeMap: Record<string, string> = {
    role: "角色",
    scene: "场景",
    tool: "道具",
  };
  return typeMap[type] || "资产";
}
