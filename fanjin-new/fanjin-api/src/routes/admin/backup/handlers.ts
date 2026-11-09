/**
 * Backup Management API
 * 
 * Admin endpoints for managing database backups.
 * 
 * GET /api/admin/backup/list - List all available backups
 * POST /api/admin/backup/create - Create a manual backup
 * POST /api/admin/backup/restore - Refuse online restore; use the offline runbook
 * DELETE /api/admin/backup/delete/:id - Delete a specific backup
 * POST /api/admin/backup/cleanup - Run retention cleanup
 * GET /api/admin/backup/config - Get backup configuration
 */

import { Request, Response } from "express";
import { db } from "@/utils/db";
import {
  loadBackupConfig,
  createBackup,
  listBackups,
  cleanupOldBackups,
} from "@/lib/backup";
import { getBackupSchedulerStatus } from "@/lib/backupScheduler";
import { logger } from "@/lib/logger";
import * as fs from "fs/promises";
import * as path from "path";

function schedulerResponse(config: ReturnType<typeof loadBackupConfig>) {
  const scheduler = getBackupSchedulerStatus(config);
  return {
    configured: scheduler.configured,
    localRunning: scheduler.localRunning,
    processRole: scheduler.processRole,
    state: scheduler.state,
    nextBackupTime: scheduler.nextBackupTime?.toISOString() || null,
  };
}

/**
 * List all available backups
 */
export async function listBackupsHandler(req: Request, res: Response) {
  try {
    const config = loadBackupConfig();
    const backups = await listBackups(config);
    
    res.json({
      backups,
      config: {
        enabled: config.enabled,
        schedule: config.schedule,
        retentionDays: config.retentionDays,
        retentionCount: config.retentionCount,
        uploadToCloud: config.uploadToCloud,
      },
      scheduler: schedulerResponse(config),
    });
  } catch (error) {
    logger.error({ error }, "Failed to list backups");
    res.status(500).json({ error: "Failed to list backups" });
  }
}

/**
 * Create a manual backup
 */
export async function createBackupHandler(req: Request, res: Response) {
  try {
    const config = loadBackupConfig();
    
    logger.info("Creating manual backup");
    const metadata = await createBackup(db as any, config);
    
    res.json({
      success: true,
      backup: metadata,
    });
  } catch (error) {
    logger.error({ error }, "Failed to create backup");
    res.status(500).json({
      error: "Failed to create backup",
      code: "BACKUP_CREATE_FAILED",
    });
  }
}

/**
 * Online restore is deliberately fail-closed. A safe restore requires every
 * API and Worker process to be stopped before the database is replaced; an
 * HTTP handler cannot prove that cluster-wide maintenance boundary.
 */
export async function restoreBackupHandler(_req: Request, res: Response) {
  return res.status(503).json({
    error: "Online database restore is disabled; follow the offline restore runbook",
    code: "BACKUP_RESTORE_OFFLINE_REQUIRED",
  });
}

/**
 * Delete a specific backup
 */
export async function deleteBackupHandler(req: Request, res: Response) {
  try {
    const { id: backupId } = req.params;
    
    if (!backupId) {
      return res.status(400).json({ error: "backupId is required" });
    }
    
    const config = loadBackupConfig();
    const backups = await listBackups(config);
    const backup = backups.find(b => b.id === backupId);
    
    if (!backup) {
      return res.status(404).json({ error: "Backup not found" });
    }
    
    const backupPath = path.join(config.backupDir, backup.filename);
    const metadataPath = path.join(config.backupDir, `${backup.id}.json`);
    
    await fs.unlink(backupPath);
    await fs.unlink(metadataPath);
    
    logger.info({ backupId }, "Deleted backup");
    
    res.json({
      success: true,
      message: "Backup deleted successfully",
      backupId,
    });
  } catch (error) {
    logger.error({ error }, "Failed to delete backup");
    res.status(500).json({
      error: "Failed to delete backup",
      code: "BACKUP_DELETE_FAILED",
    });
  }
}

/**
 * Run retention cleanup
 */
export async function cleanupBackupsHandler(req: Request, res: Response) {
  try {
    const config = loadBackupConfig();
    const deletedCount = await cleanupOldBackups(config);
    
    res.json({
      success: true,
      deletedCount,
      message: `Cleaned up ${deletedCount} old backup(s)`,
    });
  } catch (error) {
    logger.error({ error }, "Failed to cleanup backups");
    res.status(500).json({
      error: "Failed to cleanup backups",
      code: "BACKUP_CLEANUP_FAILED",
    });
  }
}

/**
 * Get backup configuration
 */
export async function getBackupConfigHandler(req: Request, res: Response) {
  try {
    const config = loadBackupConfig();
    
    // Don't expose sensitive credentials
    const safeConfig = {
      enabled: config.enabled,
      schedule: config.schedule,
      retentionDays: config.retentionDays,
      retentionCount: config.retentionCount,
      backupDir: config.backupDir,
      verifyBackup: config.verifyBackup,
      uploadToCloud: config.uploadToCloud,
      s3Bucket: config.s3Bucket,
      s3Region: config.s3Region,
      s3Endpoint: config.s3Endpoint,
      // Credentials are redacted
      s3AccessKeyId: config.s3AccessKeyId ? "***" : undefined,
      s3SecretAccessKey: config.s3SecretAccessKey ? "***" : undefined,
    };
    
    res.json({
      ...safeConfig,
      scheduler: schedulerResponse(config),
    });
  } catch (error) {
    logger.error({ error }, "Failed to get backup config");
    res.status(500).json({ error: "Failed to get backup config" });
  }
}
