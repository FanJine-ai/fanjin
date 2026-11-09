import express from "express";
import { getMetrics } from "@/lib/metrics";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

/**
 * GET /api/admin/observability/metrics
 * 获取实时指标数据
 */
router.get("/", async (_req, res) => {
  try {
    const metrics = getMetrics();
    const totalRequests = metrics.http.requests.total;
    const avgResponseTime = metrics.http.responseTimes.count > 0
      ? metrics.http.responseTimes.total / metrics.http.responseTimes.count
      : 0;
    const memoryUsagePercent = metrics.system.memory.heapTotal > 0
      ? (metrics.system.memory.heapUsed / metrics.system.memory.heapTotal) * 100
      : 0;
    const requestsPerSecond = totalRequests / (metrics.system.uptime || 1);

    res.json({
      ...metrics,
      computed: {
        avgResponseTime,
        memoryUsagePercent,
        requestsPerSecond,
        errorRate: metrics.business.errorRate * 100,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to get metrics:", error);
    res.status(500).json({ error: "Failed to retrieve metrics" });
  }
});

export default router;
