import { startAnalyticsExportWorker, stopAnalyticsExportWorker } from "@/analytics/worker";
import { getToolService } from "./runtime";
let timer: ReturnType<typeof setInterval> | undefined;
let active: Promise<void> | undefined;
export function startToolsWorker() {
  if (timer) return;
  startAnalyticsExportWorker();
  const tick = () => {
    if (active) return;
    active = getToolService().then(async s => { await s.creation?.tick(() => timer !== undefined); await s.canvasRuns?.tick(() => timer !== undefined); }).catch(() => {
      console.error("[tools-worker] polling failed; durable tasks retained");
    }).finally(() => { active = undefined; });
  };
  timer = setInterval(tick, 2000); timer.unref(); tick();
}
export async function stopToolsWorker() {
  if (timer) clearInterval(timer); timer = undefined;
  await Promise.all([active, stopAnalyticsExportWorker()]);
}
