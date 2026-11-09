import { z } from "zod";
import {
  type ToolManifest,
} from "@/agent-runtime/contracts";
import {
  AGENT_CAPABILITY_TOOL_IDS,
  isR4ToolId,
  isToolId,
  type ToolId,
} from "@/agent-runtime/toolIds";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  defineAgentTool,
  type AgentToolCatalogDefinition,
} from "@/agent-runtime/tools/registry";

const AGENT_RUNTIME_PHASES = ["A0", "A1", "A2", "A3", "A4", "A5", "A6"] as const;
const FUTURE_AGENT_RUNTIME_PHASES = ["A1", "A2", "A3", "A4", "A5", "A6", "never"] as const;
const AGENT_CAPABILITY_RISK_CLASSES = ["R0", "R1", "R2", "R3"] as const;

const toolAvailabilitySchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    sincePhase: z.enum(AGENT_RUNTIME_PHASES),
  }).strict(),
  z.object({
    state: z.literal("preview"),
    reason: z.string(),
    targetPhase: z.enum(["A1", "A2", "A3", "A4", "A5", "A6"]),
  }).strict(),
  z.object({
    state: z.literal("disabled"),
    reason: z.string(),
    targetPhase: z.enum(FUTURE_AGENT_RUNTIME_PHASES),
  }).strict(),
]);

export const agentToolManifestSchema = z.object({
  name: z.enum(AGENT_CAPABILITY_TOOL_IDS),
  version: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  riskClass: z.enum(AGENT_CAPABILITY_RISK_CLASSES),
  availability: toolAvailabilitySchema,
  requiredPermissions: z.array(z.string()),
  resourceTypes: z.array(z.string()),
  mutatesState: z.boolean(),
  metered: z.boolean(),
}).strict();

export const agentToolCatalogDefinitionSchema = z.object({
  manifest: agentToolManifestSchema,
  inputSchema: z.record(z.string(), z.unknown()),
}).strict();

const boundedQuerySchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "query 不能包含控制字符");

export const capabilitySearchInputSchema = z.object({
  query: boundedQuerySchema.nullable().default(null),
  riskClass: z.enum(AGENT_CAPABILITY_RISK_CLASSES).nullable().default(null),
  mutatesState: z.boolean().nullable().default(null),
  // The portable model schema cannot expose numeric bounds. Accept any
  // positive integer here and clamp it before reading the catalog so a model
  // asking for a larger page cannot fail the entire conversation.
  limit: z.number().int().min(1).default(12),
}).strict();

export const capabilitySearchOutputSchema = z.object({
  matches: z.array(agentToolManifestSchema).max(20),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();

export const capabilityDescribeInputSchema = z.object({
  // Do not serialize the global canonical id registry into a model-visible
  // enum. The request-scoped server catalog remains the source of truth.
  toolName: z.string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/),
}).strict();

export const capabilityDescribeOutputSchema = z.object({
  tool: agentToolCatalogDefinitionSchema,
}).strict();

export const AGENT_TOOL_PACK_IDS = [
  "core",
  "project-context",
  "script",
  "asset",
  "storyboard-canvas",
  "generation",
  "delivery",
  "review",
] as const;

export type AgentToolPackId = (typeof AGENT_TOOL_PACK_IDS)[number];

export interface AgentToolPackDefinition {
  readonly id: AgentToolPackId;
  readonly version: string;
  readonly toolIds: readonly ToolId[];
}

function frozenPack(
  id: AgentToolPackId,
  toolIds: readonly ToolId[],
  version = "1.0.0",
): AgentToolPackDefinition {
  return Object.freeze({
    id,
    version,
    toolIds: Object.freeze([...toolIds]),
  });
}

/**
 * Packs are a frozen server-side grouping, not an availability declaration.
 * Loading always intersects these ids with the request-scoped catalog, so a
 * future, disabled or unregistered member is silently omitted.
 */
export const AGENT_TOOL_PACKS: Readonly<Record<AgentToolPackId, AgentToolPackDefinition>> = Object.freeze({
  core: frozenPack("core", [
    "capability.search",
    "capability.describe",
    "toolpack.load",
  ]),
  "project-context": frozenPack("project-context", [
    "context.snapshot.get",
    "project.get",
    "project.update",
    "project.archive",
    "session.get",
    "session.update",
  ], "1.2.0"),
  script: frozenPack("script", [
    "script.list",
    "script.get",
    "script.draft.create",
    "script.draft.update",
  ]),
  asset: frozenPack("asset", [
    "asset.search",
    "asset.get",
    "asset.version.list",
    "asset.spec.create",
    "asset.spec.update",
    "asset.archive",
    "asset.delete",
  ]),
  "storyboard-canvas": frozenPack("storyboard-canvas", [
    "storyboard.list",
    "storyboard.get",
    "storyboard.draft.upsert",
    "storyboard.draft.reorder",
    "canvas.get",
    "canvas.selection.get",
    "canvas.commands.apply",
    "canvas.asset.attach",
  ]),
  generation: frozenPack("generation", [
    "generation.quote",
    "generation.image.submit",
    "generation.video.submit",
    "generation.task.list",
    "generation.task.get",
    "generation.task.cancel",
    "generation.task.retry",
  ]),
  delivery: frozenPack("delivery", [
    "delivery.preview",
    "delivery.draft.create",
    "delivery.publish",
    "delivery.share",
  ]),
  review: frozenPack("review", [
    "review.report.get",
    "review.report.create",
  ]),
});

export const toolPackLoadInputSchema = z.object({
  packId: z.enum(AGENT_TOOL_PACK_IDS),
}).strict();

export const toolPackLoadOutputSchema = z.object({
  packId: z.enum(AGENT_TOOL_PACK_IDS),
  version: z.string().min(1),
  tools: z.array(agentToolCatalogDefinitionSchema),
}).strict();

function matchesQuery(manifest: ToolManifest, query: string): boolean {
  const normalized = query.toLocaleLowerCase("en-US");
  const haystack = [
    manifest.name,
    manifest.displayName,
    manifest.description,
    ...manifest.resourceTypes,
  ].join("\n").toLocaleLowerCase("en-US");
  return haystack.includes(normalized);
}

function searchCatalog(
  definitions: readonly AgentToolCatalogDefinition[],
  input: z.infer<typeof capabilitySearchInputSchema>,
): readonly AgentToolCatalogDefinition[] {
  // Some OpenAI-compatible models serialize an absent nullable string as the
  // literal text "null". For this read-only discovery filter it is safe and
  // more useful to treat that spelling as no filter.
  const query = input.query?.toLocaleLowerCase("en-US") === "null" ? null : input.query;
  return definitions.filter(({ manifest }) => {
    if (query && !matchesQuery(manifest, query)) return false;
    if (input.riskClass && manifest.riskClass !== input.riskClass) return false;
    if (input.mutatesState !== null && manifest.mutatesState !== input.mutatesState) return false;
    return true;
  });
}

function capabilityNotFound(): AgentToolGatewayError {
  // The same response covers unregistered, disabled, R4 and role-hidden tools
  // to avoid turning discovery into an availability oracle.
  return new AgentToolGatewayError(
    "capability_not_found",
    "该能力未注册或对当前 Agent Run 不可见",
    { status: 404 },
  );
}

export const CAPABILITY_SEARCH_TOOL = defineAgentTool({
  manifest: {
    name: "capability.search",
    version: "1.0.0",
    displayName: "搜索可用能力",
    description: "按关键词、风险等级和是否写入筛选当前 Agent Run 可见的已注册能力。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["tool_catalog"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: capabilitySearchInputSchema,
  outputSchema: capabilitySearchOutputSchema,
  async execute(input, context) {
    const filtered = searchCatalog(context.catalog.list(), input);
    const matches = filtered.slice(0, Math.min(input.limit, 20)).map(({ manifest }) => manifest);
    return {
      matches,
      total: filtered.length,
      truncated: filtered.length > matches.length,
    };
  },
});

export const CAPABILITY_DESCRIBE_TOOL = defineAgentTool({
  manifest: {
    name: "capability.describe",
    version: "1.0.0",
    displayName: "描述可用能力",
    description: "返回一个 canonical、已注册且当前 Run 可见能力的安全 manifest 与输入 JSON Schema。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["tool_catalog"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: capabilityDescribeInputSchema,
  outputSchema: capabilityDescribeOutputSchema,
  async execute(input, context) {
    if (!isToolId(input.toolName) || isR4ToolId(input.toolName)) throw capabilityNotFound();
    const tool = context.catalog.describe(input.toolName);
    if (!tool) throw capabilityNotFound();
    return { tool };
  },
});

export const TOOL_PACK_LOAD_TOOL = defineAgentTool({
  manifest: {
    name: "toolpack.load",
    version: "1.0.0",
    displayName: "加载能力包",
    description: "加载冻结能力包中当前 Agent Run 可见且服务端已注册的安全工具定义。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["tool_catalog"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: toolPackLoadInputSchema,
  outputSchema: toolPackLoadOutputSchema,
  async execute(input, context) {
    const pack = AGENT_TOOL_PACKS[input.packId];
    const tools = pack.toolIds.flatMap((toolId) => {
      const definition = context.catalog.describe(toolId);
      return definition ? [definition] : [];
    });
    return { packId: pack.id, version: pack.version, tools };
  },
});

export const CAPABILITY_CATALOG_TOOLS = Object.freeze([
  CAPABILITY_SEARCH_TOOL,
  CAPABILITY_DESCRIBE_TOOL,
  TOOL_PACK_LOAD_TOOL,
]);
