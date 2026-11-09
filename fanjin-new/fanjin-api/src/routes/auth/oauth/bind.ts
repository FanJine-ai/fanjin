import express from "express";
import { z } from "zod";
import { AuthError } from "@/lib/auth";
import { bindOAuthIdentityToExistingAccount } from "@/lib/oauth/service";
import { isOAuthProviderId } from "@/lib/oauth/types";
import { error, success } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { oauthPublicError, toOAuthPublicError } from "@/lib/oauth/errors";

const router = express.Router();

const bodySchema = z.object({
  provider: z.string().min(1),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(128),
  mfaCode: z.string().trim().min(1).max(128).optional(),
}).strict();

export default router.post("/", async (req, res) => {
  try {
    const userId = Number((req as any).user?.id || (req as any).auth?.user?.id || 0);
    if (!userId) throw new AuthError("未登录", 401);
    const parsed = bodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      const publicError = oauthPublicError("OAUTH_REQUEST_INVALID");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    if (!isOAuthProviderId(parsed.data.provider)) {
      const publicError = oauthPublicError("UNSUPPORTED_OAUTH_PROVIDER");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const session = (await bindOAuthIdentityToExistingAccount(db as any, {
      currentUserId: userId,
      provider: parsed.data.provider,
      username: parsed.data.username,
      password: parsed.data.password,
      mfaCredential: parsed.data.mfaCode,
      authInfo: {
        userAgent: Array.isArray(req.headers["user-agent"])
          ? req.headers["user-agent"].join(",")
          : req.headers["user-agent"],
        ip: req.ip,
      },
      auditContext: req,
    })) as any;
    const { rawToken, ...data } = session;
    return res.status(200).send(success(data, "重新验证成功"));
  } catch (err: any) {
    const publicError = toOAuthPublicError(err, {
      code: "OAUTH_BIND_FAILED",
    });
    return res.status(publicError.status).send(error(
      publicError.message,
      { code: publicError.code, ...publicError.data },
    ));
  }
});
