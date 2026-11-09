// 请求体大小限制 + 流式超时中间件。
// 参考 NewAPI 的 MAX_REQUEST_BODY_MB 和 STREAMING_TIMEOUT。
import type { Request, Response, NextFunction } from "express";

// 最大请求体（MB），默认 32MB
const CONFIGURED_MAX_BODY_MB = Number(process.env.FANJIN_MAX_REQUEST_BODY_MB);
const MAX_BODY_MB = Number.isFinite(CONFIGURED_MAX_BODY_MB) && CONFIGURED_MAX_BODY_MB > 0 ? CONFIGURED_MAX_BODY_MB : 32;
const MAX_BODY_BYTES = MAX_BODY_MB * 1024 * 1024;
export const REQUEST_BODY_LIMIT_TEXT = `${MAX_BODY_MB}mb`;

// 流式超时（秒），默认 300s
const STREAMING_TIMEOUT_SEC = (() => { const v = Number(process.env.FANJIN_STREAMING_TIMEOUT); return Number.isFinite(v) && v > 0 ? v : 300; })();
// 中转空闲超时（秒），默认 90s
const RELAY_IDLE_TIMEOUT_SEC = (() => { const v = Number(process.env.FANJIN_RELAY_IDLE_TIMEOUT); return Number.isFinite(v) && v > 0 ? v : 90; })();

// 请求体大小限制
export function requestBodyLimit(req: Request, res: Response, next: NextFunction) {
  // This exact authenticated endpoint streams bounded multipart chunks; it never parses JSON.
  if (req.method === "PUT" && /^\/api\/tools\/v1\/uploads\/[0-9a-f-]{36}\/content$/i.test(req.path)) return next();
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return res.status(413).json({
      error: {
        message: `请求体过大（${(contentLength / 1024 / 1024).toFixed(1)}MB），最大允许 ${MAX_BODY_MB}MB`,
        type: "request_too_large",
      },
    });
  }
  next();
}

// 流式响应超时保护：超时后自动结束响应，防止连接挂死
export function streamingTimeout(req: Request, res: Response, next: NextFunction) {
  if (req.headers.accept?.includes("text/event-stream") || (req.body as any)?.stream === true) {
    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        res.end();
      }
    }, STREAMING_TIMEOUT_SEC * 1000);

    // 中转空闲超时：如果一段时间没有数据流动，也结束
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!res.writableEnded) res.end();
      }, RELAY_IDLE_TIMEOUT_SEC * 1000);
    };

    res.on("close", () => {
      clearTimeout(timeout);
      if (idleTimer) clearTimeout(idleTimer);
    });

    // 包装 write 来重置空闲计时器
    const origWrite = res.write.bind(res) as any;
    (res as any).write = (...args: any[]) => {
      resetIdle();
      return origWrite(...args);
    };

    resetIdle();
  }
  next();
}
