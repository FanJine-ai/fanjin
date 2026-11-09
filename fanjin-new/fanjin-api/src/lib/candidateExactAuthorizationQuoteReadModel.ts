import type { Knex } from "knex";
import { ceilGuChargeMicros, guChargeRoundingVersion } from "@/lib/billingUnits";

import {
  resolveProviderSpecificPricingRule,
  type PricingRule,
} from "@/lib/providerSpecificPricingReadModel";
import { selectPreferredModelRouteScope } from "@/lib/modelRouteScope";
import {
  buildWorkbenchModelCatalog,
  type WorkbenchModelCapability,
  type WorkbenchModelCatalogDatabase,
} from "@/lib/workbenchModelCatalog";
import { listWorkbenchTextModels } from "@/lib/workbenchTextModelCatalog";
import {
  buildCandidateExactAuthorizationCanonicalOperation,
  candidateExactAuthorizationCanonicalJson,
  candidateExactAuthorizationDigest,
  type CandidateExactAuthorizationBillingReadback,
  type CandidateExactAuthorizationCanonicalOperation,
  type CandidateExactAuthorizationEndpointType,
  type CandidateExactAuthorizationKey,
  type CandidateExactAuthorizationMedia,
  type CandidateExactAuthorizationPricingComponent,
} from "@/lib/candidateExactAuthorizationCanonical";
import {
  hasSealedProviderChannelCredential,
  readProviderChannelCredentialCiphertext,
  withoutProviderChannelCredentialCiphertext,
} from "@/lib/providerChannelCredentials";

type Database = WorkbenchModelCatalogDatabase;
type Row = Record<string, any>;

async function applicationDatabase(): Promise<Database> {
  return (await import("@/utils/db")).db;
}

export class CandidateExactAuthorizationQuoteReadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 409) {
    super(code);
    this.name = "CandidateExactAuthorizationQuoteReadError";
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, status = 409): never {
  throw new CandidateExactAuthorizationQuoteReadError(code, status);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function disabled(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizedStringList(value: unknown): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map(text).filter(Boolean))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function canonicalReadValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalReadValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, canonicalReadValue(child)]));
  }
  return value;
}

function safeMultiply(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result <= 0) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PRICING_OVERFLOW");
  }
  return result;
}

function candidateMedia(input: Omit<
  CandidateExactAuthorizationMedia,
  "count" | "ffprobeRequired" | "selfFfprobe"
> & Partial<Pick<
  CandidateExactAuthorizationMedia,
  "count" | "ffprobeRequired" | "selfFfprobe"
>>): CandidateExactAuthorizationMedia {
  return Object.freeze({
    ...input,
    count: input.count ?? 1,
    ffprobeRequired: input.ffprobeRequired ?? true,
    selfFfprobe: input.selfFfprobe ?? true,
  });
}

export type CandidateExactAuthorizationOperationRequest = Readonly<{
  key: string;
  endpointType: CandidateExactAuthorizationEndpointType;
  model: string;
  chargedCallCeiling: number;
  media: CandidateExactAuthorizationMedia | null;
  textInputTokenUpperBound?: number;
  textOutputTokenUpperBound?: number;
  exactVideoTokenUpperBound?: number;
}>;

const IMAGE_MODELS = Object.freeze([
  { id: "doubao-seedream-5-0-260128", qualities: ["2K"] as const },
  { id: "doubao-seedream-4-5-251128", qualities: ["2K", "4K"] as const },
  { id: "doubao-seedream-4-0-250828", qualities: ["1K", "2K", "4K"] as const },
]);
const VIDEO_MODELS = Object.freeze([
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "doubao-seedance-2-0-mini-260615",
] as const);
const TEXT_MODELS = Object.freeze([
  "doubao-seed-2-1-pro-260628",
  "doubao-seed-2-1-turbo-260628",
  "agent-main",
  "claude-opus-4-8",
  "gpt-5.6-luna",
] as const);
const IMAGE_RATIOS = Object.freeze([
  "16:9", "1:1", "4:3", "3:4", "9:16", "3:2", "2:3", "21:9",
] as const);

function selectedImageQuality(
  model: (typeof IMAGE_MODELS)[number],
  ratioIndex: number,
): string {
  if (ratioIndex === 1) return model.qualities[0];
  if (ratioIndex === 2) return model.qualities[model.qualities.length - 1];
  return model.qualities.includes("2K" as never) ? "2K" : model.qualities[0];
}

function fullMatrixRequests(): CandidateExactAuthorizationOperationRequest[] {
  const requests: CandidateExactAuthorizationOperationRequest[] = [];
  for (const model of TEXT_MODELS) {
    requests.push(Object.freeze({
      key: `text/${model}/default`,
      endpointType: "text",
      model,
      chargedCallCeiling: 1,
      media: null,
      textInputTokenUpperBound: 20_000,
      textOutputTokenUpperBound: 8_000,
    }));
  }
  const ratioIndexes = [0, 2, 1, 3, 4, 5, 6, 7];
  for (const ratioIndex of ratioIndexes) {
    for (const model of IMAGE_MODELS) {
      const ratio = IMAGE_RATIOS[ratioIndex];
      requests.push(Object.freeze({
        key: `image/${model.id}/${ratio}`,
        endpointType: "image_generation",
        model: model.id,
        chargedCallCeiling: 1,
        media: candidateMedia({
          kind: "image",
          mode: null,
          resolution: null,
          ratio,
          quality: selectedImageQuality(model, ratioIndex),
          durationSeconds: null,
          generateAudio: null,
        }),
      }));
    }
  }
  for (const model of VIDEO_MODELS) {
    const combinations = [
      { mode: "text_to_video", resolution: "720p" as const, ratio: "16:9", duration: 5, generateAudio: false },
      { mode: "image_to_video", resolution: model === VIDEO_MODELS[0] ? "1080p" as const : "720p" as const, ratio: "9:16", duration: 4, generateAudio: true },
      { mode: "first_last_frame", resolution: "720p" as const, ratio: "16:9", duration: 15, generateAudio: false },
      { mode: "omni_reference", resolution: "720p" as const, ratio: "9:16", duration: 5, generateAudio: true },
    ];
    for (const combination of combinations) {
      requests.push(Object.freeze({
        key: `video/${model}/${combination.mode}`,
        endpointType: "video_generation",
        model,
        chargedCallCeiling: 1,
        media: candidateMedia({
          kind: "video",
          mode: combination.mode,
          resolution: combination.resolution,
          ratio: combination.ratio,
          quality: null,
          durationSeconds: combination.duration,
          generateAudio: combination.generateAudio,
        }),
        exactVideoTokenUpperBound: 60_000 * combination.duration,
      }));
    }
  }
  return requests;
}

export function candidateExactAuthorizationOperationRequests(
  key: CandidateExactAuthorizationKey,
): readonly CandidateExactAuthorizationOperationRequest[] {
  const resolution = key.endsWith("1080p") ? "1080p" as const : "720p" as const;
  if (key === "full-matrix/mixed") return Object.freeze(fullMatrixRequests());
  // Seedance 2.0 Fast is intentionally limited to 720p by the verified
  // production manifest.  The 1080p candidates therefore select the regular
  // Seedance 2.0 route, matching the live catalog selectors used by Canvas and
  // Agent instead of manufacturing an unsupported Fast quote.
  const videoModel = resolution === "1080p"
    ? "doubao-seedance-2-0-260128"
    : "doubao-seedance-2-0-fast-260128";
  const image = candidateMedia({
    kind: "image",
    mode: null,
    resolution: null,
    ratio: "16:9",
    quality: "2K",
    durationSeconds: null,
    generateAudio: null,
    ffprobeRequired: !key.startsWith("quick/"),
    selfFfprobe: !key.startsWith("quick/"),
  });
  const video = candidateMedia({
    kind: "video",
    mode: key.startsWith("canvas/") ? "image_to_video" : "text_to_video",
    resolution,
    ratio: "16:9",
    quality: null,
    durationSeconds: 4,
    generateAudio: false,
    selfFfprobe: !key.startsWith("quick/"),
  });
  if (key.startsWith("quick/")) return Object.freeze([
    Object.freeze({
      key: `${key}/text`, endpointType: "text", model: "agent-main",
      chargedCallCeiling: 1, media: null,
      textInputTokenUpperBound: 20_000, textOutputTokenUpperBound: 8_000,
    }),
    Object.freeze({
      key: `${key}/image`, endpointType: "image_generation",
      model: "doubao-seedream-5-0-260128", chargedCallCeiling: 1, media: image,
    }),
    Object.freeze({
      key: `${key}/video`, endpointType: "video_generation",
      model: videoModel, chargedCallCeiling: 1, media: video,
    }),
  ]);
  if (key.startsWith("canvas/")) return Object.freeze([
    Object.freeze({
      key: `${key}/image`, endpointType: "image_generation",
      model: "doubao-seedream-5-0-260128", chargedCallCeiling: 1, media: image,
    }),
    Object.freeze({
      key: `${key}/video`, endpointType: "video_generation",
      model: videoModel, chargedCallCeiling: 1, media: video,
    }),
  ]);
  return Object.freeze([
    Object.freeze({
      key: `${key}/text`, endpointType: "text", model: "agent-main",
      chargedCallCeiling: 2, media: null,
      textInputTokenUpperBound: 1_114_112,
      textOutputTokenUpperBound: 32_000,
    }),
    Object.freeze({
      key: `${key}/video`, endpointType: "video_generation",
      model: videoModel, chargedCallCeiling: 1, media: video,
    }),
  ]);
}

function routeIdentity(row: Row): Record<string, unknown> {
  return {
    id: text(row.id),
    name: text(row.name),
    scope: text(row.scope),
    workspaceId: row.workspaceId == null ? null : text(row.workspaceId),
    endpointType: text(row.endpointType),
    model: text(row.model),
    provider: text(row.provider),
    channelId: text(row.channelId),
    priority: integer(row.priority),
    fallbackOrder: integer(row.fallbackOrder),
    disabled: disabled(row.disabled),
    createTime: integer(row.createTime ?? row.createdAt),
    updateTime: integer(row.updateTime ?? row.updatedAt),
    version: text(row.version ?? row.revision),
    routeConfigDigest: candidateExactAuthorizationDigest(record(row.routeConfig)),
  };
}

function channelIdentity(row: Row): Record<string, unknown> {
  const config = record(row.configJson);
  const storedCredential = text(row.credentialCiphertext)
    || readProviderChannelCredentialCiphertext(config);
  const configWithoutStoredCredential = withoutProviderChannelCredentialCiphertext(config);
  return {
    id: text(row.id),
    scope: text(row.scope),
    workspaceId: row.workspaceId == null ? null : text(row.workspaceId),
    endpointType: text(row.endpointType),
    provider: text(row.provider),
    baseUrl: text(row.baseUrl),
    priority: integer(row.priority),
    fallbackOrder: integer(row.fallbackOrder),
    weight: integer(row.weight),
    timeoutMs: integer(row.timeoutMs),
    concurrencyLimit: integer(row.concurrencyLimit),
    disabled: disabled(row.disabled),
    healthStatus: text(row.healthStatus),
    createTime: integer(row.createTime ?? row.createdAt),
    // A health probe rewrites updateTime and the lastHealth* telemetry even
    // when the effective channel is unchanged. Those clock/telemetry fields
    // must not invalidate a captured authorization. Semantically relevant
    // health and every dispatch configuration binding remain below.
    version: text(row.version ?? row.revision),
    configDigest: candidateExactAuthorizationDigest(configWithoutStoredCredential),
    // The bounded runtime replaces every real credential binding with one
    // FD6-only sentinel. Authorize the public fact that a binding exists, not
    // the production ref name or randomized sealed ciphertext. Root's FD6
    // builder independently requires and decrypts the real live credential.
    credentialBindingPresent: Boolean(
      text(row.credentialRef)
      || hasSealedProviderChannelCredential(storedCredential),
    ),
    modelNamesDigest: candidateExactAuthorizationDigest(
      normalizedStringList(row.modelNames),
    ),
  };
}

function pricingIdentity(rule: PricingRule): Record<string, unknown> {
  return {
    id: rule.id,
    scope: rule.scope,
    workspaceId: rule.workspaceId,
    endpointType: rule.endpointType,
    provider: rule.provider,
    model: rule.model,
    unit: rule.unit,
    unitPriceMicros: rule.unitPriceMicros,
    currency: rule.currency,
    disabled: rule.disabled,
    createTime: rule.createTime,
    updateTime: rule.updateTime,
    ruleConfig: rule.ruleConfig,
    guChargeRounding: guChargeRoundingVersion,
  };
}

function capabilitySupports(
  capability: WorkbenchModelCapability,
  request: CandidateExactAuthorizationOperationRequest,
): boolean {
  if (!capability.canSubmit || capability.capabilityStatus !== "verified") return false;
  const media = request.media;
  if (!media) return true;
  if (media.kind === "image") {
    return capability.aspectRatios.includes(media.ratio)
      && Boolean(media.quality && capability.qualities?.includes(media.quality));
  }
  return Boolean(
    media.resolution
    && capability.resolutions?.some((value) => value.toLowerCase() === media.resolution)
    && media.mode
    && capability.modes?.includes(media.mode)
    && capability.aspectRatios.includes(media.ratio)
    && media.durationSeconds
    && capability.duration
    && (
      capability.duration.allowed?.includes(media.durationSeconds)
      || (
        media.durationSeconds >= capability.duration.min
        && media.durationSeconds <= capability.duration.max
        && (media.durationSeconds - capability.duration.min) % capability.duration.step === 0
      )
    )
  );
}

async function exactRoute(input: {
  database: Database;
  workspaceId: string;
  endpointType: CandidateExactAuthorizationEndpointType;
  model: string;
}): Promise<{ route: Row; channel: Row }> {
  const rows = await input.database("o_model_route")
    .where({ endpointType: input.endpointType, model: input.model })
    .orderBy("priority", "asc")
    .orderBy("fallbackOrder", "asc")
    .orderBy("createTime", "asc")
    .orderBy("id", "asc");
  const preferred = selectPreferredModelRouteScope(rows, input.workspaceId);
  const enabled = preferred.filter((row) => !disabled(row.disabled));
  if (!enabled.length) return fail("CANDIDATE_EXACT_AUTHORIZATION_ROUTE_UNAVAILABLE");
  const route = enabled[0];
  if (
    enabled.length > 1
    && integer(enabled[1].priority) === integer(route.priority)
    && integer(enabled[1].fallbackOrder) === integer(route.fallbackOrder)
  ) return fail("CANDIDATE_EXACT_AUTHORIZATION_ROUTE_NOT_UNIQUE");
  const channelId = text(route.channelId);
  const provider = text(route.provider);
  if (!channelId || !provider) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_ROUTE_BINDING_INCOMPLETE");
  }
  const channel = await input.database("o_provider_channel")
    .where({ id: channelId, endpointType: input.endpointType, disabled: 0 })
    .first();
  const scoped = channel && (
    (text(channel.scope) === "platform" && channel.workspaceId == null)
    || (
      text(channel.scope) === "workspace"
      && text(channel.workspaceId) === input.workspaceId
    )
  );
  if (
    !scoped
    || text(channel.provider) !== provider
    || text(channel.healthStatus) === "failed"
  ) return fail("CANDIDATE_EXACT_AUTHORIZATION_CHANNEL_UNAVAILABLE");
  return { route, channel };
}

function pricedComponents(input: {
  rule: PricingRule;
  request: CandidateExactAuthorizationOperationRequest;
}): readonly CandidateExactAuthorizationPricingComponent[] {
  const { rule, request } = input;
  if (rule.currency !== "GU" || rule.disabled !== 0 || rule.unitPriceMicros <= 0) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PRICING_INVALID");
  }
  const config = rule.ruleConfig || {};
  const multiplier = Number(config.multiplier ?? 1);
  const minimumMicros = Number(config.minimumMicros ?? 0);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || !Number.isSafeInteger(minimumMicros) || minimumMicros < 0) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PRICING_INVALID");
  }
  const components: CandidateExactAuthorizationPricingComponent[] = [];
  const append = (component: string, unit: string, maximumUnits: number, unitPriceMicros: number) => {
    const raw = safeMultiply(maximumUnits, unitPriceMicros);
    const maximumCostMicros = Math.round(raw * multiplier);
    if (!Number.isSafeInteger(maximumCostMicros) || maximumCostMicros <= 0) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_PRICING_OVERFLOW");
    }
    // Receipt v1 deliberately requires each component to be arithmetically
    // self-contained (`units * unitPrice === cost`).  A fractional pricing
    // multiplier is applied after the base multiplication by billing, so it
    // cannot always be represented as an adjusted per-token price without a
    // rounding error.  Preserve the exact upper bound as one explicit priced
    // unit while the pricing-entry digest binds the source rule/multiplier.
    components.push(multiplier === 1
      ? Object.freeze({ component, unit, maximumUnits, unitPriceMicros, maximumCostMicros })
      : Object.freeze({
          component,
          unit: "priced_upper_bound",
          maximumUnits: 1,
          unitPriceMicros: maximumCostMicros,
          maximumCostMicros,
        }));
  };
  if (request.endpointType === "text") {
    if (rule.unit !== "token") return fail("CANDIDATE_EXACT_AUTHORIZATION_PRICING_UNIT_INVALID");
    const inputUnits = safeMultiply(request.textInputTokenUpperBound || 0, request.chargedCallCeiling);
    const outputUnits = safeMultiply(request.textOutputTokenUpperBound || 0, request.chargedCallCeiling);
    append("input_tokens", "token", inputUnits, integer(config.inputPriceMicros) || rule.unitPriceMicros);
    append("output_tokens", "token", outputUnits, integer(config.outputPriceMicros) || rule.unitPriceMicros);
  } else if (request.endpointType === "image_generation") {
    if (rule.unit !== "image") return fail("CANDIDATE_EXACT_AUTHORIZATION_PRICING_UNIT_INVALID");
    append("image", "image", request.chargedCallCeiling, rule.unitPriceMicros);
  } else if (rule.unit === "token") {
    const configured = integer(config.reservationUpperBoundTokens);
    const units = request.exactVideoTokenUpperBound || configured;
    if (!units) return fail("CANDIDATE_EXACT_AUTHORIZATION_VIDEO_UPPER_BOUND_MISSING");
    append("video_tokens", "token", safeMultiply(units, request.chargedCallCeiling), rule.unitPriceMicros);
  } else if (rule.unit === "task" || rule.unit === "video") {
    append("video", rule.unit, request.chargedCallCeiling, rule.unitPriceMicros);
  } else {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PRICING_UNIT_INVALID");
  }
  const subtotal = components.reduce((sum, component) => sum + component.maximumCostMicros, 0);
  if (minimumMicros > subtotal) {
    components.push(Object.freeze({
      component: "minimum_adjustment",
      unit: "adjustment",
      maximumUnits: 1,
      unitPriceMicros: minimumMicros - subtotal,
      maximumCostMicros: minimumMicros - subtotal,
    }));
  }
  // Each authorized provider call can reserve independently. Include the
  // retail rounding delta explicitly, retaining raw unit rates and arithmetic
  // proof for every component instead of under-authorizing fractional GU.
  const rawTotal = components.reduce((sum, component) => sum + component.maximumCostMicros, 0);
  const roundedTotal = safeMultiply(
    ceilGuChargeMicros(Math.max(Math.ceil(rawTotal / request.chargedCallCeiling), minimumMicros)),
    request.chargedCallCeiling,
  );
  if (roundedTotal > rawTotal) {
    components.push(Object.freeze({ component: "gu_rounding_adjustment", unit: "adjustment",
      maximumUnits: 1, unitPriceMicros: roundedTotal - rawTotal, maximumCostMicros: roundedTotal - rawTotal }));
  }
  return Object.freeze(components);
}

type DirectorySnapshot = Readonly<{
  text: ReadonlyMap<string, Record<string, unknown>>;
  media: ReadonlyMap<string, WorkbenchModelCapability>;
}>;

async function directorySnapshot(
  workspaceId: string,
  database: Database,
): Promise<DirectorySnapshot> {
  const [textModels, catalog] = await Promise.all([
    listWorkbenchTextModels(workspaceId, database, {
      credentialReadMode: "sealed-metadata-only",
    }),
    buildWorkbenchModelCatalog(workspaceId, database, {
      credentialReadMode: "sealed-metadata-only",
    }),
  ]);
  return Object.freeze({
    text: new Map(textModels.map((entry) => [entry.id, entry])),
    media: new Map(catalog.models.map((entry) => [entry.id, entry])),
  });
}

export async function resolveCandidateExactAuthorizationCanonicalOperation(input: {
  workspaceId: string;
  request: CandidateExactAuthorizationOperationRequest;
  database?: Database;
  directory?: DirectorySnapshot;
}): Promise<CandidateExactAuthorizationCanonicalOperation> {
  const database = input.database ?? await applicationDatabase();
  const directory = input.directory || await directorySnapshot(input.workspaceId, database);
  const directoryEntry = input.request.endpointType === "text"
    ? directory.text.get(input.request.model)
    : directory.media.get(input.request.model);
  if (!directoryEntry || (
    input.request.endpointType !== "text"
    && !capabilitySupports(directoryEntry as WorkbenchModelCapability, input.request)
  )) return fail("CANDIDATE_EXACT_AUTHORIZATION_DIRECTORY_UNAVAILABLE");
  const { route, channel } = await exactRoute({
    database,
    workspaceId: input.workspaceId,
    endpointType: input.request.endpointType,
    model: input.request.model,
  });
  const provider = text(channel.provider);
  const rule = await resolveProviderSpecificPricingRule({
    workspaceId: input.workspaceId,
    endpointType: input.request.endpointType,
    provider,
    model: input.request.model,
  }, database);
  if (!rule || rule.provider !== provider || (rule.model && rule.model !== input.request.model)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PRICING_UNAVAILABLE", 402);
  }
  return buildCandidateExactAuthorizationCanonicalOperation({
    key: input.request.key,
    endpointType: input.request.endpointType,
    model: input.request.model,
    provider,
    routeAlias: text(route.name || route.id),
    chargedCallCeiling: input.request.chargedCallCeiling,
    directoryEntry: canonicalReadValue(directoryEntry) as Record<string, unknown>,
    routeEntry: {
      route: routeIdentity(route),
      channel: channelIdentity(channel),
    },
    pricingEntry: pricingIdentity(rule),
    pricingComponents: pricedComponents({ rule, request: input.request }),
    media: input.request.media,
  });
}

export async function resolveCandidateExactAuthorizationCanonicalOperations(input: {
  candidateKey: CandidateExactAuthorizationKey;
  workspaceId: string;
  database?: Database;
}): Promise<readonly CandidateExactAuthorizationCanonicalOperation[]> {
  const database = input.database ?? await applicationDatabase();
  const directory = await directorySnapshot(input.workspaceId, database);
  const operations = await Promise.all(
    candidateExactAuthorizationOperationRequests(input.candidateKey).map(
      (request) => resolveCandidateExactAuthorizationCanonicalOperation({
        workspaceId: input.workspaceId,
        request,
        database,
        directory,
      }),
    ),
  );
  return Object.freeze(operations);
}

export async function readCandidateExactAuthorizationBillingReadback(input: {
  workspaceId: string;
  sessionUserId: number;
  database?: Database;
}): Promise<CandidateExactAuthorizationBillingReadback> {
  const database = input.database ?? await applicationDatabase();
  const [account, owner] = await Promise.all([
    database("o_billing_account").where({ workspaceId: input.workspaceId }).first(),
    database("o_workspace as workspace")
      .leftJoin("o_user as owner", "workspace.ownerUserId", "owner.id")
      .where("workspace.id", input.workspaceId)
      .select(
        "workspace.ownerUserId",
        "owner.defaultWorkspaceId",
        "owner.currentWorkspaceId",
      )
      .first(),
  ]);
  const ownerUserId = Number(owner?.ownerUserId || 0);
  if (!account || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_BILLING_UNAVAILABLE", 402);
  }
  const wallet = await database("o_account_wallet")
    .where({ userId: ownerUserId })
    .first();
  const currency = text(account.currency).toUpperCase();
  const walletCurrency = text(wallet?.currency).toUpperCase();
  const frozenMicros = integer(account.frozenMicros ?? account.reservedMicros);
  const workspaceRemaining = integer(account.balanceMicros) - frozenMicros;
  const walletAvailable = wallet
    ? Math.max(0, integer(wallet.giftBalanceMicros) - integer(wallet.giftReservedMicros))
      + Math.max(0, integer(wallet.balanceMicros) - integer(wallet.cashReservedMicros))
      + Math.max(0, integer(wallet.creditLimitMicros) - integer(wallet.creditUsedMicros) - integer(wallet.creditReservedMicros))
    : -1;
  const availableMicros = Math.min(Math.max(0, workspaceRemaining), walletAvailable);
  if (
    !wallet
    || currency !== "GU"
    || walletCurrency !== "GU"
    || text(account.status) !== "active"
    || text(wallet.status) !== "active"
    || frozenMicros !== 0
    || !Number.isSafeInteger(availableMicros)
    || availableMicros < 0
    || !Number.isSafeInteger(input.sessionUserId)
    || input.sessionUserId <= 0
  ) return fail("CANDIDATE_EXACT_AUTHORIZATION_BILLING_UNAVAILABLE", 402);
  return Object.freeze({
    workspaceId: input.workspaceId,
    sessionUserId: input.sessionUserId,
    account: Object.freeze({
      id: text(account.id),
      workspaceId: text(account.workspaceId),
      currency: "GU" as const,
      availableMicros,
      reservedMicros: 0 as const,
      status: "active" as const,
    }),
    accountWallet: Object.freeze({
      id: text(wallet.id),
      userId: ownerUserId,
      ownerUserId,
      currency: "GU" as const,
      totalAvailableMicros: walletAvailable,
      status: "active" as const,
      defaultWorkspaceId: text(owner.defaultWorkspaceId || owner.currentWorkspaceId) || null,
    }),
  });
}

export function candidateExactAuthorizationReadbackEqual(
  left: CandidateExactAuthorizationBillingReadback,
  right: CandidateExactAuthorizationBillingReadback,
): boolean {
  return candidateExactAuthorizationCanonicalJson(left)
    === candidateExactAuthorizationCanonicalJson(right);
}
