import type { Knex } from "knex";
import { isPostgresClient } from "@/lib/dbDialect";

/**
 * Transaction-scoped PostgreSQL fence for the small model-route
 * certification control plane. It intentionally does not lock Relay or
 * billing tables: ordinary billing has several legitimate row-lock orders,
 * and a broad certification table lock can deadlock unrelated customer work.
 *
 * Every certification mutation (generic batch, Seedance arm/re-arm, and the
 * Seedance pre-dispatch marker) must acquire this fence before its first row
 * lock. The two signed 32-bit keys are stable ASCII-derived constants for the
 * `FJMR` / `CERT` namespace.
 */
export const MODEL_ROUTE_CERTIFICATION_ADVISORY_FENCE_KEYS = [
  0x464a4d52,
  0x43455254,
] as const;

export const MODEL_ROUTE_CERTIFICATION_LOCK_TIMEOUT_MS = 5_000;
export const MODEL_ROUTE_CERTIFICATION_SESSION_RETRY_MS = 25;

function certificationFenceError(
  code: string,
  message: string,
  status: number,
): Error & { code: string; status: number; statusCode: number; retryable: true } {
  return Object.assign(new Error(message), {
    code,
    status,
    statusCode: status,
    retryable: true as const,
  });
}

function postgresPoolMaximum(database: Knex): number {
  return Number(
    (database.client as any)?.pool?.max
      ?? (database.client as any)?.config?.pool?.max,
  );
}

async function acquireDedicatedConnection(database: Knex): Promise<any> {
  const pool = (database.client as any)?.pool;
  if (!pool || typeof pool.acquire !== "function") {
    throw certificationFenceError(
      "model_route_certification_connection_pool_unavailable",
      "模型路由认证专用数据库连接池不可用，请稍后重试",
      503,
    );
  }
  const pending = pool.acquire();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          pending.abort?.();
          reject(certificationFenceError(
            "model_route_certification_connection_timeout",
            "模型路由认证获取专用数据库连接超时，请稍后重试",
            503,
          ));
        }, MODEL_ROUTE_CERTIFICATION_LOCK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function retireDedicatedConnection(
  database: Knex,
  connection: any,
  reason: unknown,
): Promise<void> {
  // Tarn tracks checked-out resources in pool.used. Closing the pg socket is
  // not sufficient: releaseConnection must still remove it from that set.
  // Marking it disposed makes Tarn validation destroy rather than reuse it.
  connection.__knex__disposed = reason instanceof Error
    ? reason
    : new Error(String(reason || "model route certification connection retired"));
  const destroyRawConnection = (database.client as any).destroyRawConnection;
  try {
    if (typeof destroyRawConnection === "function") {
      await destroyRawConnection.call(database.client, connection).catch(() => undefined);
    }
  } finally {
    await database.client.releaseConnection(connection).catch(() => undefined);
  }
}

export async function acquireModelRouteCertificationAdvisoryFence(
  transaction: Knex.Transaction,
): Promise<void> {
  if (!isPostgresClient(transaction)) return;
  // Serialize the whole short mutation on the transaction's existing pooled
  // connection. Waiting is required here: an identical idempotent batch must
  // observe the first committed receipt and converge, while a same-id batch
  // with a different digest must observe that row and return the precise
  // conflict. lock_timeout keeps this bounded and still fails closed when the
  // current control-plane writer cannot finish promptly.
  await transaction.raw("SELECT set_config('lock_timeout', ?, true)", [
    `${MODEL_ROUTE_CERTIFICATION_LOCK_TIMEOUT_MS}ms`,
  ]);
  try {
    await transaction.raw(
      "SELECT pg_advisory_xact_lock(CAST(? AS INTEGER), CAST(? AS INTEGER))",
      [...MODEL_ROUTE_CERTIFICATION_ADVISORY_FENCE_KEYS],
    );
  } catch (error) {
    if (String((error as { code?: unknown } | null)?.code || "") !== "55P03") {
      throw error;
    }
    throw certificationFenceError(
      "model_route_certification_busy",
      "模型路由认证正在由另一项操作更新，请稍后重试",
      409,
    );
  }
}

/**
 * Holds the same fence across work that intentionally spans several database
 * transactions (the internal probe's resolve -> task insert -> GU reserve
 * boundary). The returned release is idempotent and always returns/destroys
 * the dedicated connection; provider I/O must never run while it is held.
 */
export async function acquireModelRouteCertificationSessionFence(
  database: Knex,
): Promise<() => Promise<void>> {
  if (!isPostgresClient(database)) return async () => undefined;
  const poolMaximum = postgresPoolMaximum(database);
  if (!Number.isSafeInteger(poolMaximum) || poolMaximum < 2) {
    throw certificationFenceError(
      "model_route_certification_pool_too_small",
      "Seedance 首认证要求 PostgreSQL 连接池 max >= 2（生产默认 10）",
      503,
    );
  }
  const connection = await acquireDedicatedConnection(database);
  let held = false;
  let released = false;
  try {
    const deadline = Date.now() + MODEL_ROUTE_CERTIFICATION_LOCK_TIMEOUT_MS;
    do {
      const result = await database.raw(
        "SELECT pg_try_advisory_lock(CAST(? AS INTEGER), CAST(? AS INTEGER)) AS acquired",
        [...MODEL_ROUTE_CERTIFICATION_ADVISORY_FENCE_KEYS],
      ).connection(connection);
      if (result?.rows?.[0]?.acquired === true) {
        held = true;
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(MODEL_ROUTE_CERTIFICATION_SESSION_RETRY_MS, remaining),
      ));
    } while (!held);
  } catch (error) {
    // A failed session query can have an ambiguous server-side outcome. End
    // the physical session to release any advisory lock, then remove the
    // resource from Tarn's checked-out set.
    await retireDedicatedConnection(database, connection, error);
    throw error;
  }
  if (!held) {
    await database.client.releaseConnection(connection).catch(() => undefined);
    throw certificationFenceError(
      "model_route_certification_busy",
      "模型路由认证正在由另一项操作更新，请稍后重试",
      409,
    );
  }
  return async () => {
    if (released) return;
    released = true;
    try {
      if (held) {
        const result = await database.raw(
          "SELECT pg_advisory_unlock(CAST(? AS INTEGER), CAST(? AS INTEGER)) AS unlocked",
          [...MODEL_ROUTE_CERTIFICATION_ADVISORY_FENCE_KEYS],
        ).connection(connection);
        const unlocked = Boolean(result?.rows?.[0]?.unlocked);
        if (!unlocked) {
          throw new Error("model route certification session fence was not held");
        }
        held = false;
      }
      await database.client.releaseConnection(connection);
    } catch (error) {
      // Closing the physical PostgreSQL session is the only safe fallback when
      // unlock fails; it must also be released from Tarn's pool.used set.
      await retireDedicatedConnection(database, connection, error);
      throw error;
    }
  };
}
