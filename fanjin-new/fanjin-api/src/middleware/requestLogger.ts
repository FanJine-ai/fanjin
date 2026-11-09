import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { createRequestLogger, logger } from "@/lib/logger";
import {
  redactRequestLogScalar,
  redactRequestUrl,
  redactSensitive,
} from "@/lib/requestLog";

/**
 * 为每个请求生成唯一 ID 并注入日志实例
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  // 使用客户端提供的请求 ID（如果存在且合法），否则生成新的
  const clientRequestId = req.headers["x-request-id"];
  const safeClientRequestId = typeof clientRequestId === "string"
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(clientRequestId)
    ? redactRequestLogScalar(clientRequestId, 128)
    : null;
  const requestId = safeClientRequestId || randomUUID();

  // 将请求 ID 附加到请求对象
  (req as any).id = requestId;
  
  // 在响应头中返回请求 ID，便于客户端追踪
  res.setHeader("X-Request-ID", requestId);

  next();
}

/**
 * HTTP 请求/响应日志中间件
 * 
 * 功能：
 * - 记录每个请求的方法、URL、用户信息
 * - 记录响应状态码和耗时
 * - 自动关联请求 ID
 * - 错误请求记录更详细的信息
 */
export function httpLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const startTime = Date.now();
  const requestId = (req as any).id;
  const userId = (req as any).userId;
  const workspaceId = (req as any).workspaceId;
  const safeUrl = redactRequestUrl(req.url);

  // 为该请求创建带上下文的日志实例
  const reqLogger = createRequestLogger({ id: requestId, userId, workspaceId });

  // 将日志实例附加到请求对象，供后续使用
  (req as any).logger = reqLogger;

  // 记录请求开始
  reqLogger.info({
    req: {
      method: req.method,
      url: safeUrl,
      headers: {
        "user-agent": redactRequestLogScalar(req.headers["user-agent"]),
        "content-type": redactRequestLogScalar(req.headers["content-type"]),
        "content-length": redactRequestLogScalar(req.headers["content-length"]),
      },
      query: redactSensitive(req.query),
      ip: req.ip || req.socket.remoteAddress,
    },
  }, `→ ${req.method} ${safeUrl}`);

  // 拦截响应结束事件，记录响应
  const originalEnd = res.end as (this: Response, ...args: any[]) => Response;
  res.end = function (this: Response, ...args: any[]) {
    const durationMs = Date.now() - startTime;
    const statusCode = res.statusCode;

    // 根据状态码选择日志级别
    const level = statusCode >= 500 ? "error" 
                : statusCode >= 400 ? "warn" 
                : "info";

    reqLogger[level]({
      res: {
        statusCode,
        headers: {
          "content-type": res.getHeader("content-type"),
          "content-length": res.getHeader("content-length"),
        },
      },
      durationMs,
    }, `← ${req.method} ${safeUrl} ${statusCode} (${durationMs}ms)`);

    // 调用原始的 end 方法
    return originalEnd.apply(this, args);
  };

  next();
}

/**
 * 错误日志中间件
 * 应放在所有错误处理中间件之前，捕获未处理的错误
 */
export function errorLoggerMiddleware(err: Error, req: Request, res: Response, next: NextFunction) {
  const reqLogger = (req as any).logger || logger;
  
  reqLogger.error({
    err: {
      type: err.name,
      message: err.message,
      stack: err.stack,
      ...(err as any).code && { code: (err as any).code },
      ...(err as any).status && { status: (err as any).status },
    },
    req: {
      method: req.method,
      url: redactRequestUrl(req.url),
      headers: redactSensitive(req.headers),
      body: req.path.startsWith("/api/billing/payment/callbacks/")
        ? "[PAYMENT_CALLBACK_REDACTED]"
        : redactSensitive(req.body),
    },
  }, `Unhandled error in ${req.method} ${redactRequestUrl(req.url)}`);

  // 传递给下一个错误处理中间件
  next(err);
}
