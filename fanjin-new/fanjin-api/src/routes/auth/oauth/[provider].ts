import express from "express";
import { AuthError } from "@/lib/auth";
import { unbindOAuthIdentity } from "@/lib/oauth/service";
import { isOAuthProviderId } from "@/lib/oauth/types";
import { error, success } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { oauthPublicError, toOAuthPublicError } from "@/lib/oauth/errors";

const router = express.Router({ mergeParams: true });

router.delete("/", async (req, res) => {
  try {
    const userId = Number((req as any).user?.id || (req as any).auth?.user?.id || 0);
    if (!userId) throw new AuthError("未登录", 401);
    const providerRaw = String((req.params as any).provider || "");
    if (!isOAuthProviderId(providerRaw)) {
      const publicError = oauthPublicError("UNSUPPORTED_OAUTH_PROVIDER");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const sessionId = String((req as any).auth?.session?.id || "");
    const proofHeader = req.headers["x-fanjin-step-up"];
    const proof = String(
      Array.isArray(proofHeader) ? proofHeader[0] || "" : proofHeader || "",
    ).trim();
    await unbindOAuthIdentity(db as any, {
      userId,
      sessionId,
      proof,
      provider: providerRaw,
      auditContext: req,
    });
    return res.status(200).send(success({ provider: providerRaw }, "已解绑"));
  } catch (err: any) {
    const publicError = toOAuthPublicError(err, {
      code: "OAUTH_UNBIND_FAILED",
    });
    return res.status(publicError.status).send(error(
      publicError.message,
      { code: publicError.code, ...publicError.data },
    ));
  }
});

export default router;
