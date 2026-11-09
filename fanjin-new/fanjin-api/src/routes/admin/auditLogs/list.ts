import express from "express";
import { z } from "zod";
import { parseAuditMetadata } from "@/lib/audit";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  actorUserId: z.number().int().optional().nullable(),
  action: z.string().optional().nullable(),
  resourceType: z.string().optional().nullable(),
  keyword: z.string().trim().max(200).optional().nullable(),
  startTime: z.number().int().nonnegative().optional().nullable(),
  endTime: z.number().int().nonnegative().optional().nullable(),
  pageNum: z.number().int().optional(),
  pageSize: z.number().int().optional(),
}).strict().superRefine((data, context) => {
  if (data.startTime != null && data.endTime != null && data.startTime > data.endTime) {
    context.addIssue({ code: "custom", path: ["endTime"], message: "endTime 不能早于 startTime" });
  }
});

type AuditLogFilters = z.infer<typeof bodySchema>;

const SENSITIVE_AUDIT_KEY = /authorization|cookie|token|api.?key|provider.?key|access.?key|private.?key|client.?secret|secret|password|credential|signature/i;

function redactAuditText(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\b(fj|fnj|fanjin)_[A-Za-z0-9._-]{12,}\b/gi, "$1_[REDACTED]")
    .replace(
      /\b(?:authorization|cookie|token|apiKey|api_key|providerKey|provider_key|accessKey|access_key|privateKey|private_key|clientSecret|client_secret|credential|secret|password|signature)=([^;,\s&]+)/gi,
      (match) => `${match.split("=")[0]}=[REDACTED]`,
    );
}

export function redactAuditPublicValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_AUDIT_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactAuditText(value);
  if (Array.isArray(value)) return value.map((item) => redactAuditPublicValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, childValue]) => [childKey, redactAuditPublicValue(childValue, childKey)]),
    );
  }
  return value;
}

export function maskAuditIp(value: unknown) {
  if (value == null || value === "") return null;
  const ip = String(value).trim();
  const ipv4 = ip.split(".");
  if (
    ipv4.length === 4
    && ipv4.every((segment) => /^\d{1,3}$/.test(segment) && Number(segment) <= 255)
  ) {
    return `${ipv4[0]}.${ipv4[1]}.×.×`;
  }

  if (ip.includes(":") && /^[0-9a-f:]+$/i.test(ip)) {
    const hextets = ip.split(":").filter(Boolean);
    if (hextets.length > 0 && hextets.length <= 8 && hextets.every((segment) => /^[0-9a-f]{1,4}$/i.test(segment))) {
      return `${hextets.slice(0, 3).join(":")}:…`;
    }
  }
  return "[REDACTED]";
}

function applyFilters(query: any, filters: AuditLogFilters) {
  if (filters.workspaceId) query.where("workspaceId", filters.workspaceId);
  if (filters.actorUserId != null) query.where("actorUserId", filters.actorUserId);
  if (filters.action) query.where("action", filters.action);
  if (filters.resourceType) query.where("resourceType", filters.resourceType);
  if (filters.startTime != null) query.where("createdAt", ">=", filters.startTime);
  if (filters.endTime != null) query.where("createdAt", "<=", filters.endTime);

  const keyword = filters.keyword?.trim().toLowerCase();
  if (keyword) {
    const pattern = `%${keyword}%`;
    query.where((builder: any) => {
      for (const column of ["id", "action", "resourceType", "resourceId", "actorUserId", "actorRole", "workspaceId", "metadata"]) {
        builder.orWhereRaw(`LOWER(COALESCE(CAST(?? AS TEXT), '')) LIKE ?`, [column, pattern]);
      }
    });
  }
  return query;
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const pageNum = Math.max(1, Math.min(Number(parsed.data.pageNum || 1), 500));
  const pageSize = Math.max(1, Math.min(Number(parsed.data.pageSize || 50), 200));
  const query = applyFilters(db("o_audit_log"), parsed.data);

  const countRow = await query.clone().count({ total: "*" }).first();
  const rows = await query
    .clone()
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(pageSize)
    .offset((pageNum - 1) * pageSize);

  res.status(200).send(
    success({
      items: rows.map((row: any) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        actorUserId: row.actorUserId,
        actorRole: row.actorRole,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        ip: maskAuditIp(row.ip),
        userAgent: redactAuditPublicValue(row.userAgent),
        metadata: redactAuditPublicValue(parseAuditMetadata(row.metadata)),
        createdAt: row.createdAt,
      })),
      total: Number((countRow as any)?.total || 0),
      pageNum,
      pageSize,
    }),
  );
});
