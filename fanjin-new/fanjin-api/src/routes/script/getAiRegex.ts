import express from "express";

import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { createLegacyPaidCreationGoneHandler } from "@/lib/legacyPaidCreationGone";

const router = express.Router();

export default router.post(
  "/",
  requireActiveWorkspacePermission("project:write"),
  createLegacyPaidCreationGoneHandler({
    route: "/api/script/getAiRegex",
    endpoint: "/api/script/batchAddScript",
    guidance: "请在剧本导入界面确认分集结果后，通过当前批量保存入口写入剧本。",
  }),
);
