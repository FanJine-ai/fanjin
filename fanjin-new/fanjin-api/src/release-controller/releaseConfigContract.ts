import type { Knex } from "knex";

import {
  evaluateModelRouteCertification,
  modelRouteCertificationStableProjection,
  type ModelRouteCertificationReadiness,
  type ModelRouteCertificationStableProjection,
} from "@/lib/modelRouteCertification";
import {
  evaluateModelRouteCertificationReleaseBatchProof,
  type ModelRouteCertificationReleaseBatchProof,
} from "@/lib/modelRouteCertificationBatch";
import { relayPricingUnits, readVideoTokenReservationUpperBound } from "@/lib/productionPricing";
import {
  assertReleaseConfigExpectationMatchesSnapshot,
  readPinnedReleaseConfigExpectation,
  sha256Canonical,
  type ReleaseConfigExpectation,
  type ReleaseConfigExpectationCaptureDependencies,
} from "../../scripts/lib/release-config-expectation";
import type {
  ReleaseArtifact,
  ReleaseConfigurationVerifier,
  ReleaseNodeConfigurationObservation,
} from "./types";

export const RELEASE_CONFIGURATION_CONTRACT_FORMAT =
  "fanjin-release-configuration-contract/v1" as const;
export const AGENT_SURFACE_CONFIGURATION_FORMAT =
  "fanjin-agent-surface-configuration/v1" as const;
export const RELEASE_ROUTE_CERTIFICATIONS_FORMAT =
  "fanjin-release-route-certifications/v1" as const;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const MODEL_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

type Row = Record<string, unknown>;

export class ReleaseConfigurationContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ReleaseConfigurationContractError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new ReleaseConfigurationContractError(code);
}

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Canonical projections are release evidence, so their ordering cannot depend
 * on the host ICU data or locale. JavaScript relational string comparison is
 * defined in terms of UTF-16 code units and is stable across release nodes.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function enabled(row: Row): boolean {
  return row.disabled === false;
}

function platformRow(row: Row): boolean {
  return row.scope === "platform" && row.workspaceId === null;
}

function healthyChannel(
  channel: Row | undefined,
  health: Row | undefined,
  route: Row,
): channel is Row {
  if (!channel || !health) return false;
  const models = Array.isArray(channel.modelNames)
    ? channel.modelNames.map(text)
    : [];
  const healthStatus = text(health.healthStatus).toLowerCase();
  return enabled(channel)
    && platformRow(channel)
    && channel.endpointType === route.endpointType
    && channel.provider === route.provider
    && channel.credentialBindingPresent === true
    && text(channel.baseUrl).startsWith("https://")
    && (integer(channel.weight) ?? 0) > 0
    && models.includes(text(route.model))
    && health.disabled === false
    && health.credentialBindingPresent === true
    && ["ok", "healthy"].includes(healthStatus);
}

function finalPositiveGuPrice(row: Row, endpointType: string): boolean {
  const ruleConfig = record(row.ruleConfig) ?? {};
  const allowedUnits = relayPricingUnits(endpointType);
  return enabled(row)
    && platformRow(row)
    && row.currency === "GU"
    && Boolean(allowedUnits?.includes(text(row.unit)))
    && (integer(row.unitPriceMicros) ?? 0) > 0
    && ruleConfig.provisional !== true
    && ruleConfig.priceReviewRequired !== true
    && ruleConfig.refreshRequiredBeforeProductionLaunch !== true
    && !["provisional", "unpriced"].includes(text(ruleConfig.pricingStatus).toLowerCase())
    && (
      endpointType !== "video_generation"
      || row.unit !== "token"
      || readVideoTokenReservationUpperBound(ruleConfig) !== null
    );
}

interface SubmitRoute {
  route: Row;
  price: Row;
}

export interface ReleaseRouteCertificationTarget {
  endpointType: "image_generation" | "text" | "video_generation";
  pricingRuleId: string;
  routeId: string;
}

function submitRoutes(
  expectation: ReleaseConfigExpectation,
  endpointType: "image_generation" | "video_generation",
): SubmitRoute[] {
  const readback = expectation.expectedReadback;
  const channelById = new Map(readback.channelBindings.map((row) => [text(row.id), row]));
  const healthById = new Map(readback.channelHealth.map((row) => [text(row.id), row]));
  const capabilityByRoute = new Map(readback.capabilities.map((row) => [text(row.routeId), row]));
  return readback.modelRoutes.flatMap((route) => {
    if (
      route.endpointType !== endpointType
      || !enabled(route)
      || !platformRow(route)
      || !text(route.model)
      || !text(route.provider)
      || (endpointType === "video_generation" && route.provider !== "volcano")
    ) return [];
    const capability = capabilityByRoute.get(text(route.id));
    if (!capability || text(capability.capabilityStatus).toLowerCase() !== "verified") return [];
    const channelId = text(route.channelId);
    if (!healthyChannel(channelById.get(channelId), healthById.get(channelId), route)) return [];
    const price = readback.pricing.find((candidate) => (
      candidate.endpointType === route.endpointType
      && candidate.provider === route.provider
      && candidate.model === route.model
      && finalPositiveGuPrice(candidate, endpointType)
    ));
    return price ? [{ route, price }] : [];
  });
}

export interface ProductionReleaseConfigSemantics {
  agentRouteId: string;
  agentTokenPricingRuleId: string;
  agentChatPricingRuleId: string;
  certificationTargets: readonly ReleaseRouteCertificationTarget[];
  imageRouteIds: readonly string[];
  videoRouteIds: readonly string[];
  fingerprint: string;
}

/**
 * Proves that an exact snapshot is useful, not merely self-consistent. The
 * selected routes must have a healthy credential-bound channel and final,
 * positive, provider-specific GU pricing—the same facts needed for canSubmit.
 */
export function inspectProductionReleaseConfigSemantics(
  expectation: ReleaseConfigExpectation,
): ProductionReleaseConfigSemantics {
  const readback = expectation.expectedReadback;
  const channelById = new Map(readback.channelBindings.map((row) => [text(row.id), row]));
  const healthById = new Map(readback.channelHealth.map((row) => [text(row.id), row]));
  const agentRoute = readback.modelRoutes.find((route) => (
    route.endpointType === "text"
    && route.model === "agent-main"
    && enabled(route)
    && platformRow(route)
  ));
  if (!agentRoute || !text(agentRoute.provider) || !text(agentRoute.channelId)) {
    return fail("RELEASE_CONFIG_AGENT_ROUTE_MISSING");
  }
  const agentChannelId = text(agentRoute.channelId);
  if (!healthyChannel(
    channelById.get(agentChannelId),
    healthById.get(agentChannelId),
    agentRoute,
  )) return fail("RELEASE_CONFIG_AGENT_ROUTE_NOT_CALLABLE");
  const routeConfig = record(agentRoute.routeConfig) ?? {};
  const upstreamModel = text(routeConfig.upstreamModel);
  if (!upstreamModel) return fail("RELEASE_CONFIG_AGENT_UPSTREAM_MISSING");

  const tokenPrice = readback.pricing.find((row) => (
    row.endpointType === "text"
    && row.provider === agentRoute.provider
    && row.model === "agent-main"
    && row.unit === "token"
    && finalPositiveGuPrice(row, "text")
  ));
  if (!tokenPrice) return fail("RELEASE_CONFIG_AGENT_TOKEN_PRICE_INVALID");
  const tokenPriceConfig = record(tokenPrice.ruleConfig) ?? {};
  if (
    text(tokenPriceConfig.upstreamModel) !== upstreamModel
    || text(tokenPriceConfig.aliasOf) !== upstreamModel
  ) return fail("RELEASE_CONFIG_AGENT_ALIAS_PRICE_MISMATCH");

  const chatPrice = readback.pricing.find((row) => (
    row.endpointType === "agent_chat"
    && row.provider === null
    && row.model === "agent-main"
    && row.unit === "run"
    && row.currency === "GU"
    && row.unitPriceMicros === 0
    && enabled(row)
    && platformRow(row)
  ));
  const chatPriceConfig = record(chatPrice?.ruleConfig) ?? {};
  if (
    !chatPrice
    || chatPriceConfig.billingMode !== "relay_token"
    || chatPriceConfig.additionalRunChargeMicros !== 0
    || chatPriceConfig.tokenPricingRuleId !== tokenPrice.id
  ) return fail("RELEASE_CONFIG_AGENT_CHAT_PRICE_INVALID");

  const imageRoutes = submitRoutes(expectation, "image_generation");
  const videoRoutes = submitRoutes(expectation, "video_generation");
  if (imageRoutes.length === 0) return fail("RELEASE_CONFIG_IMAGE_CAN_SUBMIT_MISSING");
  if (videoRoutes.length === 0) return fail("RELEASE_CONFIG_VIDEO_CAN_SUBMIT_MISSING");

  const stable = {
    agentChatPricingRuleId: text(chatPrice.id),
    agentRouteId: text(agentRoute.id),
    agentTokenPricingRuleId: text(tokenPrice.id),
    image: imageRoutes.map(({ route, price }) => ({
      priceId: text(price.id),
      routeId: text(route.id),
    })).sort((left, right) => compareCodeUnits(left.routeId, right.routeId)),
    video: videoRoutes.map(({ route, price }) => ({
      priceId: text(price.id),
      routeId: text(route.id),
    })).sort((left, right) => compareCodeUnits(left.routeId, right.routeId)),
  };
  const certificationTargets = [
    {
      endpointType: "text" as const,
      pricingRuleId: stable.agentTokenPricingRuleId,
      routeId: stable.agentRouteId,
    },
    ...stable.image.map((row) => ({
      endpointType: "image_generation" as const,
      pricingRuleId: row.priceId,
      routeId: row.routeId,
    })),
    ...stable.video.map((row) => ({
      endpointType: "video_generation" as const,
      pricingRuleId: row.priceId,
      routeId: row.routeId,
    })),
  ].sort((left, right) => (
    compareCodeUnits(left.endpointType, right.endpointType)
      || compareCodeUnits(left.routeId, right.routeId)
      || compareCodeUnits(left.pricingRuleId, right.pricingRuleId)
  ));
  return {
    agentRouteId: stable.agentRouteId,
    agentTokenPricingRuleId: stable.agentTokenPricingRuleId,
    agentChatPricingRuleId: stable.agentChatPricingRuleId,
    certificationTargets,
    imageRouteIds: stable.image.map((row) => row.routeId),
    videoRouteIds: stable.video.map((row) => row.routeId),
    fingerprint: sha256Canonical(stable),
  };
}

export type ReleaseRouteCertificationInspector = (input: Readonly<{
  database: Knex | Knex.Transaction;
  pricingRule: Row;
  route: Row;
}>) => Promise<ModelRouteCertificationReadiness>;

export type ReleaseRouteCertificationBatchInspector = (input: Readonly<{
  database: Knex | Knex.Transaction;
  expectedReleaseId: string;
  expectedSourceCommit: string;
  readiness: ModelRouteCertificationReadiness;
}>) => Promise<ModelRouteCertificationReleaseBatchProof>;

interface ReleaseRouteCertificationsProjection {
  format: typeof RELEASE_ROUTE_CERTIFICATIONS_FORMAT;
  routes: Array<{
    endpointType: ReleaseRouteCertificationTarget["endpointType"];
    readiness: ModelRouteCertificationStableProjection;
    releaseBatch: ModelRouteCertificationReleaseBatchProof;
  }>;
}

function assertCompleteRouteCertification(
  target: ReleaseRouteCertificationTarget,
  readiness: ModelRouteCertificationReadiness,
): void {
  if (
    !readiness.tableReady
    || !readiness.valid
    || readiness.routeId !== target.routeId
    || readiness.pricingRuleId !== target.pricingRuleId
    || readiness.requiredOperations.length === 0
    || readiness.operations.length !== readiness.requiredOperations.length
  ) return fail("RELEASE_CONFIG_ROUTE_CERTIFICATION_INVALID");
  const required = [...readiness.requiredOperations].sort();
  const observed = readiness.operations.map((operation) => operation.operationKey).sort();
  if (
    !required.includes("route")
    || new Set(required).size !== required.length
    || new Set(observed).size !== observed.length
    || required.some((operation, index) => operation !== observed[index])
    || readiness.operations.some((operation) => (
      operation.required !== true
      || operation.valid !== true
      || operation.status !== "valid"
    ))
  ) return fail("RELEASE_CONFIG_ROUTE_CERTIFICATION_INVALID");
}

function assertReleaseBatchProof(
  readiness: ModelRouteCertificationReadiness,
  proof: ModelRouteCertificationReleaseBatchProof,
  expectedReleaseId: string,
  expectedSourceCommit: string,
): void {
  const expectedCertifications = readiness.operations
    .map((operation) => ({
      certificationId: text(operation.certification?.id),
      operationKey: operation.operationKey,
    }))
    .sort((left, right) => compareCodeUnits(left.operationKey, right.operationKey));
  const observedCertifications = [...proof.requiredCertifications]
    .sort((left, right) => compareCodeUnits(left.operationKey, right.operationKey));
  if (
    proof.valid !== true
    || proof.reason !== null
    || proof.format !== "model-route-certification-release-batch-proof/v1"
    || proof.registryIdentity !== "o_model_route_certification_batch"
    || proof.requiredAuditAction !== "admin.model_route.certification_batch_apply"
    || !text(proof.batchId)
    || !SHA256_RE.test(text(proof.batchDigest))
    || proof.releaseId !== expectedReleaseId
    || proof.sourceCommit !== expectedSourceCommit
    || !Number.isSafeInteger(proof.actorUserId)
    || (proof.actorUserId ?? 0) <= 0
    || !Number.isSafeInteger(proof.entryCount)
    || (proof.entryCount ?? 0) <= 0
    || !Number.isSafeInteger(proof.appliedAt)
    || (proof.appliedAt ?? 0) <= 0
    || expectedCertifications.some((certification) => !certification.certificationId)
    || expectedCertifications.length !== observedCertifications.length
    || expectedCertifications.some((certification, index) => (
      certification.operationKey !== observedCertifications[index]?.operationKey
      || certification.certificationId !== observedCertifications[index]?.certificationId
    ))
  ) return fail("RELEASE_CONFIG_ROUTE_CERTIFICATION_BATCH_INVALID");
}

export interface AgentSurfaceConfiguration {
  format: typeof AGENT_SURFACE_CONFIGURATION_FORMAT;
  modelAlias: string;
  required: boolean;
  switches: {
    billingReconciliation: boolean;
    generationSubmit: boolean;
    model: boolean;
    runtime: boolean;
    tools: boolean;
    worker: boolean;
  };
}

export function expectedProductionAgentSurface(
  modelAlias = "agent-main",
): AgentSurfaceConfiguration {
  if (!MODEL_ALIAS_RE.test(modelAlias)) return fail("RELEASE_CONFIG_AGENT_ALIAS_INVALID");
  return {
    format: AGENT_SURFACE_CONFIGURATION_FORMAT,
    modelAlias,
    required: true,
    switches: {
      billingReconciliation: true,
      generationSubmit: true,
      model: true,
      runtime: true,
      tools: true,
      worker: true,
    },
  };
}

export function agentSurfaceConfigurationFingerprint(
  configuration: AgentSurfaceConfiguration,
): string {
  return sha256Canonical(configuration);
}

export interface ReleaseConfigurationContract {
  format: typeof RELEASE_CONFIGURATION_CONTRACT_FORMAT;
  sourceCommit: string;
  artifactSha256: string;
  schemaVersion: number;
  expectation: ReleaseConfigExpectation;
  expectationCanonicalSha256: string;
  expectationSnapshotSha256: string;
  agentSurface: AgentSurfaceConfiguration;
  agentSurfaceFingerprint: string;
  semanticFingerprint: string;
  fingerprint: string;
}

export function createReleaseConfigurationContract(input: Readonly<{
  expectation: ReleaseConfigExpectation;
  expectationCanonicalSha256: string;
  sourceCommit: string;
  artifactSha256: string;
  schemaVersion: number;
  agentModelAlias: string;
  expectedAgentSurfaceFingerprint: string;
}>): ReleaseConfigurationContract {
  if (!SOURCE_COMMIT_RE.test(input.sourceCommit)) return fail("RELEASE_CONFIG_SOURCE_COMMIT_INVALID");
  if (!SHA256_RE.test(input.artifactSha256)) return fail("RELEASE_CONFIG_ARTIFACT_SHA_INVALID");
  if (!SHA256_RE.test(input.expectationCanonicalSha256)) {
    return fail("RELEASE_CONFIG_EXPECTATION_SHA_INVALID");
  }
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    return fail("RELEASE_CONFIG_SCHEMA_VERSION_INVALID");
  }
  if (input.expectation.expectedReadback.schema.version !== input.schemaVersion) {
    return fail("RELEASE_CONFIG_EXPECTATION_SCHEMA_MISMATCH");
  }
  if (sha256Canonical(input.expectation) !== input.expectationCanonicalSha256) {
    return fail("RELEASE_CONFIG_EXPECTATION_SHA_MISMATCH");
  }
  const agentSurface = expectedProductionAgentSurface(input.agentModelAlias);
  if (agentSurface.modelAlias !== "agent-main") {
    return fail("RELEASE_CONFIG_AGENT_MAIN_ALIAS_REQUIRED");
  }
  const agentSurfaceFingerprint = agentSurfaceConfigurationFingerprint(agentSurface);
  if (
    !SHA256_RE.test(input.expectedAgentSurfaceFingerprint)
    || input.expectedAgentSurfaceFingerprint !== agentSurfaceFingerprint
  ) return fail("RELEASE_CONFIG_AGENT_FINGERPRINT_MISMATCH");
  const semantics = inspectProductionReleaseConfigSemantics(input.expectation);
  const identity = {
    agentSurfaceFingerprint,
    artifactSha256: input.artifactSha256,
    expectationCanonicalSha256: input.expectationCanonicalSha256,
    expectationSnapshotSha256: input.expectation.expectedReadback.snapshotSha256,
    format: RELEASE_CONFIGURATION_CONTRACT_FORMAT,
    schemaVersion: input.schemaVersion,
    semanticFingerprint: semantics.fingerprint,
    sourceCommit: input.sourceCommit,
  };
  return {
    ...identity,
    expectation: input.expectation,
    agentSurface,
    fingerprint: sha256Canonical(identity),
  };
}

function requiredEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = String(environment[name] ?? "").trim();
  if (!value) return fail("RELEASE_CONFIG_ENVIRONMENT_INCOMPLETE");
  return value;
}

/** Startup-only loader. The file reader enforces a canonical absolute path,
 * root ownership, the trusted service group, one link, read-only mode and both
 * raw/canonical pins. */
export function loadReleaseConfigurationContract(
  environment: NodeJS.ProcessEnv = process.env,
): ReleaseConfigurationContract {
  const expectationCanonicalSha256 = requiredEnv(
    environment,
    "FANJIN_RELEASE_CONFIG_EXPECTATION_CANONICAL_SHA256",
  );
  const expectation = readPinnedReleaseConfigExpectation({
    file: requiredEnv(environment, "FANJIN_RELEASE_CONFIG_EXPECTATION_FILE"),
    rawSha256: requiredEnv(environment, "FANJIN_RELEASE_CONFIG_EXPECTATION_RAW_SHA256"),
    canonicalSha256: expectationCanonicalSha256,
    trustedGroupGid: typeof process.getgid === "function" ? process.getgid() : undefined,
  });
  const schemaRaw = requiredEnv(environment, "FANJIN_RELEASE_EXPECTED_SCHEMA_VERSION");
  if (!/^[1-9][0-9]*$/u.test(schemaRaw)) return fail("RELEASE_CONFIG_SCHEMA_VERSION_INVALID");
  return createReleaseConfigurationContract({
    expectation,
    expectationCanonicalSha256,
    sourceCommit: requiredEnv(environment, "FANJIN_RELEASE_EXPECTED_SOURCE_COMMIT"),
    artifactSha256: requiredEnv(environment, "FANJIN_RELEASE_EXPECTED_ARTIFACT_SHA256"),
    schemaVersion: Number(schemaRaw),
    agentModelAlias: requiredEnv(environment, "FANJIN_RELEASE_EXPECTED_AGENT_MODEL_ALIAS"),
    expectedAgentSurfaceFingerprint: requiredEnv(
      environment,
      "FANJIN_RELEASE_EXPECTED_AGENT_SURFACE_FINGERPRINT",
    ),
  });
}

function assertArtifactBinding(
  contract: ReleaseConfigurationContract,
  artifact: ReleaseArtifact,
): void {
  if (artifact.sourceCommit !== contract.sourceCommit) {
    return fail("RELEASE_CONFIG_SOURCE_COMMIT_MISMATCH");
  }
  if (artifact.sha256 !== contract.artifactSha256) {
    return fail("RELEASE_CONFIG_ARTIFACT_SHA_MISMATCH");
  }
  if (artifact.schemaVersion !== contract.schemaVersion) {
    return fail("RELEASE_CONFIG_SCHEMA_VERSION_MISMATCH");
  }
}

function assertNodeObservation(
  contract: ReleaseConfigurationContract,
  observation: ReleaseNodeConfigurationObservation | undefined,
): void {
  if (!observation) return fail("RELEASE_CONFIG_NODE_OBSERVATION_MISSING");
  if (observation.artifactSha256 !== contract.artifactSha256) {
    return fail("RELEASE_CONFIG_NODE_ARTIFACT_DRIFT");
  }
  if (observation.sourceCommit !== contract.sourceCommit) {
    return fail("RELEASE_CONFIG_NODE_SOURCE_DRIFT");
  }
  if (observation.schemaVersion !== contract.schemaVersion) {
    return fail("RELEASE_CONFIG_NODE_SCHEMA_DRIFT");
  }
  if (observation.agentSurfaceFingerprint !== contract.agentSurfaceFingerprint) {
    return fail("RELEASE_CONFIG_NODE_AGENT_DRIFT");
  }
}

export class KnexReleaseConfigurationVerifier implements ReleaseConfigurationVerifier {
  private readonly database: Knex | Knex.Transaction;
  private readonly expectationDependencies: ReleaseConfigExpectationCaptureDependencies;
  private readonly certificationInspector: ReleaseRouteCertificationInspector;
  private readonly certificationBatchInspector: ReleaseRouteCertificationBatchInspector;
  readonly contract: ReleaseConfigurationContract;

  constructor(options: Readonly<{
    database: Knex | Knex.Transaction;
    contract: ReleaseConfigurationContract;
    /** Test/inspection seam; production deliberately uses the real ledger. */
    expectationDependencies?: ReleaseConfigExpectationCaptureDependencies;
    /** Test seam; production deliberately evaluates persisted task/usage evidence. */
    certificationInspector?: ReleaseRouteCertificationInspector;
    /** Test seam; production requires immutable registry + required audit proof. */
    certificationBatchInspector?: ReleaseRouteCertificationBatchInspector;
  }>) {
    this.database = options.database;
    this.contract = options.contract;
    this.expectationDependencies = options.expectationDependencies ?? {};
    this.certificationInspector = options.certificationInspector
      ?? evaluateModelRouteCertification;
    this.certificationBatchInspector = options.certificationBatchInspector
      ?? evaluateModelRouteCertificationReleaseBatchProof;
  }

  private async routeCertificationsFingerprint(artifact: ReleaseArtifact): Promise<string> {
    const expectedReleaseId = text(artifact.releaseId);
    if (!expectedReleaseId) return fail("RELEASE_CONFIG_RELEASE_ID_MISSING");
    const semantics = inspectProductionReleaseConfigSemantics(this.contract.expectation);
    const routeById = new Map(
      this.contract.expectation.expectedReadback.modelRoutes
        .map((route) => [text(route.id), route]),
    );
    const pricingById = new Map(
      this.contract.expectation.expectedReadback.pricing
        .map((pricingRule) => [text(pricingRule.id), pricingRule]),
    );
    const routes: ReleaseRouteCertificationsProjection["routes"] = [];
    for (const target of semantics.certificationTargets) {
      const route = routeById.get(target.routeId);
      const pricingRule = pricingById.get(target.pricingRuleId);
      if (!route || !pricingRule) {
        return fail("RELEASE_CONFIG_ROUTE_CERTIFICATION_TARGET_MISSING");
      }
      let readiness: ModelRouteCertificationReadiness;
      try {
        readiness = await this.certificationInspector({
          database: this.database,
          pricingRule,
          route,
        });
      } catch (error) {
        if (error instanceof ReleaseConfigurationContractError) throw error;
        return fail("RELEASE_CONFIG_ROUTE_CERTIFICATION_UNAVAILABLE");
      }
      assertCompleteRouteCertification(target, readiness);
      let releaseBatch: ModelRouteCertificationReleaseBatchProof;
      try {
        releaseBatch = await this.certificationBatchInspector({
          database: this.database,
          expectedReleaseId,
          expectedSourceCommit: this.contract.sourceCommit,
          readiness,
        });
      } catch (error) {
        if (error instanceof ReleaseConfigurationContractError) throw error;
        return fail("RELEASE_CONFIG_ROUTE_CERTIFICATION_BATCH_UNAVAILABLE");
      }
      assertReleaseBatchProof(
        readiness,
        releaseBatch,
        expectedReleaseId,
        this.contract.sourceCommit,
      );
      const readinessProjection = modelRouteCertificationStableProjection(readiness);
      readinessProjection.operations.sort((left, right) => (
        compareCodeUnits(left.operationKey, right.operationKey)
      ));
      const releaseBatchProjection: ModelRouteCertificationReleaseBatchProof = {
        ...releaseBatch,
        requiredCertifications: [...releaseBatch.requiredCertifications].sort((left, right) => (
          compareCodeUnits(left.operationKey, right.operationKey)
            || compareCodeUnits(left.certificationId, right.certificationId)
        )),
      };
      routes.push({
        endpointType: target.endpointType,
        readiness: readinessProjection,
        releaseBatch: releaseBatchProjection,
      });
    }
    const projection: ReleaseRouteCertificationsProjection = {
      format: RELEASE_ROUTE_CERTIFICATIONS_FORMAT,
      routes,
    };
    return sha256Canonical(projection);
  }

  async verify(
    artifact: Parameters<ReleaseConfigurationVerifier["verify"]>[0],
    input: Parameters<ReleaseConfigurationVerifier["verify"]>[1],
    _context: Parameters<ReleaseConfigurationVerifier["verify"]>[2],
  ): ReturnType<ReleaseConfigurationVerifier["verify"]> {
    assertArtifactBinding(this.contract, artifact);
    if (input.stage !== "preflight") assertNodeObservation(this.contract, input.observation);
    try {
      await assertReleaseConfigExpectationMatchesSnapshot(
        this.database,
        this.contract.expectation,
        {
          ...this.expectationDependencies,
          databaseIdentitySha256:
            this.contract.expectation.expectedReadback.databaseIdentitySha256,
        },
      );
    } catch (error) {
      const sourceCode = text((error as { code?: unknown } | null)?.code);
      const code = sourceCode && /^[A-Z0-9_]{1,64}$/u.test(sourceCode)
        ? `RELEASE_${sourceCode}`.slice(0, 64)
        : "RELEASE_CONFIG_SNAPSHOT_DRIFT";
      return fail(code);
    }
    const certificationFingerprint = await this.routeCertificationsFingerprint(artifact);
    return {
      fingerprint: sha256Canonical({
        certificationFingerprint,
        contractFingerprint: this.contract.fingerprint,
      }),
    };
  }
}
