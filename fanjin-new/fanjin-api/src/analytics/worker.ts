import { db } from "@/utils/db";
import { auditAnalyticsExport } from "./audit";
import { createAnalyticsService } from "./service";
import { createAnalyticsExportService } from "./exportJobs";
let timer: ReturnType<typeof setInterval> | undefined;
let active: Promise<void> | undefined;
export function startAnalyticsExportWorker() {
  if (timer) return;
  const jobs = createAnalyticsExportService(db, createAnalyticsService(db, Date.now, auditAnalyticsExport));
  const tick = () => { if (!active) active = jobs.tick(() => Boolean(timer)).catch(() => { console.error("[analytics-export] processing interrupted; durable jobs retained"); }).finally(() => { active = undefined; }); };
  timer = setInterval(tick, 2000); timer.unref(); tick();
}
export async function stopAnalyticsExportWorker() { if (timer) clearInterval(timer); timer = undefined; await active; }
