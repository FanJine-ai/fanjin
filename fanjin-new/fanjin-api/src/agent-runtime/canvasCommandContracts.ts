import { z } from "zod";
import {
  canonicalizeIdempotencyRequest,
  hashIdempotencyRequest,
} from "@/agent-runtime/idempotency";

export const CANVAS_COMMAND_SET_VERSION = 1 as const;
export const CANVAS_COMMAND_RISK_CLASS = "R1" as const;
export const CANVAS_COMMAND_MAX_COMMANDS = 50;
export const CANVAS_COMMAND_MAX_NODE_CREATES = 20;
export const CANVAS_COMMAND_MAX_TEXT_CHARACTERS = 64_000;
export const CANVAS_COMMAND_MAX_CURRENT_NODES = 5_000;
export const CANVAS_COMMAND_MAX_CURRENT_EDGES = 10_000;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANVAS_ID_PATTERN = /^[1-9]\d{0,14}$/;
const FORBIDDEN_TEXT_PATTERN = /(?:<\/?[A-Za-z][^>]*>|(?:https?|wss?|file|ftp):\/\/|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|credential)\s*[:=])/i;

const safeId = z.string().trim().regex(SAFE_ID_PATTERN);
const digest = z.string().regex(SHA256_PATTERN);
const projectId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canvasId = z.string().trim().regex(CANVAS_ID_PATTERN);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const safeText = (maxLength: number) => z.string()
  .trim()
  .min(1)
  .max(maxLength)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "文本不能包含控制字符")
  .refine((value) => !FORBIDDEN_TEXT_PATTERN.test(value), "文本不能包含 URL、XML、Socket 或凭据内容");

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const pointSchema = z.object({ x: coordinate, y: coordinate }).strict();

const commandBase = {
  commandId: safeId,
};

const nodeCreateCommandSchema = z.object({
  ...commandBase,
  op: z.literal("node.create"),
  node: z.object({
    id: safeId,
    nodeType: z.enum(["text", "note"]),
    title: safeText(200),
    subtitle: safeText(500).nullable(),
    body: safeText(4_000).nullable(),
    position: pointSchema,
  }).strict(),
}).strict();

const nodeUpdateChangesSchema = z.object({
  title: safeText(200).nullable().optional(),
  subtitle: safeText(500).nullable().optional(),
  body: safeText(4_000).nullable().optional(),
  position: pointSchema.optional(),
}).strict().superRefine((changes, context) => {
  if (Object.values(changes).every((value) => value === undefined)) {
    context.addIssue({ code: "custom", message: "node.update 至少需要一个固定字段" });
  }
});

const nodeUpdateCommandSchema = z.object({
  ...commandBase,
  op: z.literal("node.update"),
  nodeId: safeId,
  changes: nodeUpdateChangesSchema,
}).strict();

const edgeCreateCommandSchema = z.object({
  ...commandBase,
  op: z.literal("edge.create"),
  edge: z.object({
    id: safeId,
    sourceNodeId: safeId,
    targetNodeId: safeId,
    label: safeText(200).nullable(),
  }).strict(),
}).strict();

const edgeUpdateChangesSchema = z.object({
  sourceNodeId: safeId.optional(),
  targetNodeId: safeId.optional(),
  label: safeText(200).nullable().optional(),
}).strict().superRefine((changes, context) => {
  if (Object.values(changes).every((value) => value === undefined)) {
    context.addIssue({ code: "custom", message: "edge.update 至少需要一个固定字段" });
  }
});

const edgeUpdateCommandSchema = z.object({
  ...commandBase,
  op: z.literal("edge.update"),
  edgeId: safeId,
  changes: edgeUpdateChangesSchema,
}).strict();

const viewportValueSchema = z.object({
  x: coordinate,
  y: coordinate,
  zoom: z.number().finite().min(0.05).max(8),
}).strict();

const viewportUpdateCommandSchema = z.object({
  ...commandBase,
  op: z.literal("viewport.update"),
  viewport: viewportValueSchema,
}).strict();

export const canvasStructuredCommandSchema = z.discriminatedUnion("op", [
  nodeCreateCommandSchema,
  nodeUpdateCommandSchema,
  edgeCreateCommandSchema,
  edgeUpdateCommandSchema,
  viewportUpdateCommandSchema,
]);

const commandSetPayloadSchema = z.object({
  version: z.literal(CANVAS_COMMAND_SET_VERSION),
  riskClass: z.literal(CANVAS_COMMAND_RISK_CLASS),
  projectId,
  canvasId,
  expectedCanvasRevision: revision,
  expectedCanvasVersion: digest,
  commands: z.array(canvasStructuredCommandSchema).min(1).max(CANVAS_COMMAND_MAX_COMMANDS),
}).strict();

export const canvasCommandSetSchema = z.object({
  ...commandSetPayloadSchema.shape,
  idempotencyKey: z.string().trim().min(1).max(512),
}).strict();

const currentNodeSchema = z.object({ id: safeId }).strict();
const currentEdgeSchema = z.object({
  id: safeId,
  sourceNodeId: safeId,
  targetNodeId: safeId,
}).strict();

export const canvasCommandValidationEvidenceSchema = z.object({
  projectId,
  canvasId,
  canvasRevision: revision,
  canvasVersion: digest,
  nodes: z.array(currentNodeSchema).max(CANVAS_COMMAND_MAX_CURRENT_NODES),
  edges: z.array(currentEdgeSchema).max(CANVAS_COMMAND_MAX_CURRENT_EDGES),
}).strict();

export type CanvasStructuredCommand = z.infer<typeof canvasStructuredCommandSchema>;
export type CanvasCommandSetPayload = z.infer<typeof commandSetPayloadSchema>;
export type CanvasCommandSet = z.infer<typeof canvasCommandSetSchema>;
export type CanvasCommandValidationEvidence = z.infer<typeof canvasCommandValidationEvidenceSchema>;

export type CanvasCommandContractErrorCode =
  | "canvas_command_invalid"
  | "canvas_command_context_invalid"
  | "canvas_command_scope_mismatch"
  | "canvas_command_version_mismatch"
  | "canvas_command_batch_limit"
  | "canvas_command_duplicate_id"
  | "canvas_command_target_missing"
  | "canvas_command_dangling_edge"
  | "canvas_command_idempotency_mismatch";

const SAFE_MESSAGES: Readonly<Record<CanvasCommandContractErrorCode, string>> = Object.freeze({
  canvas_command_invalid: "Canvas structured command 格式无效",
  canvas_command_context_invalid: "Canvas 当前结构证据无效",
  canvas_command_scope_mismatch: "Canvas structured command 项目或画布绑定无效",
  canvas_command_version_mismatch: "Canvas structured command 版本绑定已过期",
  canvas_command_batch_limit: "Canvas structured command 批量超过安全上限",
  canvas_command_duplicate_id: "Canvas structured command 包含重复或冲突 ID",
  canvas_command_target_missing: "Canvas structured command 更新目标不存在",
  canvas_command_dangling_edge: "Canvas structured command 将产生悬空或自连接边",
  canvas_command_idempotency_mismatch: "Canvas structured command 幂等键无效",
});

export class CanvasCommandContractError extends Error {
  constructor(readonly code: CanvasCommandContractErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "CanvasCommandContractError";
  }
}

function fail(code: CanvasCommandContractErrorCode): never {
  throw new CanvasCommandContractError(code);
}

function canonicalClone<T>(value: T): T {
  try {
    return JSON.parse(canonicalizeIdempotencyRequest(value)) as T;
  } catch {
    fail("canvas_command_invalid");
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function commandTextCharacters(command: CanvasStructuredCommand): number {
  if (command.op === "node.create") {
    return command.node.title.length + (command.node.subtitle?.length ?? 0) + (command.node.body?.length ?? 0);
  }
  if (command.op === "node.update") {
    return (command.changes.title?.length ?? 0)
      + (command.changes.subtitle?.length ?? 0)
      + (command.changes.body?.length ?? 0);
  }
  if (command.op === "edge.create") return command.edge.label?.length ?? 0;
  if (command.op === "edge.update") return command.changes.label?.length ?? 0;
  return 0;
}

function assertBatchLimits(payload: CanvasCommandSetPayload): void {
  const nodeCreates = payload.commands.filter((command) => command.op === "node.create").length;
  const viewportUpdates = payload.commands.filter((command) => command.op === "viewport.update").length;
  const totalText = payload.commands.reduce((sum, command) => sum + commandTextCharacters(command), 0);
  if (nodeCreates > CANVAS_COMMAND_MAX_NODE_CREATES
    || viewportUpdates > 1
    || totalText > CANVAS_COMMAND_MAX_TEXT_CHARACTERS) {
    fail("canvas_command_batch_limit");
  }
}

function normalizePayload(input: unknown): CanvasCommandSetPayload {
  let candidate = input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const { idempotencyKey: _idempotencyKey, ...payload } = input as Record<string, unknown>;
    candidate = payload;
  }
  const parsed = commandSetPayloadSchema.safeParse(candidate);
  if (!parsed.success) fail("canvas_command_invalid");
  const payload = canonicalClone(parsed.data);
  assertBatchLimits(payload);
  return payload;
}

export function hashCanvasCommandSetPayload(input: unknown): string {
  return hashIdempotencyRequest(normalizePayload(input));
}

export function deriveCanvasCommandIdempotencyKey(input: unknown): string {
  const payload = normalizePayload(input);
  const payloadHash = hashIdempotencyRequest(payload);
  return `canvas-command:v1:${payload.projectId}:${payload.canvasId}:${payload.expectedCanvasRevision}:${payloadHash}`;
}

function parseEvidence(input: unknown): CanvasCommandValidationEvidence {
  const parsed = canvasCommandValidationEvidenceSchema.safeParse(input);
  if (!parsed.success) fail("canvas_command_context_invalid");
  return canonicalClone(parsed.data);
}

function assertUnique(values: readonly string[], code: CanvasCommandContractErrorCode): void {
  if (new Set(values).size !== values.length) fail(code);
}

function assertCurrentGraph(evidence: CanvasCommandValidationEvidence): void {
  const nodeIds = evidence.nodes.map(({ id }) => id);
  const edgeIds = evidence.edges.map(({ id }) => id);
  assertUnique(nodeIds, "canvas_command_context_invalid");
  assertUnique(edgeIds, "canvas_command_context_invalid");
  const nodes = new Set(nodeIds);
  if (evidence.edges.some((edge) => (
    edge.sourceNodeId === edge.targetNodeId
    || !nodes.has(edge.sourceNodeId)
    || !nodes.has(edge.targetNodeId)
  ))) {
    fail("canvas_command_context_invalid");
  }
}

function assertCommandGraph(
  payload: CanvasCommandSetPayload,
  evidence: CanvasCommandValidationEvidence,
): void {
  assertUnique(payload.commands.map(({ commandId }) => commandId), "canvas_command_duplicate_id");

  const currentNodeIds = new Set(evidence.nodes.map(({ id }) => id));
  const currentEdgeById = new Map(evidence.edges.map((edge) => [edge.id, edge]));
  const createdNodeIds = payload.commands
    .filter((command): command is Extract<CanvasStructuredCommand, { op: "node.create" }> => command.op === "node.create")
    .map((command) => command.node.id);
  const updatedNodeIds = payload.commands
    .filter((command): command is Extract<CanvasStructuredCommand, { op: "node.update" }> => command.op === "node.update")
    .map((command) => command.nodeId);
  const createdEdgeIds = payload.commands
    .filter((command): command is Extract<CanvasStructuredCommand, { op: "edge.create" }> => command.op === "edge.create")
    .map((command) => command.edge.id);
  const updatedEdgeIds = payload.commands
    .filter((command): command is Extract<CanvasStructuredCommand, { op: "edge.update" }> => command.op === "edge.update")
    .map((command) => command.edgeId);

  assertUnique(createdNodeIds, "canvas_command_duplicate_id");
  assertUnique(updatedNodeIds, "canvas_command_duplicate_id");
  assertUnique(createdEdgeIds, "canvas_command_duplicate_id");
  assertUnique(updatedEdgeIds, "canvas_command_duplicate_id");
  if (createdNodeIds.some((id) => currentNodeIds.has(id) || updatedNodeIds.includes(id))
    || createdEdgeIds.some((id) => currentEdgeById.has(id) || updatedEdgeIds.includes(id))) {
    fail("canvas_command_duplicate_id");
  }
  if (updatedNodeIds.some((id) => !currentNodeIds.has(id))
    || updatedEdgeIds.some((id) => !currentEdgeById.has(id))) {
    fail("canvas_command_target_missing");
  }

  const finalNodeIds = new Set([...currentNodeIds, ...createdNodeIds]);
  const finalEdges = new Map(currentEdgeById);
  for (const command of payload.commands) {
    if (command.op === "edge.create") {
      finalEdges.set(command.edge.id, command.edge);
    } else if (command.op === "edge.update") {
      const current = finalEdges.get(command.edgeId);
      if (!current) fail("canvas_command_target_missing");
      finalEdges.set(command.edgeId, {
        id: command.edgeId,
        sourceNodeId: command.changes.sourceNodeId ?? current.sourceNodeId,
        targetNodeId: command.changes.targetNodeId ?? current.targetNodeId,
      });
    }
  }
  if ([...finalEdges.values()].some((edge) => (
    edge.sourceNodeId === edge.targetNodeId
    || !finalNodeIds.has(edge.sourceNodeId)
    || !finalNodeIds.has(edge.targetNodeId)
  ))) {
    fail("canvas_command_dangling_edge");
  }
}

/**
 * Pure V1 contract validation only. Evidence must be built from the current,
 * server-owned canvas snapshot. This function performs no DB write, Tool
 * registration, provider call, generation, publish/share or file/URL access.
 */
export function validateCanvasCommandSet(
  input: unknown,
  evidenceInput: unknown,
): CanvasCommandSet {
  const parsed = canvasCommandSetSchema.safeParse(input);
  if (!parsed.success) fail("canvas_command_invalid");
  const set = canonicalClone(parsed.data);
  const { idempotencyKey: _idempotencyKey, ...payloadInput } = set;
  const payload = normalizePayload(payloadInput);
  const evidence = parseEvidence(evidenceInput);
  assertCurrentGraph(evidence);
  if (payload.projectId !== evidence.projectId || payload.canvasId !== evidence.canvasId) {
    fail("canvas_command_scope_mismatch");
  }
  if (payload.expectedCanvasRevision !== evidence.canvasRevision
    || payload.expectedCanvasVersion !== evidence.canvasVersion) {
    fail("canvas_command_version_mismatch");
  }
  if (set.idempotencyKey !== deriveCanvasCommandIdempotencyKey(payload)) {
    fail("canvas_command_idempotency_mismatch");
  }
  assertCommandGraph(payload, evidence);
  return deepFreeze(set);
}

/*
 * Model-facing input contract for canvas.commands.apply. The V1 contract
 * above stays the only executable shape; this flat shape exists solely so the
 * tool catalog schema can project into the OpenAI strict function-tool
 * subset:
 * - projectId/idempotencyKey are server-derived and intentionally absent
 *   (HIDDEN_TOOL_ARGUMENT_KEYS); version/riskClass are server-pinned
 *   constants, never model input;
 * - every command field is required + nullable (no optional property, no
 *   discriminated union), in the same style as packages/plan.ts;
 * - `null` means "not supplied for this op". The model face therefore cannot
 *   express "clear this field"; the V1 contract keeps that capability for
 *   direct server-side callers.
 * Assembly back into the V1 shape, with the full canvasCommandSetSchema as
 * the unchanged validation boundary, happens in
 * assembleCanvasCommandSetFromModelInput below.
 */
const CANVAS_COMMAND_MODEL_OPS = [
  "node.create",
  "node.update",
  "edge.create",
  "edge.update",
  "viewport.update",
] as const;

const canvasCommandModelCommandSchema = z.object({
  op: z.enum(CANVAS_COMMAND_MODEL_OPS),
  commandId: safeId,
  nodeId: safeId.nullable().default(null),
  nodeType: z.enum(["text", "note"]).nullable().default(null),
  edgeId: safeId.nullable().default(null),
  sourceNodeId: safeId.nullable().default(null),
  targetNodeId: safeId.nullable().default(null),
  title: safeText(200).nullable().default(null),
  subtitle: safeText(500).nullable().default(null),
  body: safeText(4_000).nullable().default(null),
  label: safeText(200).nullable().default(null),
  position: pointSchema.nullable().default(null),
  viewport: viewportValueSchema.nullable().default(null),
}).strict();

export const canvasCommandsApplyModelInputSchema = z.object({
  canvasId,
  expectedCanvasRevision: revision,
  expectedCanvasVersion: digest,
  commands: z.array(canvasCommandModelCommandSchema).min(1).max(CANVAS_COMMAND_MAX_COMMANDS),
}).strict();

export type CanvasCommandsApplyModelCommand = z.infer<typeof canvasCommandModelCommandSchema>;
export type CanvasCommandsApplyModelInput = z.infer<typeof canvasCommandsApplyModelInputSchema>;

/** Fields each op may populate; every other flat field must stay null. */
const MODEL_COMMAND_ALLOWED_FIELDS: Readonly<Record<CanvasCommandsApplyModelCommand["op"], readonly string[]>> = Object.freeze({
  "node.create": ["commandId", "nodeId", "nodeType", "title", "subtitle", "body", "position"],
  "node.update": ["commandId", "nodeId", "title", "subtitle", "body", "position"],
  "edge.create": ["commandId", "edgeId", "sourceNodeId", "targetNodeId", "label"],
  "edge.update": ["commandId", "edgeId", "sourceNodeId", "targetNodeId", "label"],
  "viewport.update": ["commandId", "viewport"],
});

function assertModelCommandFieldDiscipline(command: CanvasCommandsApplyModelCommand): void {
  const allowed = new Set(["op", ...MODEL_COMMAND_ALLOWED_FIELDS[command.op]]);
  for (const [key, value] of Object.entries(command)) {
    if (!allowed.has(key) && value !== null) fail("canvas_command_invalid");
  }
}

function assembleModelCommand(command: CanvasCommandsApplyModelCommand): unknown {
  assertModelCommandFieldDiscipline(command);
  switch (command.op) {
    case "node.create":
      return {
        commandId: command.commandId,
        op: "node.create",
        node: {
          id: command.nodeId,
          nodeType: command.nodeType,
          title: command.title,
          subtitle: command.subtitle,
          body: command.body,
          position: command.position,
        },
      };
    case "node.update": {
      const changes: Record<string, unknown> = {};
      if (command.title !== null) changes.title = command.title;
      if (command.subtitle !== null) changes.subtitle = command.subtitle;
      if (command.body !== null) changes.body = command.body;
      if (command.position !== null) changes.position = command.position;
      return { commandId: command.commandId, op: "node.update", nodeId: command.nodeId, changes };
    }
    case "edge.create":
      return {
        commandId: command.commandId,
        op: "edge.create",
        edge: {
          id: command.edgeId,
          sourceNodeId: command.sourceNodeId,
          targetNodeId: command.targetNodeId,
          label: command.label,
        },
      };
    case "edge.update": {
      const changes: Record<string, unknown> = {};
      if (command.sourceNodeId !== null) changes.sourceNodeId = command.sourceNodeId;
      if (command.targetNodeId !== null) changes.targetNodeId = command.targetNodeId;
      if (command.label !== null) changes.label = command.label;
      return { commandId: command.commandId, op: "edge.update", edgeId: command.edgeId, changes };
    }
    case "viewport.update":
      return { commandId: command.commandId, op: "viewport.update", viewport: command.viewport };
  }
}

/**
 * Assembles the flat model-facing input back into the untrusted V1 command
 * set: projectId comes from the server-owned scope and the idempotency key is
 * generated server-side as exactly the value the V1 contract pins. The
 * derivation re-runs the payload schema and the V1 batch limits, and the
 * final safeParse re-checks the complete canvasCommandSetSchema, so the
 * contract boundary and its defenses are unchanged.
 */
export function assembleCanvasCommandSetFromModelInput(
  input: CanvasCommandsApplyModelInput,
  scope: { projectId: number },
): CanvasCommandSet {
  const payload = {
    version: CANVAS_COMMAND_SET_VERSION,
    riskClass: CANVAS_COMMAND_RISK_CLASS,
    projectId: scope.projectId,
    canvasId: input.canvasId,
    expectedCanvasRevision: input.expectedCanvasRevision,
    expectedCanvasVersion: input.expectedCanvasVersion,
    commands: input.commands.map(assembleModelCommand),
  };
  const idempotencyKey = deriveCanvasCommandIdempotencyKey(payload);
  const parsed = canvasCommandSetSchema.safeParse({ ...payload, idempotencyKey });
  if (!parsed.success) fail("canvas_command_invalid");
  return parsed.data;
}
