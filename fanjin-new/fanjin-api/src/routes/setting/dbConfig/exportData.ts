import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { listUserTables } from "@/lib/dbDialect";

const router = express.Router();

const SENSITIVE_FIELD_PATTERN = /(password|token|secret|keyHash|credential|apiKey|authorization|cookie)/i;

function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, SENSITIVE_FIELD_PATTERN.test(key) ? "[REDACTED]" : value]),
  );
}

export default router.get("/", requirePlatformAdmin, async (req, res) => {
  try {
    const tables = await listUserTables(db);

    const data: Record<string, any[]> = {};
    for (const table of tables) {
      const rows = await (db as any)(table.name).select("*");
      data[table.name] = Array.isArray(rows) ? rows.map(redactRow) : [];
    }

    const exportData = {
      exportTime: Date.now(),
      tables: data,
    };

    await writeAuditLog(req, {
      action: "database.export",
      resourceType: "database",
      metadata: {
        tableCount: tables.length,
        redacted: true,
      },
    });

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename=fanjin-backup-${Date.now()}.json`);
    res.status(200).send(JSON.stringify(exportData, null, 2));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "导出失败"));
  }
});
