import express from "express";
import { BillingError } from "@/lib/billing";
import { reviewBillingServiceRequestV1 } from "@/lib/billingServiceRequests";
import { serviceRequestReviewSchema } from "@/lib/serviceRequestRouteSchemas";
import type { ServiceRequestReviewCommandV1 } from "@/lib/sharedTypes";
import { success } from "@/lib/responseFormat";
import { readVerifiedFinanceStepUpContext } from "@/middleware/adminStepUp";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router({ mergeParams: true });
router.use(requirePlatformAdmin);

function sendBillingError(res: express.Response, err: unknown) {
  if (err instanceof BillingError) {
    const code =
      "code" in err && typeof err.code === "string" ? err.code : undefined;
    return res.status(err.status).send({ message: err.message, ...(code ? { code } : {}) });
  }
  throw err;
}

export default router.post("/", async (req, res) => {
  const parsed = serviceRequestReviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({
      message: "参数错误",
      code: "SERVICE_REQUEST_REVIEW_INVALID",
      errors: parsed.error.issues,
    });
  }
  const context = readVerifiedFinanceStepUpContext(res);
  if (!context) {
    return res.status(401).send({
      message: "缺少已绑定的 finance step-up 上下文",
      code: "FINANCE_STEP_UP_REQUIRED",
    });
  }
  const common = {
    operation: "service_request_review" as const,
    requestId: String((req.params as Record<string, string>).id || ""),
    reviewEvidenceId: parsed.data.reviewEvidenceId,
    expectedRevision: parsed.data.expectedRevision,
    idempotencyKey: parsed.data.idempotencyKey,
  };
  const command: ServiceRequestReviewCommandV1 =
    parsed.data.targetDecision === "approved"
      ? { ...common, targetDecision: "approved", reason: null }
      : {
          ...common,
          targetDecision: parsed.data.targetDecision,
          reason: parsed.data.reason!,
        };
  try {
    return res
      .status(200)
      .send(success(await reviewBillingServiceRequestV1(command, context)));
  } catch (err) {
    return sendBillingError(res, err);
  }
});
