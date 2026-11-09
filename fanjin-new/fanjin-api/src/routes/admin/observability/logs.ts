import express from "express";
import { db } from "@/utils/db";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

function parseIntegerQuery(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null;
function parseIntegerQuery(
  value: unknown,
  fallback: undefined,
  minimum: number,
  maximum: number,
): number | null | undefined;
function parseIntegerQuery(
  value: unknown,
  fallback: number | undefined,
  minimum: number,
  maximum: number,
): number | null | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

/**
 * GET /api/admin/observability/logs
 * 查询请求日志（最近的日志记录）
 */
router.get("/", async (req, res) => {
  try {
    const limit = parseIntegerQuery(req.query.limit, 100, 1, 200);
    const offset = parseIntegerQuery(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const startTime = parseIntegerQuery(req.query.startTime, undefined, 0, Number.MAX_SAFE_INTEGER);
    const endTime = parseIntegerQuery(req.query.endTime, undefined, 0, Number.MAX_SAFE_INTEGER);
    const search = req.query.search === undefined
      ? ""
      : typeof req.query.search === "string"
        ? req.query.search.trim()
        : null;
    const invalidRange = startTime !== null && endTime !== null
      && startTime !== undefined && endTime !== undefined
      && startTime > endTime;
    if (
      limit === null
      || offset === null
      || startTime === null
      || endTime === null
      || search === null
      || search.length > 200
      || req.query.level !== undefined
      || invalidRange
    ) {
      return res.status(400).json({ error: "Invalid log query parameters" });
    }
    
    // 从数据库查询请求日志
    let query = db("o_request_log")
      .select("*")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .offset(offset);
    
    // 应用过滤条件
    if (startTime !== undefined) {
      query = query.where("createdAt", ">=", startTime);
    }
    
    if (endTime !== undefined) {
      query = query.where("createdAt", "<=", endTime);
    }
    
    if (search) {
      query = query.where(function() {
        this.where("path", "like", `%${search}%`)
          .orWhere("method", "like", `%${search}%`)
          .orWhere("ip", "like", `%${search}%`);
      });
    }
    
    const logs = await query;
    
    // 获取总数
    const totalQuery = db("o_request_log").count("* as count");
    if (startTime !== undefined) totalQuery.where("createdAt", ">=", startTime);
    if (endTime !== undefined) totalQuery.where("createdAt", "<=", endTime);
    if (search) {
      totalQuery.where(function() {
        this.where("path", "like", `%${search}%`)
          .orWhere("method", "like", `%${search}%`)
          .orWhere("ip", "like", `%${search}%`);
      });
    }
    const [{ count }] = await totalQuery as any;
    
    res.json({
      logs,
      pagination: {
        total: Number(count),
        limit,
        offset,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to get logs:", error);
    res.status(500).json({ error: "Failed to retrieve logs" });
  }
});

export default router;
