import pino from "pino";
import type { Logger } from "pino";

export function isProductionLoggerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = String(environment.NODE_ENV || "").trim().toLowerCase();
  return value === "prod" || value === "production";
}

const isDevelopment = !isProductionLoggerEnvironment();
const logLevel = process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info");

/**
 * 创建结构化日志实例
 * 
 * 特性：
 * - 自动包含请求 ID、用户 ID、工作空间 ID 等上下文
 * - 生产环境输出 JSON，开发环境美化输出
 * - 支持日志分级：trace/debug/info/warn/error/fatal
 * - 自动脱敏敏感信息
 */
export function createLogger(options?: {
  name?: string;
  level?: string;
  requestId?: string;
  userId?: number;
  workspaceId?: string;
}): Logger {
  const baseConfig: pino.LoggerOptions = {
    level: options?.level || logLevel,
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => ({
        pid: bindings.pid,
        hostname: bindings.hostname,
      }),
    },
    // 自动脱敏配置
    redact: {
      paths: [
        "password",
        "*.password",
        "token",
        "*.token",
        "accessToken",
        "*.accessToken",
        "refreshToken",
        "*.refreshToken",
        "secret",
        "*.secret",
        "apiKey",
        "*.apiKey",
        "authorization",
        "*.authorization",
        "cookie",
        "*.cookie",
      ],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      name: options?.name,
      env: process.env.NODE_ENV,
      processRole: process.env.FANJIN_PROCESS_ROLE,
    },
  };

  // 开发环境使用美化输出
  if (isDevelopment && !process.env.LOG_JSON) {
    baseConfig.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
        singleLine: false,
      },
    };
  }

  const logger = pino(baseConfig);

  // 添加上下文信息
  if (options?.requestId || options?.userId || options?.workspaceId) {
    return logger.child({
      requestId: options.requestId,
      userId: options.userId,
      workspaceId: options.workspaceId,
    });
  }

  return logger;
}

/**
 * 默认全局日志实例
 */
export const logger = createLogger({ name: "fanjin-api" });

/**
 * 为 Express 请求创建带上下文的日志实例
 */
export function createRequestLogger(req: {
  id?: string;
  userId?: number;
  workspaceId?: string;
}): Logger {
  return logger.child({
    requestId: req.id,
    userId: req.userId,
    workspaceId: req.workspaceId,
  });
}

/**
 * 日志辅助工具
 */
export const loggerUtils = {
  /**
   * 记录错误，自动提取错误堆栈
   */
  logError(logger: Logger, error: unknown, message: string, context?: Record<string, any>) {
    if (error instanceof Error) {
      logger.error({
        err: {
          type: error.name,
          message: error.message,
          stack: error.stack,
        },
        ...context,
      }, message);
    } else {
      logger.error({ error, ...context }, message);
    }
  },

  /**
   * 记录 HTTP 请求
   */
  logRequest(logger: Logger, req: {
    method: string;
    url: string;
    headers?: Record<string, any>;
    body?: any;
  }, context?: Record<string, any>) {
    logger.info({
      req: {
        method: req.method,
        url: req.url,
        headers: req.headers,
        // body 可能包含敏感信息，由 redact 配置处理
        body: req.body,
      },
      ...context,
    }, `${req.method} ${req.url}`);
  },

  /**
   * 记录 HTTP 响应
   */
  logResponse(logger: Logger, res: {
    statusCode: number;
    headers?: Record<string, any>;
  }, durationMs: number, context?: Record<string, any>) {
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level]({
      res: {
        statusCode: res.statusCode,
        headers: res.headers,
      },
      durationMs,
      ...context,
    }, `Response ${res.statusCode} (${durationMs}ms)`);
  },

  /**
   * 记录数据库操作
   */
  logDatabase(logger: Logger, operation: string, table: string, durationMs: number, context?: Record<string, any>) {
    logger.debug({
      db: {
        operation,
        table,
        durationMs,
      },
      ...context,
    }, `DB ${operation} ${table} (${durationMs}ms)`);
  },

  /**
   * 记录外部 API 调用
   */
  logExternalApi(logger: Logger, service: string, method: string, url: string, durationMs: number, statusCode?: number, context?: Record<string, any>) {
    const level = statusCode && statusCode >= 500 ? "error" : statusCode && statusCode >= 400 ? "warn" : "info";
    logger[level]({
      externalApi: {
        service,
        method,
        url,
        statusCode,
        durationMs,
      },
      ...context,
    }, `External API ${service} ${method} ${url} (${durationMs}ms)`);
  },
};
