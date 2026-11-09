import express from "express";
import { BillingError } from "@/lib/billing";
import { CommercialTenantError, requestCommercialTenant } from "@/lib/commercialTenant";
import {
  createBillingServiceRequest,
  serviceRequestSubmissionFingerprint,
  serviceRequestWorkspaceFingerprint,
  type VerifiedServiceRequestSubmitterV1,
} from "@/lib/billingServiceRequests";
import { serviceRequestSubmitSchema } from "@/lib/serviceRequestRouteSchemas";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("billing:request:create"));

function sendBillingError(res: express.Response, err: unknown) {
  if (err instanceof BillingError) {
    const code =
      "code" in err && typeof err.code === "string" ? err.code : undefined;
    return res.status(err.status).send({ message: err.message, ...(code ? { code } : {}) });
  }
  if (err instanceof CommercialTenantError) {
    return res.status(err.status).send({ message: err.message, code: err.code });
  }
  throw err;
}

export default router.post("/", async (req, res) => {
  const parsed = serviceRequestSubmitSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({
      message: "参数错误",
      code: "SERVICE_REQUEST_SUBMIT_INVALID",
      errors: parsed.error.issues,
    });
  }
  const auth = (req as any).auth || {};
  const createInput = {
    ...parsed.data,
    sellerTenantId: requestCommercialTenant(req).id,
  };
  const userId = Number(auth.user?.id || 0);
  const authorizationRevision = Number(
    auth.user?.authorizationRevision || 0,
  );
  const sessionId = String(auth.session?.id || "");
  const workspaceId = String(auth.workspaceId || "");
  const authenticatedAt = Number(auth.session?.createdAt || 0);
  const expiresAt = Number(auth.session?.expiresAt || 0);
  const identity: VerifiedServiceRequestSubmitterV1 = {
    verificationSource: "central_identity_middleware/v2",
    userId,
    sessionId,
    authorizationRevision,
    canonicalWorkspaceId: workspaceId,
    requestFingerprint: serviceRequestSubmissionFingerprint(
      createInput,
      workspaceId,
    ),
    workspaceFingerprint: serviceRequestWorkspaceFingerprint(workspaceId),
    authenticatedAt,
    expiresAt,
  };
  try {
    const item = await createBillingServiceRequest(createInput, identity);
    return res.status(200).send(success(item));
  } catch (err) {
    return sendBillingError(res, err);
  }
});
