import type { NextFunction, Request, Response } from "express";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export function readRequiredIdempotencyKey(
  req: Request,
  res: Response,
): string | null {
  const idempotencyKey = String(req.header("idempotency-key") || "").trim();
  if (!idempotencyKey) {
    res.status(400).send({
      code: "idempotency_key_required",
      message: "真实生成请求必须提供 Idempotency-Key，以避免重复调用与扣费",
    });
    return null;
  }
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    res.status(400).send({
      code: "idempotency_key_invalid",
      message: `Idempotency-Key 不能超过 ${IDEMPOTENCY_KEY_MAX_LENGTH} 字符`,
    });
    return null;
  }
  return idempotencyKey;
}

export function requireIdempotencyKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!readRequiredIdempotencyKey(req, res)) return;
  next();
}
