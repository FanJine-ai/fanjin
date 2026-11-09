import { guMicrosPerGu } from "@/lib/billingUnits";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { BillingError } from "@/lib/billing";
import { openSecret, sealSecret } from "@/lib/secretEnvelope";

const TOKEN_VERSION = "quick-create-pricing-confirmation.v1" as const;
const TOKEN_PURPOSE = "quick-create-pricing-confirmation.v1";
export const QUICK_CREATE_PRICING_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;

export type QuickCreatePricingConfirmationKind = "image_batch" | "video_batch";

export interface QuickCreatePricingConfirmationBinding {
  kind: QuickCreatePricingConfirmationKind;
  workspaceId: string;
  actorUserId: number;
  projectId: number | null;
  idempotencyKey: string;
  requestHash: string;
}

export interface QuickCreatePricingAuthorization {
  maximumCostMicros: number | null;
  expiresAt: number | null;
}

type TokenPayload = {
  version: typeof TOKEN_VERSION;
  bindingDigest: string;
  itemMaximumCostMicros: Record<string, number>;
  currency: "GU";
  issuedAt: number;
  expiresAt: number;
};

export interface VerifiedQuickCreatePricingConfirmation {
  itemMaximumCostMicros: Readonly<Record<string, number>>;
  currency: "GU";
  issuedAt: number;
  expiresAt: number;
  expired: boolean;
}

export class QuickCreatePricingConfirmationError extends BillingError {
  readonly code = "pricing_confirmation_required";

  constructor(readonly requiredCostMicros: number) {
    super("价格已更新，请确认本次最高费用后重试", 409);
    this.name = "QuickCreatePricingConfirmationError";
  }
}

export class QuickCreatePricingTokenError extends Error {
  readonly status = 409;
  readonly code = "pricing_confirmation_invalid";

  constructor(message = "价格确认已失效，请重新确认") {
    super(message);
    this.name = "QuickCreatePricingTokenError";
  }
}

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new QuickCreatePricingTokenError(`${field} 无效`);
  }
  return parsed;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new QuickCreatePricingTokenError(`${field} 无效`);
  }
  return parsed;
}

function cleanBinding(input: QuickCreatePricingConfirmationBinding) {
  const workspaceId = String(input.workspaceId || "").trim();
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  const requestHash = String(input.requestHash || "").trim();
  if (
    !["image_batch", "video_batch"].includes(input.kind)
    || !workspaceId
    || !Number.isSafeInteger(input.actorUserId)
    || input.actorUserId <= 0
    || (
      input.projectId !== null
      && (!Number.isSafeInteger(input.projectId) || input.projectId <= 0)
    )
    || !idempotencyKey
    || !/^[a-f0-9]{64}$/.test(requestHash)
  ) {
    throw new QuickCreatePricingTokenError("价格确认请求绑定无效");
  }
  return {
    kind: input.kind,
    workspaceId,
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    idempotencyKeySha256: hashIdempotencyRequest({ idempotencyKey }),
    requestHash,
  };
}

function bindingDigest(input: QuickCreatePricingConfirmationBinding): string {
  return hashIdempotencyRequest(cleanBinding(input));
}

function normalizedItemCosts(input: Readonly<Record<string, number>>): Record<string, number> {
  const entries = Object.entries(input).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length < 1 || entries.length > 16) {
    throw new QuickCreatePricingTokenError("价格确认项目数量无效");
  }
  const output: Record<string, number> = {};
  let total = 0;
  for (const [rawKey, rawCost] of entries) {
    const key = String(rawKey || "").trim();
    if (!key || key.length > 100 || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new QuickCreatePricingTokenError("价格确认项目标识无效");
    }
    const cost = nonNegativeSafeInteger(rawCost, "maximumCostMicros");
    total += cost;
    if (!Number.isSafeInteger(total)) {
      throw new QuickCreatePricingTokenError("价格确认总额超出安全范围");
    }
    output[key] = cost;
  }
  if (total <= 0) throw new QuickCreatePricingTokenError("价格确认总额必须大于零");
  return output;
}

export function issueQuickCreatePricingConfirmation(input: {
  binding: QuickCreatePricingConfirmationBinding;
  itemMaximumCostMicros: Readonly<Record<string, number>>;
  now?: number;
  ttlMs?: number;
}): {
  token: string;
  totalMaximumCostMicros: number;
  currency: "GU";
  expiresAt: number;
} {
  const now = nonNegativeSafeInteger(input.now ?? Date.now(), "issuedAt");
  const ttlMs = positiveSafeInteger(
    input.ttlMs ?? QUICK_CREATE_PRICING_CONFIRMATION_TTL_MS,
    "ttlMs",
  );
  if (ttlMs > QUICK_CREATE_PRICING_CONFIRMATION_TTL_MS) {
    throw new QuickCreatePricingTokenError("价格确认有效期过长");
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new QuickCreatePricingTokenError("价格确认过期时间无效");
  }
  const itemMaximumCostMicros = normalizedItemCosts(input.itemMaximumCostMicros);
  const totalMaximumCostMicros = Object.values(itemMaximumCostMicros)
    .reduce((sum, cost) => sum + cost, 0);
  const payload: TokenPayload = {
    version: TOKEN_VERSION,
    bindingDigest: bindingDigest(input.binding),
    itemMaximumCostMicros,
    currency: "GU",
    issuedAt: now,
    expiresAt,
  };
  return {
    token: sealSecret(JSON.stringify(payload), TOKEN_PURPOSE),
    totalMaximumCostMicros,
    currency: "GU",
    expiresAt,
  };
}

export function verifyQuickCreatePricingConfirmation(input: {
  token: string;
  binding: QuickCreatePricingConfirmationBinding;
  expectedItemKeys: readonly string[];
  now?: number;
}): VerifiedQuickCreatePricingConfirmation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(openSecret(String(input.token || ""), TOKEN_PURPOSE));
  } catch {
    throw new QuickCreatePricingTokenError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QuickCreatePricingTokenError();
  }
  const payload = parsed as Partial<TokenPayload>;
  if (
    payload.version !== TOKEN_VERSION
    || payload.currency !== "GU"
    || payload.bindingDigest !== bindingDigest(input.binding)
    || !payload.itemMaximumCostMicros
    || typeof payload.itemMaximumCostMicros !== "object"
    || Array.isArray(payload.itemMaximumCostMicros)
  ) {
    throw new QuickCreatePricingTokenError();
  }
  const itemMaximumCostMicros = normalizedItemCosts(payload.itemMaximumCostMicros);
  const expectedKeys = [...input.expectedItemKeys].sort();
  const actualKeys = Object.keys(itemMaximumCostMicros).sort();
  if (
    expectedKeys.length !== actualKeys.length
    || expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    throw new QuickCreatePricingTokenError("价格确认与当前批次不匹配");
  }
  const issuedAt = nonNegativeSafeInteger(payload.issuedAt, "issuedAt");
  const expiresAt = positiveSafeInteger(payload.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt) throw new QuickCreatePricingTokenError();
  const now = nonNegativeSafeInteger(input.now ?? Date.now(), "now");
  return Object.freeze({
    itemMaximumCostMicros: Object.freeze(itemMaximumCostMicros),
    currency: "GU" as const,
    issuedAt,
    expiresAt,
    expired: now >= expiresAt,
  });
}

export function assertQuickCreatePricingAuthorization(
  requiredCostMicros: number,
  authorization: QuickCreatePricingAuthorization | null | undefined,
  now = Date.now(),
): void {
  const required = nonNegativeSafeInteger(requiredCostMicros, "requiredCostMicros");
  // This guard exists for paid QuickCreate submissions. An explicitly free
  // server-side price has no spend to consent to and must not become a
  // synthetic positive-price challenge.
  if (required === 0) return;
  const maximum = authorization?.maximumCostMicros;
  const expiresAt = authorization?.expiresAt;
  if (
    maximum == null
    || !Number.isSafeInteger(maximum)
    || maximum < required
    || (expiresAt != null && (!Number.isSafeInteger(expiresAt) || now >= expiresAt))
  ) {
    throw new QuickCreatePricingConfirmationError(required);
  }
}

export function quickCreatePricingChallengeBody(input: {
  token: string;
  totalMaximumCostMicros: number;
  currency: "GU";
  expiresAt: number;
}) {
  return {
    message: "价格已更新，请确认本次最高费用后再次提交",
    code: "pricing_confirmation_required",
    data: {
      pricingConfirmationToken: input.token,
      totalMaximumCostMicros: input.totalMaximumCostMicros,
      maximumCostGu: Number((input.totalMaximumCostMicros / guMicrosPerGu).toFixed(6)),
      currency: input.currency,
      expiresAt: input.expiresAt,
    },
  } as const;
}
