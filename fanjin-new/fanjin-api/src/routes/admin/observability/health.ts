import express from "express";
import { db } from "@/utils/db";
import { redisCache } from "@/lib/redisCache";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

/**
 * GET /api/admin/observability/health
 * 获取详细的系统健康状态
 */
router.get("/", async (_req, res) => {
  try {
    // 检查数据库
    let dbStatus = "unknown";
    let dbLatency: number | null = null;
    try {
      const start = Date.now();
      await db.raw("SELECT 1");
      dbLatency = Date.now() - start;
      dbStatus = "healthy";
    } catch (error) {
      dbStatus = "unhealthy";
    }
    
    // 检查 Redis
    const redisProbe = await redisCache.probe();
    
    // 检查 Worker (通过心跳表)
    let workerStatus = "unknown";
    let workerLastSeen: number | undefined;
    try {
      const heartbeat = await db("o_worker_heartbeat")
        .where({ role: "background" })
        .where("heartbeatAt", ">", Date.now() - 60000)
        .orderBy("heartbeatAt", "desc")
        .select("heartbeatAt")
        .first();
      workerLastSeen = heartbeat ? Number(heartbeat.heartbeatAt) : undefined;
      workerStatus = workerLastSeen ? "healthy" : "no_active_workers";
    } catch (error) {
      workerStatus = "unhealthy";
    }
    
    // 计算总体状态
    const isHealthy = dbStatus === "healthy" && 
                     redisProbe.ready;
    
    res.json({
      status: isHealthy ? "healthy" : "unhealthy",
      components: {
        database: {
          status: dbStatus,
          latencyMs: dbLatency,
        },
        redis: {
          status: redisProbe.configured
            ? (redisProbe.ready ? "healthy" : "unhealthy")
            : redisProbe.status,
          configured: redisProbe.configured,
          required: redisProbe.required,
          latencyMs: redisProbe.latencyMs,
        },
        worker: {
          status: workerStatus,
          ...(workerLastSeen ? { lastSeen: workerLastSeen } : {}),
        },
        web: {
          status: "healthy", // 如果能响应这个请求，web 就是健康的
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to get health status:", error);
    res.status(500).json({ 
      status: "unhealthy",
      error: "Failed to retrieve health status",
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
