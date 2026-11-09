export type QuickCreateTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;

export interface QuickCreateTaskListItem {
  videoId: number;
  trackId: number;
  status: QuickCreateTaskStatus;
  createdAt?: number;
  history?: QuickCreateTaskListItem[];
  hiddenHistoryCount?: number;
  [key: string]: unknown;
}

function statusRank(status?: QuickCreateTaskStatus): number {
  // A pending reconciliation is the strongest safety state: even when a
  // stale/older attempt still says running, the UI must surface the billing
  // ambiguity so it cannot offer another paid submission.
  if (status === "pending_reconcile") return 0;
  if (status === "running" || status === "queued") return 1;
  if (status === "succeeded") return 2;
  if (status === "failed" || status === "cancelled") return 3;
  return 4;
}

function compareAttempts(a: QuickCreateTaskListItem, b: QuickCreateTaskListItem): number {
  const statusDelta = statusRank(a.status) - statusRank(b.status);
  if (statusDelta !== 0) return statusDelta;
  return Number(b.createdAt || 0) - Number(a.createdAt || 0);
}

export function collapseQuickCreateTaskRows<T extends QuickCreateTaskListItem>(rows: T[]): Array<T & { history?: T[]; hiddenHistoryCount?: number }> {
  const groups = new Map<number, T[]>();
  rows.forEach((row) => {
    const trackId = Number(row.trackId || 0);
    const group = groups.get(trackId) || [];
    group.push(row);
    groups.set(trackId, group);
  });

  return [...groups.values()]
    .map((group) => {
      const attempts = [...group].sort(compareAttempts);
      const [primary, ...history] = attempts;
      return {
        ...primary,
        history,
        hiddenHistoryCount: history.length,
      };
    })
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}
