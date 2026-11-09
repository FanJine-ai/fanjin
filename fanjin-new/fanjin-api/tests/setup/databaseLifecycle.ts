export type TestDatabaseLifecycle = {
  ready: Promise<unknown>;
  close: () => PromiseLike<unknown> | unknown;
};

type CleanupOptions = {
  readyTimeoutMs?: number;
  closeTimeoutMs?: number;
};

type SettledOperation =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: unknown };

// Schema-52 SQLite initialization normally completes in a few seconds, but a
// cold or contended test volume can exceed the old 5s boundary while still
// making steady progress. Keep enough headroom for that legitimate work while
// preserving a bounded teardown below Vitest's 30s hook timeout when combined
// with the independent close budget.
export const TEST_DATABASE_READY_TIMEOUT_MS = 10_000;
export const TEST_DATABASE_CLOSE_TIMEOUT_MS = 15_000;

export class TestDatabaseCleanupTimeoutError extends Error {
  constructor(operation: "initialization" | "close", timeoutMs: number) {
    super(`测试数据库${operation === "initialization" ? "初始化" : "关闭"}等待超过 ${timeoutMs}ms`);
    this.name = "TestDatabaseCleanupTimeoutError";
  }
}

const settleWithin = async (
  operation: () => PromiseLike<unknown> | unknown,
  timeoutMs: number,
  operationName: "initialization" | "close",
): Promise<SettledOperation> => {
  // Start through a promise boundary so synchronous throws and asynchronous
  // rejections follow the same path. Keep a rejection observer attached after
  // a timeout: the underlying PostgreSQL acquire/migration may reject only
  // after close() destroys the pool and must never become unhandled.
  const operationPromise = Promise.resolve().then(operation);
  void operationPromise.catch(() => undefined);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new TestDatabaseCleanupTimeoutError(operationName, timeoutMs)),
      timeoutMs,
    );
  });

  try {
    return {
      status: "fulfilled",
      value: await Promise.race([operationPromise, timeoutPromise]),
    };
  } catch (reason) {
    return { status: "rejected", reason };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const closeTestDatabaseLifecycles = async (
  lifecycles: Iterable<TestDatabaseLifecycle>,
  options: CleanupOptions = {},
): Promise<void> => {
  const readyTimeoutMs = options.readyTimeoutMs ?? TEST_DATABASE_READY_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? TEST_DATABASE_CLOSE_TIMEOUT_MS;

  const results = await Promise.allSettled([...lifecycles].map(async ({ ready, close }) => {
    const initializationResult = await settleWithin(
      () => ready,
      readyTimeoutMs,
      "initialization",
    );

    // Closing is deliberately unconditional. In particular, a PostgreSQL
    // acquire timeout can exceed Vitest's hook timeout; waiting for `ready`
    // must not prevent Knex destroy() from releasing the pool.
    const closeResult = await settleWithin(close, closeTimeoutMs, "close");

    if (initializationResult.status === "rejected" && closeResult.status === "rejected") {
      throw new AggregateError(
        [initializationResult.reason, closeResult.reason],
        "测试数据库初始化与关闭均失败",
      );
    }
    if (initializationResult.status === "rejected") throw initializationResult.reason;
    if (closeResult.status === "rejected") throw closeResult.reason;
  }));

  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "测试数据库资源清理失败");
};
