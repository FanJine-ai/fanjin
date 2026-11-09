import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { BillingError } from "@/lib/billing";
import { IDEMPOTENCY_KEY_MAX_LENGTH } from "@/middleware/idempotencyKey";
import {
  createUserVideoEnhanceTask,
  toPublicUserVideoEnhanceTask,
  UserVideoEnhanceError,
} from "@/lib/videoFulfillment/userEnhance";
import { USER_VIDEO_ENHANCE_BILLING_SUBJECT } from "@/lib/videoFulfillment/recipes";

const router = express.Router();

/**
 * 创作台画质增强创建(路径 B 真调度):校验 → quote 复核 → 选超分通道
 * (video_upscale,健康+权重) → video_enhance 科目冻结 → 提交超分通道 →
 * 成功:新资产(source=video_enhance,保留原片)+结算;失败:释放冻结。
 * 仅创作台暴露;developer/relay API 不提供增强产品(见 userEnhance
 * isRelayVideoEnhanceForbidden 契约)。
 */
export default router.post(
  "/",
  requireActiveWorkspacePermission("generation:create"),
  validateFields({
    sourceResolution: z.string().min(1).max(32),
    targetResolution: z.string().min(1).max(32),
    durationSeconds: z.number().nonnegative().max(86400).optional().nullable(),
    sourceAssetId: z.string().trim().min(1).max(200).optional().nullable(),
    sourceUrl: z.string().trim().min(1).max(2048).optional().nullable(),
    idempotencyKey: z.string().trim().min(1).max(200).optional().nullable(),
  }),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "");
    const userId = Number((req as any).auth?.user?.id || 0) || null;
    try {
      const body = req.body as {
        sourceResolution: string;
        targetResolution: string;
        durationSeconds?: number | null;
        sourceAssetId?: string | null;
        sourceUrl?: string | null;
        idempotencyKey?: string | null;
      };
      const headerIdempotencyKey = String(req.header("idempotency-key") || "").trim();
      const bodyIdempotencyKey = String(body.idempotencyKey || "").trim();
      if (
        headerIdempotencyKey
        && bodyIdempotencyKey
        && headerIdempotencyKey !== bodyIdempotencyKey
      ) {
        return res.status(409).send(error("请求头与请求体的幂等键不一致", {
          code: "ENHANCE_IDEMPOTENCY_KEY_CONFLICT",
        }));
      }
      const idempotencyKey = headerIdempotencyKey || bodyIdempotencyKey;
      if (!idempotencyKey) {
        return res.status(400).send(error("画质增强请求必须提供 Idempotency-Key，以避免重复任务与扣费", {
          code: "ENHANCE_IDEMPOTENCY_KEY_REQUIRED",
        }));
      }
      if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
        return res.status(400).send(error(`Idempotency-Key 不能超过 ${IDEMPOTENCY_KEY_MAX_LENGTH} 字符`, {
          code: "ENHANCE_IDEMPOTENCY_KEY_INVALID",
        }));
      }
      const result = await createUserVideoEnhanceTask({
        workspaceId,
        userId,
        sourceAssetId: body.sourceAssetId ?? null,
        sourceUrl: body.sourceUrl ?? null,
        sourceResolution: body.sourceResolution,
        targetResolution: body.targetResolution,
        durationSeconds: body.durationSeconds ?? null,
        idempotencyKey,
      });
      return res.status(result.idempotent ? 200 : 201).send(
        success({
          billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
          quote: result.quote,
          idempotent: result.idempotent,
          task: await toPublicUserVideoEnhanceTask(result.task),
        }),
      );
    } catch (err: any) {
      if (err instanceof UserVideoEnhanceError) {
        return res.status(err.status).send(error(err.message, { code: err.code }));
      }
      if (err instanceof BillingError) {
        return res.status(err.status).send(error(err.message, { code: "ENHANCE_BILLING_ERROR" }));
      }
      console.error("[workbench-video-enhance] create failed", err?.message || err);
      return res.status(500).send(error("画质增强任务创建失败", { code: "ENHANCE_CREATE_FAILED" }));
    }
  },
);
