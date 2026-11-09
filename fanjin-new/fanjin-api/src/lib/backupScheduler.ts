/**
 * Backup Scheduler
 * 
 * Manages automated database backup scheduling using cron.
 * Runs backup jobs at configured intervals and handles retention cleanup.
 */

import * as cron from "node-cron";
import { Knex } from "knex";
import { logger as pinoLogger } from "./logger";
import {
  BackupConfig,
  loadBackupConfig,
  createBackup,
  cleanupOldBackups,
} from "./backup";

const logger = pinoLogger.child({ module: "backup-scheduler" });

let scheduledTask: cron.ScheduledTask | null = null;
let isRunning = false;

export type BackupSchedulerProcessRole = "all" | "api" | "worker" | "unknown";

export type BackupSchedulerState =
  | "disabled"
  | "running_local"
  | "configured_external_status_unknown"
  | "configured_not_running_local";

export interface BackupSchedulerStatus {
  /** Whether automatic backups are enabled by configuration. */
  configured: boolean;
  /** Whether this Node.js process owns a running cron task. */
  localRunning: boolean;
  processRole: BackupSchedulerProcessRole;
  state: BackupSchedulerState;
  /** Only authoritative for a scheduler running in this process. */
  nextBackupTime: Date | null;
}

function currentProcessRole(): BackupSchedulerProcessRole {
  const raw = String(process.env.FANJIN_PROCESS_ROLE || process.env.FANJIN_SERVICE_ROLE || "all")
    .trim()
    .toLowerCase();
  if (raw === "all") return "all";
  if (["api", "server", "web"].includes(raw)) return "api";
  if (["worker", "relay-worker", "relay_worker"].includes(raw)) return "worker";
  return "unknown";
}

/**
 * Describe only what this process can prove. In the production split topology
 * the API and Worker do not share module state, so an API process must not
 * claim that the Worker's cron task is stopped merely because its own singleton
 * is empty.
 */
export function getBackupSchedulerStatus(config: BackupConfig = loadBackupConfig()): BackupSchedulerStatus {
  const localRunning = scheduledTask !== null;
  const processRole = currentProcessRole();
  const state: BackupSchedulerState = !config.enabled
    ? "disabled"
    : localRunning
      ? "running_local"
      : processRole === "api"
        ? "configured_external_status_unknown"
        : "configured_not_running_local";

  return {
    configured: config.enabled,
    localRunning,
    processRole,
    state,
    nextBackupTime: localRunning ? scheduledTask?.getNextRun() ?? null : null,
  };
}

/**
 * Start the backup scheduler
 */
export function startBackupScheduler(database: Knex): void {
  const config = loadBackupConfig();
  
  if (!config.enabled) {
    logger.info("Backup scheduler is disabled");
    return;
  }
  
  // Validate cron expression
  if (!cron.validate(config.schedule)) {
    logger.error({ schedule: config.schedule }, "Invalid cron expression for backup schedule");
    return;
  }
  
  // Stop existing scheduler if running
  if (scheduledTask) {
    stopBackupScheduler();
  }
  
  logger.info({
    schedule: config.schedule,
    retentionDays: config.retentionDays,
    retentionCount: config.retentionCount,
    backupDir: config.backupDir,
    uploadToCloud: config.uploadToCloud,
  }, "Starting backup scheduler");
  
  scheduledTask = cron.schedule(config.schedule, async () => {
    if (isRunning) {
      logger.warn("Backup job is already running, skipping this execution");
      return;
    }
    
    isRunning = true;
    
    try {
      logger.info("Starting scheduled backup job");
      
      // Create backup
      const metadata = await createBackup(database, config);
      logger.info({
        backupId: metadata.id,
        size: metadata.size,
        verified: metadata.verified,
        uploadedToCloud: metadata.uploadedToCloud,
      }, "Scheduled backup completed successfully");
      
      // Cleanup old backups
      const deletedCount = await cleanupOldBackups(config);
      if (deletedCount > 0) {
        logger.info({ deletedCount }, "Cleaned up old backups");
      }
    } catch (error) {
      logger.error({ error }, "Scheduled backup job failed");
    } finally {
      isRunning = false;
    }
  }, {
    timezone: process.env.TZ || "UTC",
  });
  
  logger.info("Backup scheduler started");
}

/**
 * Stop the backup scheduler
 */
export function stopBackupScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info("Backup scheduler stopped");
  }
}

/**
 * Check if backup scheduler is running
 */
export function isBackupSchedulerRunning(): boolean {
  return scheduledTask !== null;
}

/**
 * Get next scheduled backup time
 */
export function getNextBackupTime(): Date | null {
  return scheduledTask?.getNextRun() ?? null;
}
