import express from "express";
import { listEnabledOAuthProviders, resolveOAuthPublicBaseUrl, buildOAuthCallbackUrl } from "@/lib/oauth/config";
import { toOAuthPublicError } from "@/lib/oauth/errors";
import { error, success } from "@/lib/responseFormat";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    const providers = await listEnabledOAuthProviders();
    const publicBaseUrl = resolveOAuthPublicBaseUrl(
      `${req.protocol}://${req.get("host") || ""}`,
    );
    return res.status(200).send(
      success({
        providers,
        callbacks: publicBaseUrl
          ? Object.fromEntries(
              providers.map((item) => [item.id, buildOAuthCallbackUrl(publicBaseUrl, item.id)]),
            )
          : {},
      }),
    );
  } catch (reason) {
    const publicError = toOAuthPublicError(reason, {
      code: "OAUTH_PROVIDERS_FAILED",
    });
    return res.status(publicError.status).send(error(
      publicError.message,
      { code: publicError.code },
    ));
  }
});
