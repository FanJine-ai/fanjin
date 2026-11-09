import type { Knex } from "knex";
import { z } from "zod";
import type {
  AgentApprovalImpactSummary,
  AgentApprovalQuote,
} from "@/agent-runtime/approvalService";
import type {
  AgentRole,
  DelegationGrant,
  RiskClass,
  ToolAvailability,
  ToolManifest,
} from "@/agent-runtime/contracts";
import type { AgentMessageGenerationPreferences } from "@/agent-runtime/messageContextSnapshot";
import type { DelegationResourceRef } from "@/agent-runtime/delegationGrantService";
import { DEFAULT_ROLE_POLICIES } from "@/agent-runtime/defaultRolePolicies";
import {
  assertToolId,
  isModelHiddenToolId,
  isR4ToolId,
  matchesToolSelector,
  type ToolId,
} from "@/agent-runtime/toolIds";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  hasExactAgentRuntimePermission,
  isKnownAgentRuntimePermissionLeaf,
} from "@/middleware/permissions";

export interface AgentToolAuthorizationContext {
  database: Knex.Transaction;
  actorUserId: number;
  workspaceId: string;
  projectId: number;
  threadId: string;
  runId: string;
  stepId: string;
  agentRole: AgentRole;
  now: number;
  /**
   * Confirmed creation preference projected from the immutable Run policy.
   * It is never accepted from model arguments. Metered generation tools use
   * this fact to reject a proposal that drifts before a quote is minted.
   */
  generationPreferences?: AgentMessageGenerationPreferences;
  /**
   * REVAMP-PLAN 1.2: present only when authorization evidence is re-resolved
   * inside a decide-with-revision transaction. Quote-minting tools must then
   * strictly REPLACE their approval-anchored quote
   * (resendAgentGenerationQuoteForApproval) instead of upserting it, so a
   * vanished pause-time quote fails closed instead of being recreated.
   */
  approvalDecisionRevision?: { approvalId: string };
}

export interface AgentToolCatalogDefinition {
  readonly manifest: ToolManifest;
  /** JSON Schema is the only executable-call contract exposed by discovery. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * A request-scoped, read-only view over the registry. It contains only tools
 * that the persisted Run's role, current permissions and verified Grant may
 * discover. It intentionally has no access to handlers, output schemas or DB.
 */
export interface AgentToolCatalogContext {
  list(): readonly AgentToolCatalogDefinition[];
  describe(toolName: ToolId): AgentToolCatalogDefinition | null;
}

export interface AgentToolHandlerContext extends AgentToolAuthorizationContext {
  readonly catalog: AgentToolCatalogContext;
  /**
   * Root pool used only for durable side-effect intents that must survive a
   * rollback of the Gateway transaction in `database`.
   */
  readonly durableDatabase?: Knex;
  /**
   * Detached handlers must call this as the first operation inside every short
   * domain-write transaction. The assertion locks the current Run claim,
   * verifies the exact detached execution owner, and rechecks live authority in
   * that same transaction so claim takeover or permission revocation cannot
   * race the following domain writes.
   */
  readonly assertDetachedExecutionFence?: (
    database: Knex.Transaction,
  ) => Promise<void>;
  /**
   * Persist the parsed tool output as a domain-commit receipt in the same
   * transaction as the detached handler's domain writes. A later attempt may
   * use it only to finish Gateway bookkeeping, never to authorize new work.
   */
  readonly recordDetachedDomainCommit?: (
    database: Knex.Transaction,
    output: unknown,
  ) => Promise<void>;
}

/**
 * Server-derived facts used for Grant and Approval checks.  This object is
 * produced by the registered Tool package, never accepted from a model call.
 */
export interface AgentToolAuthorizationEvidence {
  resourceRefs?: readonly DelegationResourceRef[];
  estimatedMicros?: number;
  actualMicros?: number;
  resourceVersions?: Readonly<Record<string, string>>;
  policyVersion?: string;
  quote?: AgentApprovalQuote | null;
  impactSummary?: AgentApprovalImpactSummary | null;
}

export interface AgentToolDefinitionInput<TName extends ToolId, TInput, TOutput> {
  manifest: ToolManifest<TName>;
  /** Run the handler after a short authorization/checkpoint transaction. */
  executionMode?: "transactional" | "detached";
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  resolveAuthorizationEvidence?(
    input: TInput,
    context: AgentToolAuthorizationContext,
  ): Promise<AgentToolAuthorizationEvidence>;
  execute(input: TInput, context: AgentToolHandlerContext): Promise<TOutput>;
}

export interface RegisteredAgentTool {
  readonly manifest: ToolManifest;
  readonly executionMode: "transactional" | "detached";
  parseInput(value: unknown): unknown;
  parseOutput(value: unknown): unknown;
  resolveAuthorizationEvidence(
    input: unknown,
    context: AgentToolAuthorizationContext,
  ): Promise<AgentToolAuthorizationEvidence>;
  execute(input: unknown, context: AgentToolHandlerContext): Promise<unknown>;
  readonly catalogDefinition: AgentToolCatalogDefinition;
}

const riskRank: Readonly<Record<RiskClass, number>> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

function cloneAvailability(availability: ToolAvailability): ToolAvailability {
  if (availability.state === "available") {
    return Object.freeze({ state: "available", sincePhase: availability.sincePhase });
  }
  if (availability.state === "preview") {
    return Object.freeze({
      state: "preview",
      reason: availability.reason,
      targetPhase: availability.targetPhase,
    });
  }
  return Object.freeze({
    state: "disabled",
    reason: availability.reason,
    targetPhase: availability.targetPhase,
  });
}

function safeManifest(manifest: ToolManifest): ToolManifest {
  if (
    !manifest.requiredPermissions.every(isKnownAgentRuntimePermissionLeaf)
    || new Set(manifest.requiredPermissions).size !== manifest.requiredPermissions.length
  ) {
    throw new TypeError("工具 requiredPermissions 必须是去重后的已冻结精确权限叶");
  }
  // Pick fields explicitly. A definition supplied by JavaScript can contain
  // extra properties despite the TypeScript contract; discovery must never
  // serialize those properties.
  return Object.freeze({
    name: manifest.name,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    riskClass: manifest.riskClass,
    availability: cloneAvailability(manifest.availability),
    requiredPermissions: Object.freeze([...manifest.requiredPermissions]),
    resourceTypes: Object.freeze([...manifest.resourceTypes]),
    mutatesState: manifest.mutatesState,
    metered: manifest.metered,
  });
}

function deepFreezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreezeJson(item);
    return Object.freeze(value);
  }
  return value;
}

function safeInputJsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  const generated = schema.toJSONSchema();
  // JSON round-tripping removes prototypes, undefined values and any other
  // non-JSON implementation detail before the object is exposed to handlers.
  const cloned = JSON.parse(JSON.stringify(generated)) as unknown;
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new TypeError("工具输入 Schema 必须导出为 JSON Schema 对象");
  }
  return deepFreezeJson(cloned) as Readonly<Record<string, unknown>>;
}

function catalogVisible(input: {
  definition: AgentToolCatalogDefinition;
  agentRole: AgentRole;
  permissions: readonly string[];
  grant: DelegationGrant | null;
}): boolean {
  const manifest = input.definition.manifest;
  const rolePolicy = DEFAULT_ROLE_POLICIES[input.agentRole];

  // Preview, disabled, controller-only and R4 tools are indistinguishable from
  // absent tools in discovery. Registration alone never exposes them.
  if (manifest.availability.state !== "available"
    || manifest.riskClass === "R4"
    || isModelHiddenToolId(manifest.name)
    || isR4ToolId(manifest.name)) {
    return false;
  }
  if (rolePolicy.deniedTools.some((selector) => matchesToolSelector(manifest.name, selector))) return false;
  if (!rolePolicy.allowedTools.some((selector) => matchesToolSelector(manifest.name, selector))) return false;
  if (riskRank[manifest.riskClass] > riskRank[rolePolicy.maxRiskClass]) return false;
  if (
    manifest.requiredPermissions.some(
      (permission) => !hasExactAgentRuntimePermission(input.permissions, permission),
    )
  ) {
    return false;
  }

  if (!rolePolicy.requiresDelegationGrant) return input.grant === null;
  if (!input.grant || input.grant.granteeRole !== input.agentRole) return false;
  return input.grant.allowedTools.some((selector) => matchesToolSelector(manifest.name, selector));
}

export function defineAgentTool<TName extends ToolId, TInput, TOutput>(
  definition: AgentToolDefinitionInput<TName, TInput, TOutput>,
): RegisteredAgentTool {
  const manifest = safeManifest(definition.manifest);
  const catalogDefinition = Object.freeze({
    manifest,
    inputSchema: safeInputJsonSchema(definition.inputSchema),
  });
  return Object.freeze({
    manifest,
    executionMode: definition.executionMode ?? "transactional",
    catalogDefinition,
    parseInput(value: unknown) {
      return definition.inputSchema.parse(value);
    },
    parseOutput(value: unknown) {
      return definition.outputSchema.parse(value);
    },
    async resolveAuthorizationEvidence(input: unknown, context: AgentToolAuthorizationContext) {
      if (!definition.resolveAuthorizationEvidence) return {};
      return definition.resolveAuthorizationEvidence(input as TInput, context);
    },
    async execute(input: unknown, context: AgentToolHandlerContext) {
      return definition.execute(input as TInput, context);
    },
  });
}

export class AgentToolRegistry {
  private readonly tools = new Map<ToolId, RegisteredAgentTool>();

  constructor(definitions: readonly RegisteredAgentTool[]) {
    for (const definition of definitions) {
      assertToolId(definition.manifest.name);
      if (!definition.manifest.version.trim()) {
        throw new TypeError(`工具 ${definition.manifest.name} 缺少版本号`);
      }
      if (definition.manifest.riskClass === "R0" && definition.manifest.mutatesState) {
        throw new TypeError(`R0 工具 ${definition.manifest.name} 不能声明业务写入`);
      }
      if (this.tools.has(definition.manifest.name)) {
        throw new TypeError(`工具 ${definition.manifest.name} 重复注册`);
      }
      this.tools.set(definition.manifest.name, definition);
    }
  }

  get(toolName: unknown): RegisteredAgentTool {
    try {
      assertToolId(toolName);
    } catch {
      throw new AgentToolGatewayError("tool_id_invalid", "工具名不是 canonical ToolId", { status: 400 });
    }
    const definition = this.tools.get(toolName);
    if (!definition) {
      throw new AgentToolGatewayError("tool_unregistered", "工具尚未注册到服务端目录", { status: 404 });
    }
    return definition;
  }

  list(): readonly ToolManifest[] {
    return Object.freeze(Array.from(this.tools.values(), (definition) => definition.manifest));
  }

  /**
   * Builds a filtered catalog from server-derived authorization facts. The
   * returned facade cannot retrieve an unregistered or policy-hidden tool.
   */
  createCatalogContext(input: {
    agentRole: AgentRole;
    permissions: readonly string[];
    grant: DelegationGrant | null;
  }): AgentToolCatalogContext {
    const definitions = Object.freeze(
      Array.from(this.tools.values(), (definition) => definition.catalogDefinition)
        .filter((definition) => catalogVisible({ definition, ...input }))
        .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)),
    );
    const byName = new Map<ToolId, AgentToolCatalogDefinition>(
      definitions.map((definition) => [definition.manifest.name, definition]),
    );
    return Object.freeze({
      list: () => definitions,
      describe: (toolName: ToolId) => byName.get(toolName) ?? null,
    });
  }
}
