export const CANVAS_INLINE_UPLOAD_TIMEOUT_MS = 3 * 60_000;
export const CANVAS_MULTIPART_UPLOAD_TIMEOUT_MS = 15 * 60_000;
export const CANVAS_INLINE_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
export const CANVAS_MEDIA_PREPARATION_TIMEOUT_MS = 15_000;

export class CanvasUploadTimeoutError extends Error {
  readonly code = "CANVAS_UPLOAD_TIMEOUT";

  constructor(readonly timeoutMs: number) {
    super(`上传超过 ${Math.ceil(timeoutMs / 1000)} 秒仍未完成，请重试`);
    this.name = "CanvasUploadTimeoutError";
  }
}

export function getCanvasUploadTimeoutMs(fileSize: number) {
  return fileSize <= CANVAS_INLINE_UPLOAD_LIMIT_BYTES
    ? CANVAS_INLINE_UPLOAD_TIMEOUT_MS
    : CANVAS_MULTIPART_UPLOAD_TIMEOUT_MS;
}

function getAbortReason(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("上传已取消");
  error.name = "AbortError";
  return error;
}

export function isCanvasUploadAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function getCanvasUploadFailurePatch(error: unknown) {
  if (isCanvasUploadAbortError(error)) return null;
  return {
    uploadState: "failed" as const,
    uploadProgress: undefined,
    uploadError: error instanceof Error ? error.message : "上传失败",
  };
}

export interface CanvasUploadAttempt<T> {
  controller: AbortController;
  promise: Promise<T>;
}

/**
 * Gives every Canvas upload a real terminal state. The raced operation may not
 * honour AbortSignal (for example, a stalled object-storage callback), so the
 * abort branch itself rejects and late success is deliberately ignored.
 */
export function startCanvasUploadAttempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; controller?: AbortController },
): CanvasUploadAttempt<T> {
  const controller = options.controller ?? new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: () => void = () => undefined;

  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(getAbortReason(controller.signal));
      return;
    }
    const onAbort = () => reject(getAbortReason(controller.signal));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
  });

  timeoutId = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new CanvasUploadTimeoutError(options.timeoutMs));
    }
  }, Math.max(1, options.timeoutMs));

  const upload = Promise.resolve().then(() => operation(controller.signal));
  const promise = Promise.race([upload, aborted]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    removeAbortListener();
  });

  return { controller, promise };
}

export function startCanvasMediaPreparationAttempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  controller: AbortController,
) {
  return startCanvasUploadAttempt(operation, {
    controller,
    timeoutMs: CANVAS_MEDIA_PREPARATION_TIMEOUT_MS,
  });
}

export interface CanvasUploadProgressNode {
  id: string;
  uploadState?: string;
  uploadProgress?: number;
}

/** Keeps both the node and array identity stable once simulated progress caps. */
export function advanceCanvasUploadProgress<T extends CanvasUploadProgressNode>(
  nodes: readonly T[],
  nodeId: string,
): T[] {
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) return nodes as T[];
  const node = nodes[index];
  const current = typeof node.uploadProgress === "number"
    ? node.uploadProgress
    : node.uploadState === "preparing"
      ? 1
      : 3;
  if (current >= 92) return nodes as T[];
  const nextProgress = Math.min(92, current + (current < 12 ? 3 : current < 45 ? 2 : 1));
  const next = nodes.slice() as T[];
  next[index] = {
    ...node,
    uploadState: node.uploadState === "preparing" ? "uploading" : node.uploadState,
    uploadProgress: nextProgress,
  };
  return next;
}

export interface CanvasUploadPersistenceNode {
  id: string;
  uploadState?: string;
  localPreviewUrl?: string;
  localVideoUrl?: string;
  localAudioUrl?: string;
}

function isEphemeralCanvasUploadUrl(value: string | undefined) {
  return /^blob:/i.test(String(value || ""));
}

export function isCanvasUploadTransientNode(node: CanvasUploadPersistenceNode) {
  return node.uploadState === "preparing"
    || node.uploadState === "uploading"
    || node.uploadState === "failed"
    || isEphemeralCanvasUploadUrl(node.localPreviewUrl)
    || isEphemeralCanvasUploadUrl(node.localVideoUrl)
    || isEphemeralCanvasUploadUrl(node.localAudioUrl);
}

/**
 * Freezes only a transferring node at its last stable snapshot. New transient
 * nodes are omitted until upload succeeds, while unrelated node edits remain
 * persistable and an existing remote node can never be saved as deleted.
 */
export function buildUploadIsolatedPersistenceNodes<T extends CanvasUploadPersistenceNode>(
  nodes: readonly T[],
  stableById: Map<string, T>,
  sanitize: (node: T) => T,
): T[] {
  const currentIds = new Set(nodes.map((node) => node.id));
  const result: T[] = [];

  nodes.forEach((node) => {
    if (isCanvasUploadTransientNode(node)) {
      const stable = stableById.get(node.id);
      if (stable) result.push(stable);
      return;
    }
    const sanitized = sanitize(node);
    stableById.set(node.id, sanitized);
    result.push(sanitized);
  });

  Array.from(stableById.keys()).forEach((nodeId) => {
    if (!currentIds.has(nodeId)) stableById.delete(nodeId);
  });
  return result;
}

export interface CanvasPersistenceEdge {
  fromNodeId: string;
  toNodeId: string;
}

export interface CanvasPersistenceGroup {
  nodeIds: string[];
}

/** Prevents transient-node omission from leaving server-side dangling refs. */
export function filterCanvasGraphForPersistableNodes<
  Edge extends CanvasPersistenceEdge,
  Group extends CanvasPersistenceGroup,
>(
  nodes: readonly CanvasUploadPersistenceNode[],
  edges: readonly Edge[],
  groups: readonly Group[],
): { edges: Edge[]; groups: Group[] } {
  const persistableNodeIds = new Set(nodes.map((node) => node.id));
  return {
    edges: edges.filter((edge) => (
      persistableNodeIds.has(edge.fromNodeId) && persistableNodeIds.has(edge.toNodeId)
    )),
    groups: groups.flatMap((group) => {
      const nodeIds = group.nodeIds.filter((nodeId) => persistableNodeIds.has(nodeId));
      return nodeIds.length > 0 ? [{ ...group, nodeIds }] : [];
    }),
  };
}

export function assertCanvasOperationEpoch(expectedEpoch: number, currentEpoch: number) {
  if (expectedEpoch === currentEpoch) return;
  const error = new Error("画布上下文已切换，操作已取消");
  error.name = "AbortError";
  throw error;
}

export interface KeyedSingleFlightAttempt<Key> {
  key: Key;
  id: number;
  isCurrent(): boolean;
  /** Deferred UI commits survive settlement, but never a replacement/cancel. */
  canCommit(): boolean;
}

export interface KeyedSingleFlight<Key, Output> {
  run(key: Key, worker: (attempt: KeyedSingleFlightAttempt<Key>) => Promise<Output>): Promise<Output>;
  invalidate(key: Key): void;
  invalidateAll(): void;
  isRunning(key: Key): boolean;
}

/** Atomically installs a per-key operation before its async worker can start. */
export function createKeyedSingleFlight<Key, Output>(): KeyedSingleFlight<Key, Output> {
  let nextId = 0;
  const active = new Map<Key, { id: number; promise: Promise<Output> }>();
  const latest = new Map<Key, number>();

  return {
    run(key, worker) {
      const existing = active.get(key);
      if (existing) return existing.promise;

      const id = ++nextId;
      latest.set(key, id);
      const attempt: KeyedSingleFlightAttempt<Key> = {
        key,
        id,
        isCurrent: () => active.get(key)?.id === id,
        canCommit: () => latest.get(key) === id,
      };
      const operation = Promise.resolve().then(() => worker(attempt));
      const tracked = operation.finally(() => {
        if (active.get(key)?.id === id) active.delete(key);
      });
      active.set(key, { id, promise: tracked });
      return tracked;
    },
    invalidate(key) {
      active.delete(key);
      latest.delete(key);
    },
    invalidateAll() {
      active.clear();
      latest.clear();
    },
    isRunning(key) {
      return active.has(key);
    },
  };
}

type QueueBatch<Input, Output> = {
  input: Input;
  generation: number;
  settled: boolean;
  promise: Promise<Output>;
  resolve: (value: Output) => void;
  reject: (reason: unknown) => void;
};

export interface LatestWinsAsyncQueue<Input, Output> {
  enqueue(input: Input): Promise<Output>;
  reset(): void;
  snapshot(): { active: number; pending: number; pendingWaiters: number };
}

/** One active write plus one replaceable pending write, regardless of edit rate. */
export function createLatestWinsAsyncQueue<Input, Output>(
  worker: (input: Input) => Promise<Output>,
  resetValue: Output,
): LatestWinsAsyncQueue<Input, Output> {
  let generation = 0;
  let active: QueueBatch<Input, Output> | null = null;
  let pending: QueueBatch<Input, Output> | null = null;

  const createBatch = (input: Input): QueueBatch<Input, Output> => {
    let resolve!: (value: Output) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Output>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { input, generation, settled: false, promise, resolve, reject };
  };

  const settleWithReset = (batch: QueueBatch<Input, Output> | null) => {
    if (!batch || batch.settled) return;
    batch.settled = true;
    batch.resolve(resetValue);
  };

  const launch = (batch: QueueBatch<Input, Output>) => {
    active = batch;
    void worker(batch.input).then(
      (value) => {
        if (!batch.settled) {
          batch.settled = true;
          batch.resolve(batch.generation === generation ? value : resetValue);
        }
      },
      (error) => {
        if (!batch.settled) {
          batch.settled = true;
          if (batch.generation === generation) batch.reject(error);
          else batch.resolve(resetValue);
        }
      },
    ).finally(() => {
      if (active !== batch) return;
      active = null;
      const next = pending;
      pending = null;
      if (next) launch(next);
    });
  };

  return {
    enqueue(input) {
      if (!active) {
        const batch = createBatch(input);
        launch(batch);
        return batch.promise;
      }
      if (pending) {
        // All pending callers share one fixed drain promise. Replacing only the
        // payload keeps memory bounded without letting explicit save callers
        // continue before the newest write has completed.
        pending.input = input;
        pending.generation = generation;
        return pending.promise;
      }
      pending = createBatch(input);
      return pending.promise;
    },
    reset() {
      generation += 1;
      settleWithReset(active);
      settleWithReset(pending);
      active = null;
      pending = null;
    },
    snapshot() {
      return {
        active: active ? 1 : 0,
        pending: pending ? 1 : 0,
        pendingWaiters: pending ? 1 : 0,
      };
    },
  };
}
