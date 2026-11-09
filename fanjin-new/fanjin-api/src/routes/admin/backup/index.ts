import express from "express";
import { requirePlatformAdmin, requirePlatformRoot } from "@/middleware/permissions";
import {
  listBackupsHandler,
  createBackupHandler,
  restoreBackupHandler,
  deleteBackupHandler,
  cleanupBackupsHandler,
  getBackupConfigHandler,
} from "./handlers";

const router = express.Router();
router.use(requirePlatformAdmin);

router.get("/list", listBackupsHandler);
router.post("/create", requirePlatformRoot, createBackupHandler);
router.post("/restore", requirePlatformRoot, restoreBackupHandler);
router.delete("/delete/:id", requirePlatformRoot, deleteBackupHandler);
router.post("/cleanup", requirePlatformRoot, cleanupBackupsHandler);
router.get("/config", getBackupConfigHandler);

export default router;
