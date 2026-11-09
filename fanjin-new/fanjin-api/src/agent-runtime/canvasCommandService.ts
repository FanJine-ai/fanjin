import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import {
  CANVAS_COMMAND_MAX_COMMANDS,
  CANVAS_COMMAND_MAX_CURRENT_EDGES,
  CANVAS_COMMAND_MAX_CURRENT_NODES,
  CanvasCommandContractError,
  canvasCommandSetSchema,
  deriveCanvasCommandIdempotencyKey,
  validateCanvasCommandSet,
  type CanvasCommandSet,
  type CanvasCommandValidationEvidence,
  type CanvasStructuredCommand,
} from "@/agent-runtime/canvasCommandContracts";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import {
  canonicalizeIdempotencyRequest,
  hashIdempotencyRequest,
} from "@/agent-runtime/idempotency";
import {
  hasExactAgentRuntimePermission,
  resolveLiveWorkspacePermissions,
} from "@/middleware/permissions";
import {
  CANVAS_COMMAND_CANVAS_TABLE,
  CANVAS_COMMAND_MUTATION_TABLE,
} from "@/lib/migrations/canvasCommandMutation";

export const CANVAS_COMMAND_VERSION_ALGORITHM = "execution-resource-sha256-v1" as const;
export const CANVAS_COMMAND_MAX_GRAPH_JSON_BYTES = 512 * 1_024;
export const CANVAS_COMMAND_MAX_VIEWPORT_JSON_BYTES = 16 * 1_024;
export const CANVAS_COMMAND_MAX_COMMAND_SET_BYTES = 256 * 1_024;
export const CANVAS_COMMAND_MAX_SNAPSHOT_BYTES = 1_200_000;
export const CANVAS_COMMAND_MAX_RESULT_BYTES = 16 * 1_024;

const SAFE_GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_JOURNAL_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANVAS_ID_PATTERN = /^[1-9]\d{0,14}$/;

export const canvasCommandApplyResultSchema = z.object({
  version: z.literal(1),
  mutationId: z.string().min(1).max(200).regex(SAFE_JOURNAL_ID_PATTERN),
  projectId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  canvasId: z.string().regex(CANVAS_ID_PATTERN),
  idempotencyKey: z.string().min(1).max(512),
  canvasRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  canvasVersion: z.string().regex(SHA256_PATTERN),
  commandCount: z.number().int().min(1).max(CANVAS_COMMAND_MAX_COMMANDS),
  nodeCreateCount: z.number().int().nonnegative().max(CANVAS_COMMAND_MAX_COMMANDS),
  nodeUpdateCount: z.number().int().nonnegative().max(CANVAS_COMMAND_MAX_COMMANDS),
  edgeCreateCount: z.number().int().nonnegative().max(CANVAS_COMMAND_MAX_COMMANDS),
  edgeUpdateCount: z.number().int().nonnegative().max(CANVAS_COMMAND_MAX_COMMANDS),
  viewportUpdated: z.boolean(),
  appliedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type CanvasCommandApplyResult = z.infer<typeof canvasCommandApplyResultSchema>;

export interface ApplyCanvasCommandInput {
  /** Server-owned workspace scope; never source this value from model output. */
  workspaceId: string;
  /** Server-owned active user identity. */
  actorUserId: number;
  /** Untrusted V1 structured command contract. */
  commandSet: unknown;
}

export interface CanvasCommandServiceOptions {
  clock?: () => number;
  idFactory?: () => string;
}

export interface CanvasCommandVersionRecord {
  id: unknown;
  projectId: unknown;
  episodesId?: unknown;
  name?: unknown;
  nodes: unknown;
  edges: unknown;
  viewport: unknown;
  createTime?: unknown;
  updateTime?: unknown;
}

interface RawCanvasRow extends CanvasCommandVersionRecord {
  revision: unknown;
}

interface RawCanvasMutationRow {
  id: unknown;
  workspaceId: unknown;
  projectId: unknown;
  canvasId: unknown;
  actorUserId: unknown;
  idempotencyKey: unknown;
  requestHash: unknown;
  baseRevision: unknown;
  newRevision: unknown;
  baseVersion: unknown;
  newVersion: unknown;
  commandSetJson: unknown;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  resultJson: unknown;
  createdAt: unknown;
}

interface CanvasMetadata {
  id: number;
  projectId: number;
  episodesId: number | null;
  name: string | null;
  createTime: number | null;
  updateTime: number | null;
}

interface CanvasGraph {
  nodes: unknown[];
  edges: unknown[];
  viewport: Record<string, unknown>;
}

interface InspectedNode {
  id: string;
  raw: Record<string, unknown>;
}

interface InspectedEdge {
  id: string;
  raw: Record<string, unknown>;
  sourceNodeId: string;
  targetNodeId: string;
  syntheticId: boolean;
}

interface InspectedGraph {
  nodeById: Map<string, InspectedNode>;
  edgeById: Map<string, InspectedEdge>;
  evidenceNodes: Array<{ id: string }>;
  evidenceEdges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
}

interface NormalizedCanvas {
  metadata: CanvasMetadata;
  revision: number;
  graph: CanvasGraph;
  inspected: InspectedGraph;
  version: string;
}

interface AppliedCommandCounts {
  commandCount: number;
  nodeCreateCount: number;
  nodeUpdateCount: number;
  edgeCreateCount: number;
  edgeUpdateCount: number;
  viewportUpdated: boolean;
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new AgentRuntimeError(status, code, message, details);
}

function cleanIdentifier(value: unknown, field: string, maxLength = 200): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength || !SAFE_JOURNAL_ID_PATTERN.test(text)) {
    fail(400, "canvas_command_input_invalid", `${field} 格式无效`);
  }
  return text;
}

function positiveInteger(value: unknown, field: string, status = 400): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    fail(status, status === 400 ? "canvas_command_input_invalid" : "canvas_command_snapshot_invalid", `${field} 无效`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, field: string, status = 409): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail(status, "canvas_command_snapshot_invalid", `${field} 无效`);
  }
  return number;
}

function nullableNonNegativeInteger(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  return nonNegativeInteger(value, field);
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  return Number(value || 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function graphIdentifier(value: unknown): string | null {
  if (value == null) return null;
  const id = String(value).trim();
  return SAFE_GRAPH_ID_PATTERN.test(id) ? id : null;
}

function encodeJsonValue(value: unknown, fallback: unknown, field: string, maxBytes: number): string {
  let text: string;
  try {
    const encoded = JSON.stringify(value == null ? fallback : value);
    if (encoded === undefined) throw new TypeError("undefined JSON");
    text = encoded;
  } catch {
    fail(409, "canvas_command_snapshot_invalid", `Canvas ${field} 无法序列化`);
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    fail(409, "canvas_command_snapshot_too_large", `Canvas ${field} 超出安全上限`);
  }
  return text;
}

function parseJsonValue(value: unknown, fallback: unknown, field: string, maxBytes: number): unknown {
  let text: string;
  if (typeof value === "string") {
    text = value;
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      fail(409, "canvas_command_snapshot_too_large", `Canvas ${field} 超出安全上限`);
    }
  } else {
    text = encodeJsonValue(value, fallback, field, maxBytes);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(409, "canvas_command_snapshot_invalid", `Canvas ${field} 不是有效 JSON`);
  }
}

function parseCanvasGraph(row: CanvasCommandVersionRecord): CanvasGraph {
  const nodes = parseJsonValue(row.nodes, [], "nodes", CANVAS_COMMAND_MAX_GRAPH_JSON_BYTES);
  const edges = parseJsonValue(row.edges, [], "edges", CANVAS_COMMAND_MAX_GRAPH_JSON_BYTES);
  const viewport = parseJsonValue(
    row.viewport,
    { x: 0, y: 0, zoom: 1 },
    "viewport",
    CANVAS_COMMAND_MAX_VIEWPORT_JSON_BYTES,
  );
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !isRecord(viewport)) {
    fail(409, "canvas_command_snapshot_invalid", "Canvas 图结构无效");
  }
  return { nodes, edges, viewport };
}

function normalizeCanvasMetadata(row: CanvasCommandVersionRecord): CanvasMetadata {
  const name = row.name == null ? null : String(row.name);
  if (name !== null && Buffer.byteLength(name, "utf8") > 64 * 1_024) {
    fail(409, "canvas_command_snapshot_too_large", "Canvas name 超出安全上限");
  }
  return {
    id: positiveInteger(row.id, "canvas.id", 409),
    projectId: positiveInteger(row.projectId, "canvas.projectId", 409),
    episodesId: nullableNonNegativeInteger(row.episodesId, "canvas.episodesId"),
    name,
    createTime: nullableNonNegativeInteger(row.createTime, "canvas.createTime"),
    updateTime: nullableNonNegativeInteger(row.updateTime, "canvas.updateTime"),
  };
}

function inspectGraph(graph: CanvasGraph): InspectedGraph {
  if (graph.nodes.length > CANVAS_COMMAND_MAX_CURRENT_NODES
    || graph.edges.length > CANVAS_COMMAND_MAX_CURRENT_EDGES) {
    fail(409, "canvas_command_snapshot_too_large", "Canvas 节点或连线数量超出安全上限");
  }

  const nodeById = new Map<string, InspectedNode>();
  const evidenceNodes: Array<{ id: string }> = [];
  for (const value of graph.nodes) {
    if (!isRecord(value)) fail(409, "canvas_command_snapshot_invalid", "Canvas 节点结构无效");
    const id = graphIdentifier(value.id);
    if (!id || nodeById.has(id)) {
      fail(409, "canvas_command_snapshot_invalid", "Canvas 节点 ID 无效或重复");
    }
    const node = { id, raw: value };
    nodeById.set(id, node);
    evidenceNodes.push({ id });
  }

  const edgeById = new Map<string, InspectedEdge>();
  const evidenceEdges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }> = [];
  for (const [index, value] of graph.edges.entries()) {
    if (!isRecord(value)) fail(409, "canvas_command_snapshot_invalid", "Canvas 连线结构无效");
    const explicitId = graphIdentifier(value.id);
    const syntheticId = explicitId === null;
    const id = explicitId ?? `edge-${index + 1}`;
    const sourceNodeId = graphIdentifier(value.source ?? value.fromNodeId);
    const targetNodeId = graphIdentifier(value.target ?? value.toNodeId);
    if (!SAFE_GRAPH_ID_PATTERN.test(id)
      || edgeById.has(id)
      || !sourceNodeId
      || !targetNodeId
      || sourceNodeId === targetNodeId
      || !nodeById.has(sourceNodeId)
      || !nodeById.has(targetNodeId)) {
      fail(409, "canvas_command_snapshot_invalid", "Canvas 连线 ID 或端点无效");
    }
    const edge = { id, raw: value, sourceNodeId, targetNodeId, syntheticId };
    edgeById.set(id, edge);
    evidenceEdges.push({ id, sourceNodeId, targetNodeId });
  }

  return { nodeById, edgeById, evidenceNodes, evidenceEdges };
}

function versionRecord(metadata: CanvasMetadata, graph: CanvasGraph): Record<string, unknown> {
  return {
    id: metadata.id,
    projectId: metadata.projectId,
    episodesId: metadata.episodesId,
    name: metadata.name,
    nodes: graph.nodes,
    edges: graph.edges,
    viewport: graph.viewport,
    createTime: metadata.createTime,
    updateTime: metadata.updateTime,
  };
}

function hashNormalizedCanvas(metadata: CanvasMetadata, graph: CanvasGraph): string {
  try {
    return hashIdempotencyRequest({
      algorithm: CANVAS_COMMAND_VERSION_ALGORITHM,
      type: "canvas",
      record: versionRecord(metadata, graph),
    });
  } catch {
    fail(409, "canvas_command_snapshot_invalid", "Canvas 无法形成稳定版本");
  }
}

/**
 * Computes the complete persisted Canvas version used by Execution preflight.
 * Unlike canvas.get, this hashes every node and edge, including preserved
 * legacy fields, and never hashes a truncated public summary.
 */
export function computeCanvasCommandVersion(row: CanvasCommandVersionRecord): string {
  const metadata = normalizeCanvasMetadata(row);
  const graph = parseCanvasGraph(row);
  inspectGraph(graph);
  return hashNormalizedCanvas(metadata, graph);
}

function normalizeCanvas(row: RawCanvasRow): NormalizedCanvas {
  const metadata = normalizeCanvasMetadata(row);
  const revision = positiveInteger(row.revision, "canvas.revision", 409);
  const graph = parseCanvasGraph(row);
  const inspected = inspectGraph(graph);
  return {
    metadata,
    revision,
    graph,
    inspected,
    version: hashNormalizedCanvas(metadata, graph),
  };
}

function runtimeContractError(error: CanvasCommandContractError): AgentRuntimeError {
  const status = error.code === "canvas_command_invalid"
    || error.code === "canvas_command_batch_limit"
    ? 400
    : 409;
  return new AgentRuntimeError(status, error.code, error.message);
}

function parseCommandSet(value: unknown): CanvasCommandSet {
  const parsed = canvasCommandSetSchema.safeParse(value);
  if (!parsed.success) {
    fail(400, "canvas_command_invalid", "Canvas structured command 格式无效");
  }
  return parsed.data;
}

function assertFreshCommandIdentity(commandSet: CanvasCommandSet): void {
  try {
    if (commandSet.idempotencyKey !== deriveCanvasCommandIdempotencyKey(commandSet)) {
      throw new CanvasCommandContractError("canvas_command_idempotency_mismatch");
    }
  } catch (error) {
    if (error instanceof CanvasCommandContractError) throw runtimeContractError(error);
    throw error;
  }
}

function validateAgainstCurrent(
  commandSet: CanvasCommandSet,
  evidence: CanvasCommandValidationEvidence,
): CanvasCommandSet {
  try {
    return validateCanvasCommandSet(commandSet, evidence);
  } catch (error) {
    if (error instanceof CanvasCommandContractError) throw runtimeContractError(error);
    throw error;
  }
}

async function assertCurrentProjectWriteAccess(
  trx: Knex.Transaction,
  workspaceId: string,
  projectId: number,
  actorUserId: number,
): Promise<void> {
  const project = await trx("o_project")
    .where({ id: projectId, workspaceId })
    .select("id")
    .forUpdate()
    .first();
  if (!project) {
    fail(404, "canvas_command_scope_not_found", "项目或 Canvas 不存在");
  }

  const authority = await resolveLiveWorkspacePermissions({
    database: trx,
    actorUserId,
    workspaceId,
  });
  if (!hasExactAgentRuntimePermission(authority.permissions, "project:write")) {
    fail(403, "canvas_command_actor_forbidden", "用户不再具有当前项目写权限");
  }
}

function setNodeTextField(
  node: Record<string, unknown>,
  field: "title" | "subtitle" | "body",
  value: string | null,
): void {
  const topLevelCandidates = field === "body" ? ["body", "content", "script"] : [field];
  const dataCandidates = field === "title"
    ? ["title", "label"]
    : field === "body"
      ? ["body", "content", "script"]
      : [field];
  for (const candidate of topLevelCandidates) {
    if (hasOwn(node, candidate)) {
      node[candidate] = value;
      return;
    }
  }
  const data = isRecord(node.data) ? node.data : null;
  if (data) {
    for (const candidate of dataCandidates) {
      if (hasOwn(data, candidate)) {
        data[candidate] = value;
        return;
      }
    }
  }
  node[field] = value;
}

function setNodePosition(node: Record<string, unknown>, position: { x: number; y: number }): void {
  if (isRecord(node.position)) {
    node.position.x = position.x;
    node.position.y = position.y;
    return;
  }
  if (hasOwn(node, "x") || hasOwn(node, "y")) {
    node.x = position.x;
    node.y = position.y;
    return;
  }
  node.position = { x: position.x, y: position.y };
}

function setEdgeEndpoint(
  edge: Record<string, unknown>,
  endpoint: "source" | "target",
  value: string,
): void {
  const legacy = endpoint === "source" ? "fromNodeId" : "toNodeId";
  if (hasOwn(edge, endpoint)) edge[endpoint] = value;
  else if (hasOwn(edge, legacy)) edge[legacy] = value;
  else edge[endpoint] = value;
}

function applyNodeUpdate(node: Record<string, unknown>, command: Extract<CanvasStructuredCommand, { op: "node.update" }>): void {
  if (hasOwn(command.changes, "title")) setNodeTextField(node, "title", command.changes.title ?? null);
  if (hasOwn(command.changes, "subtitle")) setNodeTextField(node, "subtitle", command.changes.subtitle ?? null);
  if (hasOwn(command.changes, "body")) setNodeTextField(node, "body", command.changes.body ?? null);
  if (command.changes.position) setNodePosition(node, command.changes.position);
}

function applyEdgeUpdate(edge: InspectedEdge, command: Extract<CanvasStructuredCommand, { op: "edge.update" }>): void {
  if (edge.syntheticId) edge.raw.id = edge.id;
  if (command.changes.sourceNodeId !== undefined) {
    setEdgeEndpoint(edge.raw, "source", command.changes.sourceNodeId);
  }
  if (command.changes.targetNodeId !== undefined) {
    setEdgeEndpoint(edge.raw, "target", command.changes.targetNodeId);
  }
  if (hasOwn(command.changes, "label")) edge.raw.label = command.changes.label ?? null;
}

function applyCommands(
  graph: CanvasGraph,
  inspected: InspectedGraph,
  commandSet: CanvasCommandSet,
): AppliedCommandCounts {
  const counts: AppliedCommandCounts = {
    commandCount: commandSet.commands.length,
    nodeCreateCount: 0,
    nodeUpdateCount: 0,
    edgeCreateCount: 0,
    edgeUpdateCount: 0,
    viewportUpdated: false,
  };

  for (const command of commandSet.commands) {
    if (command.op === "node.create") {
      graph.nodes.push({
        id: command.node.id,
        type: command.node.nodeType,
        position: { x: command.node.position.x, y: command.node.position.y },
        data: {
          kind: command.node.nodeType,
          title: command.node.title,
          subtitle: command.node.subtitle,
          body: command.node.body,
        },
      });
      counts.nodeCreateCount += 1;
      continue;
    }
    if (command.op === "node.update") {
      const node = inspected.nodeById.get(command.nodeId);
      if (!node) fail(409, "canvas_command_target_missing", "Canvas node.update 目标不存在");
      applyNodeUpdate(node.raw, command);
      counts.nodeUpdateCount += 1;
      continue;
    }
    if (command.op === "edge.create") {
      graph.edges.push({
        id: command.edge.id,
        source: command.edge.sourceNodeId,
        target: command.edge.targetNodeId,
        label: command.edge.label,
      });
      counts.edgeCreateCount += 1;
      continue;
    }
    if (command.op === "edge.update") {
      const edge = inspected.edgeById.get(command.edgeId);
      if (!edge) fail(409, "canvas_command_target_missing", "Canvas edge.update 目标不存在");
      applyEdgeUpdate(edge, command);
      counts.edgeUpdateCount += 1;
      continue;
    }
    graph.viewport.x = command.viewport.x;
    graph.viewport.y = command.viewport.y;
    graph.viewport.zoom = command.viewport.zoom;
    counts.viewportUpdated = true;
  }
  return counts;
}

function boundedCanonicalJson(
  value: unknown,
  maxBytes: number,
  code: "canvas_command_snapshot_too_large" | "canvas_command_invalid" | "canvas_command_result_invalid",
  message: string,
): string {
  let text: string;
  try {
    text = canonicalizeIdempotencyRequest(value);
  } catch {
    fail(code === "canvas_command_invalid" ? 400 : 500, code, message);
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    const status = code === "canvas_command_invalid" ? 400 : code === "canvas_command_snapshot_too_large" ? 409 : 500;
    fail(status, code, message);
  }
  return text;
}

function commandRequestHash(workspaceId: string, actorUserId: number, commandSet: CanvasCommandSet): string {
  return hashIdempotencyRequest({ workspaceId, actorUserId, commandSet });
}

function requestScope(commandSet: CanvasCommandSet): { projectId: number; canvasId: number; canvasIdText: string } {
  return {
    projectId: commandSet.projectId,
    canvasId: Number(commandSet.canvasId),
    canvasIdText: commandSet.canvasId,
  };
}

function idempotencyConflict(): never {
  fail(409, "canvas_command_idempotency_conflict", "Canvas 幂等键已绑定不同请求");
}

function corruptMutationRecord(): never {
  fail(500, "canvas_command_mutation_corrupt", "Canvas mutation 持久化记录无效");
}

function parsePersistedResult(value: unknown): CanvasCommandApplyResult {
  const text = typeof value === "string" ? value : encodeJsonValue(value, null, "result", CANVAS_COMMAND_MAX_RESULT_BYTES);
  if (Buffer.byteLength(text, "utf8") > CANVAS_COMMAND_MAX_RESULT_BYTES) corruptMutationRecord();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return corruptMutationRecord();
  }
  const result = canvasCommandApplyResultSchema.safeParse(parsed);
  if (!result.success) return corruptMutationRecord();
  return deepFreeze(result.data);
}

function resultFromMutation(
  row: RawCanvasMutationRow,
  requestHash: string,
  expected: { workspaceId: string; projectId: number; canvasId: number; idempotencyKey: string },
): CanvasCommandApplyResult {
  if (String(row.requestHash || "") !== requestHash) idempotencyConflict();
  const result = parsePersistedResult(row.resultJson);
  if (String(row.id || "") !== result.mutationId
    || String(row.workspaceId || "") !== expected.workspaceId
    || Number(row.projectId) !== expected.projectId
    || Number(row.canvasId) !== expected.canvasId
    || String(row.idempotencyKey || "") !== expected.idempotencyKey
    || Number(row.newRevision) !== result.canvasRevision
    || String(row.newVersion || "") !== result.canvasVersion
    || Number(row.createdAt) !== result.appliedAt) {
    return corruptMutationRecord();
  }
  return result;
}

function isUniqueConstraintError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = String(candidate?.code || "").toUpperCase();
  const message = String(candidate?.message || "");
  return code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    || code === "23505"
    || /unique constraint|duplicate key/i.test(message);
}

function nextUpdateTime(current: number | null, now: number): number {
  const minimum = (current ?? 0) + 1;
  const result = Math.max(now, minimum);
  if (!Number.isSafeInteger(result) || result < 0) {
    fail(409, "canvas_command_snapshot_invalid", "Canvas updateTime 无法安全递增");
  }
  return result;
}

export class CanvasCommandService {
  private readonly clock: () => number;
  private readonly idFactory: () => string;

  constructor(
    private readonly database: Knex,
    options: CanvasCommandServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `canvas_mut_${randomUUID()}`);
  }

  async apply(input: ApplyCanvasCommandInput): Promise<CanvasCommandApplyResult> {
    const normalized = this.normalizeInput(input);
    try {
      return await this.database.transaction((trx) => this.applyNormalizedInTransaction(trx, normalized));
    } catch (error) {
      if (!isUniqueConstraintError(error)
        && !(error instanceof AgentRuntimeError && error.code === "canvas_command_revision_conflict")) {
        throw error;
      }
      const replay = await this.database.transaction((trx) => this.tryReplayInTransaction(trx, normalized));
      if (replay) return replay;
      throw error;
    }
  }

  async applyInTransaction(
    trx: Knex.Transaction,
    input: ApplyCanvasCommandInput,
  ): Promise<CanvasCommandApplyResult> {
    return this.applyNormalizedInTransaction(trx, this.normalizeInput(input));
  }

  private normalizeInput(input: ApplyCanvasCommandInput) {
    const workspaceId = cleanIdentifier(input.workspaceId, "workspaceId");
    const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
    const commandSet = parseCommandSet(input.commandSet);
    const requestHash = commandRequestHash(workspaceId, actorUserId, commandSet);
    return { workspaceId, actorUserId, commandSet, requestHash };
  }

  private async findMutation(
    trx: Knex.Transaction,
    input: ReturnType<CanvasCommandService["normalizeInput"]>,
  ): Promise<RawCanvasMutationRow | undefined> {
    const scope = requestScope(input.commandSet);
    return trx<RawCanvasMutationRow>(CANVAS_COMMAND_MUTATION_TABLE)
      .where({
        workspaceId: input.workspaceId,
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        idempotencyKey: input.commandSet.idempotencyKey,
      })
      .first();
  }

  private async tryReplayInTransaction(
    trx: Knex.Transaction,
    input: ReturnType<CanvasCommandService["normalizeInput"]>,
  ): Promise<CanvasCommandApplyResult | null> {
    const scope = requestScope(input.commandSet);
    await assertCurrentProjectWriteAccess(
      trx,
      input.workspaceId,
      scope.projectId,
      input.actorUserId,
    );
    const existing = await this.findMutation(trx, input);
    if (!existing) return null;
    return resultFromMutation(existing, input.requestHash, {
      workspaceId: input.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      idempotencyKey: input.commandSet.idempotencyKey,
    });
  }

  private async applyNormalizedInTransaction(
    trx: Knex.Transaction,
    input: ReturnType<CanvasCommandService["normalizeInput"]>,
  ): Promise<CanvasCommandApplyResult> {
    const scope = requestScope(input.commandSet);
    await assertCurrentProjectWriteAccess(
      trx,
      input.workspaceId,
      scope.projectId,
      input.actorUserId,
    );

    const existing = await this.findMutation(trx, input);
    if (existing) {
      return resultFromMutation(existing, input.requestHash, {
        workspaceId: input.workspaceId,
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        idempotencyKey: input.commandSet.idempotencyKey,
      });
    }

    assertFreshCommandIdentity(input.commandSet);
    const row = await trx<RawCanvasRow>(CANVAS_COMMAND_CANVAS_TABLE)
      .where({ id: scope.canvasId, projectId: scope.projectId })
      .select(
        "id",
        "projectId",
        "episodesId",
        "name",
        "nodes",
        "edges",
        "viewport",
        "createTime",
        "updateTime",
        "revision",
      )
      .forUpdate()
      .first();
    if (!row) fail(404, "canvas_command_canvas_not_found", "Canvas 不存在或不属于当前项目");

    const current = normalizeCanvas(row);
    if (current.metadata.id !== scope.canvasId || current.metadata.projectId !== scope.projectId) {
      fail(409, "canvas_command_snapshot_invalid", "Canvas 持久化范围无效");
    }
    const evidence: CanvasCommandValidationEvidence = {
      projectId: scope.projectId,
      canvasId: scope.canvasIdText,
      canvasRevision: current.revision,
      canvasVersion: current.version,
      nodes: current.inspected.evidenceNodes,
      edges: current.inspected.evidenceEdges,
    };
    const commandSet = validateAgainstCurrent(input.commandSet, evidence);
    const commandSetJson = boundedCanonicalJson(
      commandSet,
      CANVAS_COMMAND_MAX_COMMAND_SET_BYTES,
      "canvas_command_invalid",
      "Canvas structured command 超出持久化上限",
    );

    const beforeSnapshot = boundedCanonicalJson({
      projectId: scope.projectId,
      canvasId: scope.canvasIdText,
      revision: current.revision,
      version: current.version,
      nodes: current.graph.nodes,
      edges: current.graph.edges,
      viewport: current.graph.viewport,
      updateTime: current.metadata.updateTime,
    }, CANVAS_COMMAND_MAX_SNAPSHOT_BYTES, "canvas_command_snapshot_too_large", "Canvas before snapshot 超出安全上限");

    const counts = applyCommands(current.graph, current.inspected, commandSet);
    inspectGraph(current.graph);
    const nodesJson = encodeJsonValue(
      current.graph.nodes,
      [],
      "nodes",
      CANVAS_COMMAND_MAX_GRAPH_JSON_BYTES,
    );
    const edgesJson = encodeJsonValue(
      current.graph.edges,
      [],
      "edges",
      CANVAS_COMMAND_MAX_GRAPH_JSON_BYTES,
    );
    const viewportJson = encodeJsonValue(
      current.graph.viewport,
      { x: 0, y: 0, zoom: 1 },
      "viewport",
      CANVAS_COMMAND_MAX_VIEWPORT_JSON_BYTES,
    );

    const appliedAt = nonNegativeInteger(this.clock(), "clock", 500);
    const updateTime = nextUpdateTime(current.metadata.updateTime, appliedAt);
    if (current.revision >= Number.MAX_SAFE_INTEGER) {
      fail(409, "canvas_command_revision_conflict", "Canvas revision 无法安全递增");
    }
    const newRevision = current.revision + 1;
    const nextMetadata = { ...current.metadata, updateTime };
    const newVersion = hashNormalizedCanvas(nextMetadata, current.graph);
    const afterSnapshot = boundedCanonicalJson({
      projectId: scope.projectId,
      canvasId: scope.canvasIdText,
      revision: newRevision,
      version: newVersion,
      nodes: current.graph.nodes,
      edges: current.graph.edges,
      viewport: current.graph.viewport,
      updateTime,
    }, CANVAS_COMMAND_MAX_SNAPSHOT_BYTES, "canvas_command_snapshot_too_large", "Canvas after snapshot 超出安全上限");

    const mutationId = cleanIdentifier(this.idFactory(), "mutationId");
    const result = deepFreeze(canvasCommandApplyResultSchema.parse({
      version: 1,
      mutationId,
      projectId: scope.projectId,
      canvasId: scope.canvasIdText,
      idempotencyKey: commandSet.idempotencyKey,
      canvasRevision: newRevision,
      canvasVersion: newVersion,
      ...counts,
      appliedAt,
    }));
    const resultJson = boundedCanonicalJson(
      result,
      CANVAS_COMMAND_MAX_RESULT_BYTES,
      "canvas_command_result_invalid",
      "Canvas command result 超出持久化上限",
    );

    const updated = await trx(CANVAS_COMMAND_CANVAS_TABLE)
      .where({
        id: scope.canvasId,
        projectId: scope.projectId,
        revision: current.revision,
      })
      .update({
        nodes: nodesJson,
        edges: edgesJson,
        viewport: viewportJson,
        updateTime,
        revision: newRevision,
      });
    if (affectedRows(updated) !== 1) {
      const latest = await trx(CANVAS_COMMAND_CANVAS_TABLE)
        .where({ id: scope.canvasId, projectId: scope.projectId })
        .select("revision")
        .first();
      fail(409, "canvas_command_revision_conflict", "Canvas 已被其他请求更新", {
        expectedRevision: current.revision,
        currentRevision: latest ? Number(latest.revision) : null,
      });
    }

    await trx(CANVAS_COMMAND_MUTATION_TABLE).insert({
      id: mutationId,
      workspaceId: input.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      actorUserId: input.actorUserId,
      idempotencyKey: commandSet.idempotencyKey,
      requestHash: input.requestHash,
      baseRevision: current.revision,
      newRevision,
      baseVersion: current.version,
      newVersion,
      commandSetJson,
      beforeSnapshot,
      afterSnapshot,
      resultJson,
      createdAt: appliedAt,
    });

    return result;
  }
}
