import express from "express";
import { z } from "zod";
import {
  updateGenericAdminPlatformSettings,
} from "@/lib/adminSettingsPartitionRuntime";
import { error, success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  settings: z.record(z.string(), z.unknown()),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const { settings, changedKeys } = await updateGenericAdminPlatformSettings(
      parsed.data.settings,
      async (result, trx) => {
        await writeAuditLog(req, {
          action: "admin.system_settings.update",
          resourceType: "system_settings",
          resourceId: "platform",
          required: true,
          metadata: {
            changedKeys: result.changedKeys,
          },
        }, trx);
      },
    );
    return res.status(200).send(success({ settings, changedKeys }));
  } catch (err: any) {
    const auditUnavailable = String(err?.message || "").startsWith("AUDIT_REQUIRED_WRITE_FAILED:");
    const status = auditUnavailable ? 503 : Number(err?.status) || 400;
    return res.status(status).send(error(err?.message || "系统设置保存失败", {
      code: auditUnavailable
        ? "FJADMIN_AUDIT_UNAVAILABLE"
        : String(err?.code || "platform_setting_invalid"),
      ...(err?.reasonCode ? { reasonCode: String(err.reasonCode) } : {}),
      ...(err?.key ? { key: String(err.key) } : {}),
    }));
  }
});
