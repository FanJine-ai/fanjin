import type { Knex } from "knex";
import { MembershipError } from "./membershipCatalog";
import { assertMembershipSharedWrite, workspaceMembershipPolicy } from "./membershipPolicy";
import { RESOURCE_TABLES as T } from "./migrations/membershipResources";
import { workspaceStoredObjectKeys } from "./workspaceStorageInventory";

type Client = Knex | Knex.Transaction;
const activeExecution = ["reserved", "dispatched"];
export class WorkspaceGenerationQueued extends MembershipError {
  retryAfterMs = 2000;
  constructor(public current: number, public limit: number) {
    super(`当前 ${current}/${limit} 个任务正在生成，本任务排队中`, "WORKSPACE_GENERATION_QUEUED", 429);
  }
}
export const isGenerationEndpoint = (type: string) => ["image_generation", "video_generation"].includes(type);

async function lockResourceAccount(trx: Knex.Transaction, workspaceId: string) {
  await trx(T.account).insert({ workspaceId, inventoryReady: false, updatedAt: Date.now() }).onConflict("workspaceId").ignore();
  const account = await trx(T.account).where({ workspaceId }).forUpdate().first();
  if (!account.inventoryReady) {
    const rows = await trx(T.storage).where({ workspaceId }).select("id", "objectKey");
    const keys = new Set(rows.map(row => String(row.objectKey)));
    const ids = new Set(rows.map(row => String(row.id)));
    const storedKeys = await workspaceStoredObjectKeys(trx, workspaceId);
    const intents = await trx.schema.hasTable("o_object_write_intent")
      ? await trx("o_object_write_intent").where({ workspaceId }).whereNot("status", "compensated").select("id") : [];
    const uploads = await trx.schema.hasTable("o_reference_multipart_upload")
      ? await trx("o_reference_multipart_upload").where({ workspaceId }).whereNot("status", "aborted").select("id") : [];
    if (storedKeys.every(key => keys.has(key)) && intents.every(row => ids.has(`intent:${row.id}`)) && uploads.every(row => ids.has(`multipart:${row.id}`))) {
      await trx(T.account).where({ workspaceId }).update({ inventoryReady: true,
        inventoryEvidence: JSON.stringify({ source: "all_objects_metered", checkedAt: Date.now() }), updatedAt: Date.now() });
      account.inventoryReady = true;
    }
  }
  return account;
}
export async function initializeWorkspaceResourceInventory(client: Knex, workspaceId: string) {
  if (await client.schema.hasTable(T.account)) await client.transaction(trx => lockResourceAccount(trx, workspaceId));
}
export async function workspaceResourceUsage(client: Client, workspaceId: string) {
  if (!await client.schema.hasTable(T.account)) return null;
  const account = await client(T.account).where({ workspaceId }).first();
  const storage = await client(T.storage).where({ workspaceId, temporary: false }).whereIn("state", ["reserved", "stored"])
    .select("state").sum({ bytes: "bytes" }).groupBy("state") as Array<{ state: string; bytes: string | number }>;
  const executions = await client(T.execution).where({ workspaceId }).whereIn("state", [...activeExecution, "queued"])
    .select("state").count({ count: "*" }).sum({ bytes: "storageBytes" }).groupBy("state") as Array<{ state: string; count: string | number; bytes: string | number }>;
  const usedBytes = Number(storage.find(row => row.state === "stored")?.bytes || 0);
  const reservedBytes = Number(storage.find(row => row.state === "reserved")?.bytes || 0)
    + executions.filter(row => activeExecution.includes(String(row.state))).reduce((n, row) => n + Number(row.bytes || 0), 0);
  return { inventoryReady: account?.inventoryReady === true || account?.inventoryReady === 1, usedBytes, reservedBytes,
    running: executions.filter(row => activeExecution.includes(String(row.state))).reduce((n, row) => n + Number(row.count || 0), 0),
    queued: Number(executions.find(row => row.state === "queued")?.count || 0) };
}
function requireSpace(usage: NonNullable<Awaited<ReturnType<typeof workspaceResourceUsage>>>, bytes: number, limit: number) {
  if (!usage.inventoryReady) throw new MembershipError("工作区云空间正在核对，请稍后重试；已有作品仍可查看和下载", "WORKSPACE_STORAGE_INVENTORY_PENDING", 409);
  if (usage.usedBytes + usage.reservedBytes + bytes > limit) throw new MembershipError(
    `云空间不足：已用 ${(usage.usedBytes / 1e9).toFixed(2)} GB / ${limit / 1e9} GB，请清理文件或扩容；已有作品仍可查看和下载`,
    "WORKSPACE_STORAGE_FULL", 409);
}

/** Caller supplies the dispatch transaction. The account mutex serializes admissions
 * across processes; a terminal release only reduces occupancy and needs no mutex.
 * There is deliberately no TTL-based release of an unknown provider outcome. */
export async function acquireWorkspaceGeneration(trx: Knex.Transaction, input: { workspaceId: string; id: string; endpointType: string }) {
  if (!isGenerationEndpoint(input.endpointType) || !await trx.schema.hasTable(T.execution)) return;
  await assertMembershipSharedWrite(trx, input.workspaceId);
  await lockResourceAccount(trx, input.workspaceId);
  const existing = await trx(T.execution).where({ id: input.id }).first();
  if (existing && (existing.workspaceId !== input.workspaceId || existing.endpointType !== input.endpointType))
    throw new MembershipError("任务资源归属不一致", "WORKSPACE_RESOURCE_IDENTITY_MISMATCH", 409);
  if (existing?.state === "dispatched" || existing?.state === "released")
    throw new MembershipError("任务已经提交或结束，不能重复生成", "WORKSPACE_RESOURCE_REPLAY", 409);
  if (existing?.state === "reserved") return;
  const policy = await workspaceMembershipPolicy(trx, input.workspaceId);
  const usage = (await workspaceResourceUsage(trx, input.workspaceId))!;
  const storageBytes = input.endpointType === "video_generation" ? 250e6 : 32e6;
  if (policy.authorizationEnabled) {
    if (usage.running >= policy.limits.concurrentGenerations) throw new WorkspaceGenerationQueued(usage.running, policy.limits.concurrentGenerations);
    requireSpace(usage, storageBytes, policy.limits.storageBytes);
  }
  const at = Date.now();
  await trx(T.execution).insert({ ...input, state: "reserved", storageBytes, createdAt: at, updatedAt: at })
    .onConflict("id").merge({ state: "reserved", storageBytes, updatedAt: at });
}

export async function markWorkspaceGenerationDispatched(trx: Knex.Transaction, id: string) {
  if (await trx.schema.hasTable(T.execution)) await trx(T.execution).where({ id, state: "reserved" }).update({ state: "dispatched", updatedAt: Date.now() });
}
export async function recordWorkspaceGenerationQueue(client: Client, input: { workspaceId: string; id: string; endpointType: string }) {
  if (!isGenerationEndpoint(input.endpointType) || !await client.schema.hasTable(T.execution)) return;
  const at = Date.now();
  await client(T.execution).insert({ ...input, state: "queued", storageBytes: 0, createdAt: at, updatedAt: at }).onConflict("id").ignore();
}
export async function releaseWorkspaceGeneration(client: Client, id: string, proof: "settled" | "not_dispatched" | "definitive_not_billable") {
  if (!await client.schema.hasTable(T.execution)) return;
  const query = client(T.execution).where({ id });
  if (proof === "not_dispatched") query.whereIn("state", ["queued", "reserved"]);
  await query.update({ state: "released", storageBytes: 0, releaseProof: proof, updatedAt: Date.now() });
}

export async function reserveWorkspaceStorage(trx: Knex.Transaction, input: {
  id: string; workspaceId: string; objectKey: string; providerFingerprint: string; bytes: number;
  temporary?: boolean; acceptedGeneration?: boolean;
}) {
  if (!await trx.schema.hasTable(T.storage)) return;
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) throw new MembershipError("存储大小无效");
  if (!input.acceptedGeneration && !input.temporary) await assertMembershipSharedWrite(trx, input.workspaceId);
  await lockResourceAccount(trx, input.workspaceId);
  const previous = await trx(T.storage).where({ id: input.id }).first();
  if (previous) {
    if (previous.workspaceId !== input.workspaceId || previous.objectKey !== input.objectKey || Number(previous.bytes) !== input.bytes)
      throw new MembershipError("素材空间预留与请求不一致", "WORKSPACE_STORAGE_REPLAY", 409);
    if (previous.state === "released") throw new MembershipError("素材上传已结束", "WORKSPACE_STORAGE_REPLAY", 409);
    return;
  }
  const policy = await workspaceMembershipPolicy(trx, input.workspaceId);
  // Already accepted outputs must always be retained, even after expiry/overage.
  // Their dispatch reservation is counted until definitive settlement.
  if (policy.authorizationEnabled && !input.temporary && !input.acceptedGeneration)
    requireSpace((await workspaceResourceUsage(trx, input.workspaceId))!, input.bytes, policy.limits.storageBytes);
  const at = Date.now();
  await trx(T.storage).insert({ id: input.id, workspaceId: input.workspaceId, objectKey: input.objectKey,
    providerFingerprint: input.providerFingerprint, bytes: input.bytes, temporary: !!input.temporary,
    state: "reserved", createdAt: at, updatedAt: at, evidence: "{}" });
}
export async function commitWorkspaceStorage(client: Client, id: string, bytes: number, evidence: Record<string, unknown>) {
  if (!await client.schema.hasTable(T.storage)) return;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new MembershipError("存储回执大小无效");
  await client(T.storage).where({ id }).whereIn("state", ["reserved", "stored"]).update({ state: "stored", bytes,
    versionId: typeof evidence.versionId === "string" ? evidence.versionId : null, evidence: JSON.stringify(evidence), updatedAt: Date.now() });
}
export async function releaseWorkspaceStorage(client: Client, id: string, evidence: Record<string, unknown>) {
  if (!await client.schema.hasTable(T.storage)) return;
  await client(T.storage).where({ id }).update({ state: "released", evidence: JSON.stringify(evidence), updatedAt: Date.now() });
}
export async function releaseWorkspaceStoredGeneration(client: Client, input: {
  providerFingerprint: string; objectKey: string; versionId: string | null; evidence: Record<string, unknown>;
}) {
  if (!await client.schema.hasTable(T.storage)) return;
  await client(T.storage).where({ providerFingerprint: input.providerFingerprint, objectKey: input.objectKey,
    versionId: input.versionId, state: "stored" }).update({ state: "released", evidence: JSON.stringify(input.evidence), updatedAt: Date.now() });
}
