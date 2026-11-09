import express from "express";
import { AuthError } from "@/lib/auth";
import { toOAuthPublicError } from "@/lib/oauth/errors";
import { listUserOAuthIdentities } from "@/lib/oauth/service";
import { error, success } from "@/lib/responseFormat";
import { db } from "@/utils/db";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    const userId = Number((req as any).user?.id || (req as any).auth?.user?.id || 0);
    if (!userId) throw new AuthError("未登录", 401);
    const identities = await listUserOAuthIdentities(db as any, userId);
    const user = await db("o_user")
      .where({ id: userId, status: "active" })
      .select("password")
      .first();
    if (!user) throw new AuthError("账号不可用", 403, {
      code: "ACCOUNT_UNAVAILABLE",
    });
    return res.status(200).send(success({
      identities,
      passwordBound: Boolean(user.password),
    }));
  } catch (err: unknown) {
    const publicError = toOAuthPublicError(err, {
      code: "OAUTH_IDENTITIES_FAILED",
    });
    return res.status(publicError.status).send(error(
      publicError.message,
      { code: publicError.code },
    ));
  }
});
