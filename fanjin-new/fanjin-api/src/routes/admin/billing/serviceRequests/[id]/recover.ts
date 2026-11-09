import express from "express";
import { BillingError } from "@/lib/billing";
import { recoverBillingServiceRequestFinanceV1 } from "@/lib/billingServiceRequests";
import { serviceRequestRecoverSchema } from "@/lib/serviceRequestRouteSchemas";
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
  const parsed = serviceRequestRecoverSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({
      message: "参数错误",
      code: "SERVICE_REQUEST_RECOVER_INVALID",
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
  const requestId = String((req.params as Record<string, string>).id || "");
  try {
    return res.status(200).send(
      success(
        await recoverBillingServiceRequestFinanceV1(
          requestId,
          parsed.data.expectedRevision,
          parsed.data.idempotencyKey,
          parsed.data.recoveryEvidenceId,
          context,
        ),
      ),
    );
  } catch (err) {
    return sendBillingError(res, err);
  }
});
