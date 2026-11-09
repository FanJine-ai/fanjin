import { createHash } from "node:crypto";

export class UnsupportedIdempotencyValueError extends TypeError {
  readonly code = "UNSUPPORTED_IDEMPOTENCY_VALUE";

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedIdempotencyValueError";
  }
}

function canonicalize(value: unknown, ancestors: Set<object>): string | undefined {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new UnsupportedIdempotencyValueError("幂等请求不能包含 NaN 或 Infinity");
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "undefined":
      return undefined;
    case "bigint":
    case "function":
    case "symbol":
      throw new UnsupportedIdempotencyValueError(`幂等请求不能包含 ${typeof value}`);
    case "object":
      break;
    default:
      throw new UnsupportedIdempotencyValueError("幂等请求包含不支持的值");
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) throw new UnsupportedIdempotencyValueError("幂等请求不能包含循环引用");
  ancestors.add(objectValue);

  try {
    if (Array.isArray(value)) {
      const items = Array.from(value, (item) => {
        const encoded = canonicalize(item, ancestors);
        if (encoded === undefined) throw new UnsupportedIdempotencyValueError("幂等请求数组不能包含 undefined");
        return encoded;
      });
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new UnsupportedIdempotencyValueError("幂等请求只能包含普通 JSON 对象");
    }

    const record = value as Record<string, unknown>;
    const entries: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = canonicalize(record[key], ancestors);
      if (encoded !== undefined) entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(objectValue);
  }
}

export function canonicalizeIdempotencyRequest(request: unknown): string {
  const encoded = canonicalize(request, new Set());
  if (encoded === undefined) throw new UnsupportedIdempotencyValueError("幂等请求根值不能是 undefined");
  return encoded;
}

export function hashIdempotencyRequest(request: unknown): string {
  return createHash("sha256").update(canonicalizeIdempotencyRequest(request), "utf8").digest("hex");
}

export type IdempotencyRecordState = "reserved" | "completed" | "failed";

export interface IdempotencyRecord<TResult = unknown> {
  scope: string;
  key: string;
  requestHash: string;
  state: IdempotencyRecordState;
  result?: TResult;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export type IdempotencyReservation<TResult = unknown> =
  | { kind: "created"; record: IdempotencyRecord<TResult> }
  | { kind: "existing"; record: IdempotencyRecord<TResult> };

export interface IdempotencyRepository<TResult = unknown> {
  reserve(record: IdempotencyRecord<TResult>): Promise<IdempotencyReservation<TResult>>;
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT";
  readonly scope: string;
  readonly key: string;
  readonly existingRequestHash: string;
  readonly incomingRequestHash: string;

  constructor(input: {
    scope: string;
    key: string;
    existingRequestHash: string;
    incomingRequestHash: string;
  }) {
    super(`幂等键 ${input.scope}:${input.key} 已被不同请求使用`);
    this.name = "IdempotencyConflictError";
    this.scope = input.scope;
    this.key = input.key;
    this.existingRequestHash = input.existingRequestHash;
    this.incomingRequestHash = input.incomingRequestHash;
  }
}

export type IdempotencyResolution<TResult = unknown> =
  | { kind: "reserved"; record: IdempotencyRecord<TResult> }
  | { kind: "replay"; record: IdempotencyRecord<TResult> };

export async function resolveIdempotencyRequest<TResult = unknown>(input: {
  repository: IdempotencyRepository<TResult>;
  scope: string;
  key: string;
  request: unknown;
  now?: number;
}): Promise<IdempotencyResolution<TResult>> {
  const requestHash = hashIdempotencyRequest(input.request);
  const now = input.now ?? Date.now();
  const reservation = await input.repository.reserve({
    scope: input.scope,
    key: input.key,
    requestHash,
    state: "reserved",
    createdAt: now,
    updatedAt: now,
  });

  if (reservation.record.requestHash !== requestHash) {
    throw new IdempotencyConflictError({
      scope: input.scope,
      key: input.key,
      existingRequestHash: reservation.record.requestHash,
      incomingRequestHash: requestHash,
    });
  }

  return reservation.kind === "created"
    ? { kind: "reserved", record: reservation.record }
    : { kind: "replay", record: reservation.record };
}
