import crypto from "node:crypto";
import type { Knex } from "knex";

import {
  handoffLateObjectWriteReceipt,
  markObjectWriteCompensationPending,
  prepareObjectWriteIntent,
  recordObjectWriteReceipt,
  renewObjectWriteIntentClaim,
  type ObjectWriteIntentClaim,
  type ObjectWriteIntentPurpose,
  type ObjectWriteIntentRuntime,
} from "@/lib/objectWriteIntent";
import {
  normalizeObjectKey,
  type ObjectStorageWriteReceipt,
} from "@/lib/objectStorage";
import {
  resolveObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";
import {
  resolveStableObjectDelivery,
} from "@/lib/stableObjectDelivery";
import oss from "@/utils/oss";

export interface DurableObjectWriter {
  writeFile(
    key: string,
    data: Buffer | string,
    options?: { signal?: AbortSignal },
  ): Promise<ObjectStorageWriteReceipt | null>;
  getFileUrl(key: string): Promise<string>;
  compensateFailedWrite?(
    key: string,
    receipt: ObjectStorageWriteReceipt | null,
  ): Promise<void>;
}

export interface DurableObjectWriteHeartbeatScheduler {
  schedule(
    callback: () => void | Promise<void>,
    delayMs: number,
  ): unknown;
  cancel(handle: unknown): void;
}

export interface DurableObjectWriteRuntime extends ObjectWriteIntentRuntime {
  idFactory?: () => string;
  writer?: DurableObjectWriter;
  signal?: AbortSignal;
  heartbeatScheduler?: DurableObjectWriteHeartbeatScheduler;
}

export interface DurableObjectWriteResult {
  intentId: string;
  claim: ObjectWriteIntentClaim;
  storageKey: string;
  url: string;
  receipt: ObjectStorageWriteReceipt | null;
}

function writeFailure(
  primary: unknown,
  recoveryFailures: unknown[],
  intentId: string,
): Error & {
  code: string;
  intentId: string;
  cause?: unknown;
  queueCause?: unknown;
} {
  const error = recoveryFailures.length > 0
    ? new AggregateError(
      [primary, ...recoveryFailures],
      "object PUT failed and one or more durable recovery steps failed",
    )
    : new Error("object PUT failed; durable compensation is queued");
  return Object.assign(error, {
    code: recoveryFailures.length > 0
      ? "OBJECT_WRITE_COMPENSATION_QUEUE_FAILED"
      : "OBJECT_WRITE_FAILED_COMPENSATION_PENDING",
    intentId,
    cause: primary,
    ...(recoveryFailures.length > 0
      ? { queueCause: recoveryFailures[0] }
      : {}),
  });
}

const defaultHeartbeatScheduler: DurableObjectWriteHeartbeatScheduler = {
  schedule(callback, delayMs) {
    const handle = setTimeout(() => {
      void Promise.resolve(callback()).catch(() => undefined);
    }, delayMs);
    handle.unref?.();
    return handle;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function boundedDuration(
  value: unknown,
  fallback: number,
  code: string,
): number {
  const duration = value === undefined || value === null || value === ""
    ? fallback
    : Number(value);
  if (
    !Number.isSafeInteger(duration)
    || duration < 1
    || duration > 24 * 60 * 60_000
  ) {
    throw Object.assign(new Error(code), { code });
  }
  return duration;
}

function createProducerHeartbeat(input: {
  claim: ObjectWriteIntentClaim;
  leaseMs: number;
  runtime: ObjectWriteIntentRuntime;
  scheduler: DurableObjectWriteHeartbeatScheduler;
}) {
  const intervalMs = Math.floor(input.leaseMs / 3);
  if (intervalMs < 1) {
    throw Object.assign(
      new Error("OBJECT_WRITE_INTENT_LEASE_TOO_SHORT"),
      { code: "OBJECT_WRITE_INTENT_LEASE_TOO_SHORT" },
    );
  }
  const controller = new AbortController();
  let scheduled: unknown;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let failure: unknown | null = null;

  const cancelScheduled = () => {
    if (scheduled === undefined) return;
    input.scheduler.cancel(scheduled);
    scheduled = undefined;
  };
  const loseLease = (error: unknown) => {
    if (failure) return;
    failure = error;
    cancelScheduled();
    controller.abort(error);
  };
  const schedule = () => {
    if (stopped || failure) return;
    try {
      scheduled = input.scheduler.schedule(async () => {
        scheduled = undefined;
        if (stopped || failure) return;
        const renewal = renewObjectWriteIntentClaim(
          input.claim,
          input.leaseMs,
          input.runtime,
        )
          .then(() => undefined)
          .catch(loseLease)
          .finally(() => {
            if (inFlight === renewal) inFlight = null;
            schedule();
          });
        inFlight = renewal;
        await renewal;
      }, intervalMs);
    } catch (error) {
      loseLease(error);
    }
  };
  schedule();

  return {
    signal: controller.signal,
    get failure(): unknown | null {
      return failure;
    },
    async stop(): Promise<void> {
      stopped = true;
      cancelScheduled();
      const pending = inFlight;
      if (pending) await pending;
    },
  };
}

export async function writeObjectWithDurableIntent(
  input: {
    purpose: ObjectWriteIntentPurpose;
    workspaceId: string;
    projectId: number;
    body: Buffer;
    contentSha256?: string;
    storageKey: (intentId: string) => string;
    writerIdPrefix: string;
    acceptedGeneration?: boolean;
    leaseMs?: number;
    putTimeoutMs?: number;
    settlementGraceMs?: number;
  },
  runtime: DurableObjectWriteRuntime = {},
): Promise<DurableObjectWriteResult> {
  const intentId = (runtime.idFactory ?? (() => crypto.randomUUID()))();
  const storageKey = normalizeObjectKey(input.storageKey(intentId));
  const expectedSha256 = input.contentSha256
    ?? crypto.createHash("sha256").update(input.body).digest("hex");
  const writerId = `${input.writerIdPrefix}:${process.pid}:${intentId}`;
  const leaseMs = boundedDuration(
    input.leaseMs,
    15 * 60_000,
    "OBJECT_WRITE_INTENT_LEASE_INVALID",
  );
  const putTimeoutMs = boundedDuration(
    input.putTimeoutMs
      ?? process.env.FANJIN_OBJECT_WRITE_PUT_TIMEOUT_MS,
    10 * 60_000,
    "OBJECT_WRITE_PUT_TIMEOUT_INVALID",
  );
  const settlementGraceMs = boundedDuration(
    input.settlementGraceMs
      ?? process.env.FANJIN_OBJECT_WRITE_SETTLEMENT_GRACE_MS,
    5 * 60_000,
    "OBJECT_WRITE_SETTLEMENT_GRACE_INVALID",
  );
  const recoveryGraceMs = putTimeoutMs + settlementGraceMs;
  if (
    !Number.isSafeInteger(recoveryGraceMs)
    || recoveryGraceMs > 24 * 60 * 60_000
  ) {
    throw Object.assign(
      new Error("OBJECT_WRITE_RECOVERY_GRACE_INVALID"),
      { code: "OBJECT_WRITE_RECOVERY_GRACE_INVALID" },
    );
  }
  const configuration = runtime.configuration
    ?? resolveObjectStorageConfiguration();
  const intentRuntime: ObjectWriteIntentRuntime = {
    ...(runtime.database ? { database: runtime.database } : {}),
    ...(runtime.clock ? { clock: runtime.clock } : {}),
    configuration,
  };
  const prepared = await prepareObjectWriteIntent({
    id: intentId,
    purpose: input.purpose,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    objectKey: storageKey,
    expectedSize: input.body.byteLength,
    expectedSha256,
    writerId,
    leaseMs,
    recoveryGraceMs,
    acceptedGeneration: input.acceptedGeneration,
  }, intentRuntime);
  const writer = runtime.writer ?? oss;
  const heartbeat = createProducerHeartbeat({
    claim: prepared.claim,
    leaseMs,
    runtime: intentRuntime,
    scheduler: runtime.heartbeatScheduler ?? defaultHeartbeatScheduler,
  });
  const timeoutSignal = AbortSignal.timeout(putTimeoutMs);
  const writeSignal = AbortSignal.any([
    heartbeat.signal,
    timeoutSignal,
    ...(runtime.signal ? [runtime.signal] : []),
  ]);
  let receipt: ObjectStorageWriteReceipt | null = null;
  let putCompleted = false;
  let receiptRecorded = false;
  let lateReceiptHandedOff = false;
  try {
    receipt = await writer.writeFile(
      storageKey,
      input.body,
      { signal: writeSignal },
    );
    putCompleted = true;
    await heartbeat.stop();
    if (heartbeat.failure) throw heartbeat.failure;
    writeSignal.throwIfAborted();
    await recordObjectWriteReceipt(
      prepared.claim,
      receipt,
      intentRuntime,
    );
    receiptRecorded = true;
    const candidateUrl = await writer.getFileUrl(storageKey);
    const persistentVideo = input.purpose === "relay_final"
      || input.purpose === "video_enhance";
    const delivery = persistentVideo
      ? resolveStableObjectDelivery({
          configuration,
          objectKey: storageKey,
          candidateUrl,
        })
      : null;
    if (persistentVideo && !delivery) {
      throw Object.assign(
        new Error("persistent video requires a stable owned delivery URL"),
        { code: "OBJECT_WRITE_STABLE_DELIVERY_URL_REQUIRED" },
      );
    }
    return {
      intentId,
      claim: prepared.claim,
      storageKey,
      url: delivery?.publicUrl ?? candidateUrl,
      receipt,
    };
  } catch (error) {
    await heartbeat.stop();
    const recoveryFailures: unknown[] = [];
    if (putCompleted && !receiptRecorded) {
      try {
        await handoffLateObjectWriteReceipt(
          prepared.claim,
          receipt,
          intentRuntime,
        );
        lateReceiptHandedOff = true;
      } catch (handoffError) {
        recoveryFailures.push(handoffError);
      }
    }
    if (putCompleted) {
      if (writer.compensateFailedWrite) {
        try {
          await writer.compensateFailedWrite(storageKey, receipt);
        } catch (cleanupError) {
          recoveryFailures.push(cleanupError);
        }
      } else {
        recoveryFailures.push(Object.assign(
          new Error("OBJECT_WRITE_DIRECT_COMPENSATION_UNAVAILABLE"),
          { code: "OBJECT_WRITE_DIRECT_COMPENSATION_UNAVAILABLE" },
        ));
      }
    }
    if (!lateReceiptHandedOff) {
      try {
        await markObjectWriteCompensationPending(
          prepared.claim,
          error,
          intentRuntime,
        );
      } catch (queueError) {
        recoveryFailures.push(queueError);
      }
    }
    throw writeFailure(error, recoveryFailures, intentId);
  }
}

export async function queueDurableObjectWriteCompensation(
  claim: ObjectWriteIntentClaim,
  error: unknown,
  runtime: Pick<
    DurableObjectWriteRuntime,
    "database" | "clock" | "configuration"
  > = {},
): Promise<void> {
  await markObjectWriteCompensationPending(claim, error, runtime);
}

export type DurableObjectWriteTransaction = Knex.Transaction;
