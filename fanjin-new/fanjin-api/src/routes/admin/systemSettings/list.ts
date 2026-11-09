import express from "express";
import {
  GENERIC_ADMIN_PLATFORM_SETTING_DEFINITIONS,
  GENERIC_ADMIN_PLATFORM_SETTING_SECTIONS,
  readGenericAdminPlatformSettings,
} from "@/lib/adminSettingsPartitionRuntime";
import { error, success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

export default router.post("/", async (req, res) => {
  const { settings, items } = await readGenericAdminPlatformSettings();
  try {
    await writeAuditLog(req, {
      action: "admin.system_settings.list",
      resourceType: "system_settings",
      resourceId: "platform",
      required: true,
      metadata: {
        exposedKeys: items.map((item) => item.key),
      },
    });
  } catch {
    return res.status(503).send(error(
      "安全审计暂不可用，设置读取已拒绝",
      { code: "FJADMIN_AUDIT_UNAVAILABLE" },
    ));
  }
  return res.status(200).send(
    success({
      sections: GENERIC_ADMIN_PLATFORM_SETTING_SECTIONS,
      definitions: GENERIC_ADMIN_PLATFORM_SETTING_DEFINITIONS,
      items,
      settings,
    }),
  );
});
