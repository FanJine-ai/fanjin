export type ItemBatchSummary = {
  succeededIds: number[];
  failures: string[];
};

export async function settleItemBatch<T, TResult>(
  items: readonly T[],
  worker: (item: T) => Promise<TResult>,
  concurrency = 5,
): Promise<Array<PromiseSettledResult<TResult>>> {
  const results = new Array<PromiseSettledResult<TResult>>(items.length);
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(Number.isFinite(concurrency) ? concurrency : 1)),
  );
  let cursor = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));

  return results;
}

export function summarizeItemBatch<T>(
  items: readonly T[],
  settled: readonly PromiseSettledResult<number>[],
  describe: (item: T) => string,
): ItemBatchSummary {
  const succeededIds: number[] = [];
  const failures: string[] = [];

  items.forEach((item, index) => {
    const result = settled[index];
    if (result?.status === "fulfilled") {
      succeededIds.push(result.value);
      return;
    }
    const reason = result?.status === "rejected" ? result.reason : new Error("未返回提交结果");
    failures.push(
      `${describe(item)}：${reason instanceof Error ? reason.message : "提交失败"}`,
    );
  });

  return { succeededIds, failures };
}

export function retainUnsuccessfulSelection(
  selectedIds: readonly number[],
  succeededIds: readonly number[],
): number[] {
  const succeeded = new Set(succeededIds);
  return selectedIds.filter((id) => !succeeded.has(id));
}
