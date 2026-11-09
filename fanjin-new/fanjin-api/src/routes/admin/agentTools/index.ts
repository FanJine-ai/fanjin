import express from "express";
import roles from "@/routes/agent/config/roles/index";
import role from "@/routes/agent/config/roles/[role]";
import prompts from "@/routes/setting/promptManage/getPrompt";
import updatePrompt from "@/routes/setting/promptManage/updatePrompt";

// Normal app middleware has already checked policy, machine scopes and audit.
// Mounted routers retain their canonical validation, permissions and CAS.
const router = express.Router();
router.use("/roles/:role", role);
router.use("/roles", roles);
router.use("/prompts/update", updatePrompt);
router.use("/prompts", prompts);
export default router;
