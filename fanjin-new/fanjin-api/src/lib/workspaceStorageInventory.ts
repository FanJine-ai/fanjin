import crypto from "node:crypto";
import type { Knex } from "knex";
import { RESOURCE_TABLES as T } from "./migrations/membershipResources";

type Client = Knex | Knex.Transaction;
const normalize = (key: unknown) => String(key || "").replace(/^\/+/, "");
export async function workspaceStoredObjectKeys(client: Client, workspaceId: string): Promise<string[]> {
  const keys = new Set<string>();
  if (await client.schema.hasTable("o_media_asset")) for (const row of await client("o_media_asset").where({ workspaceId }).select("storageKey"))
    if (row.storageKey) keys.add(normalize(row.storageKey));
  if (await client.schema.hasTable("o_image") && await client.schema.hasTable("o_assets") && await client.schema.hasTable("o_project")) {
    const rows = await client("o_image as i").join("o_assets as a", "a.id", "i.assetsId").join("o_project as p", "p.id", "a.projectId")
      .where("p.workspaceId", workspaceId).select("i.storageKey", "i.filePath");
    for (const row of rows) {
      const key = row.storageKey || row.filePath;
      if (key && !/^https?:|^data:/.test(String(key))) keys.add(normalize(key));
    }
  }
  if (await client.schema.hasTable("o_project")) {
    // Historical creators persisted files outside o_media_asset. Include their
    // authoritative keys and legacy local paths before attesting a workspace.
    const targets: Array<[string, string[]]> = [
      ["o_project", ["coverStorageKey"]], ["o_video", ["storageKey", "filePath"]],
      ["o_storyboard", ["storageKey", "filePath"]], ["o_workflow_graph", ["coverStorageKey"]],
      ["o_canvas_asset", ["coverStorageKey", "saveStorageKey"]],
    ];
    for (const [table, candidates] of targets) {
      if (!await client.schema.hasTable(table)) continue;
      const columns: string[] = [];
      for (const name of candidates) if (await client.schema.hasColumn(table, name)) columns.push(name);
      if (!columns.length) continue;
      const query = table === "o_project" ? client(`${table} as a`).where("a.workspaceId", workspaceId)
        : client(`${table} as a`).join("o_project as p", "p.id", "a.projectId").where("p.workspaceId", workspaceId);
      for (const row of await query.select(columns.map(column => `a.${column}`))) {
        for (const column of columns) {
          if (column === "filePath" && row.storageKey) continue;
          const key = row[column];
          if (key && !/^(?:https?:|data:)/.test(String(key))) keys.add(normalize(key));
        }
      }
    }
    if (await client.schema.hasTable("o_tasks")) {
      for (const row of await client("o_tasks as t").join("o_project as p", "p.id", "t.projectId")
        .where("p.workspaceId", workspaceId).select("t.relatedObjects")) {
        if (!row.relatedObjects) continue;
        // Malformed evidence must block inventory instead of losing its bytes.
        const evidence = typeof row.relatedObjects === "string" ? JSON.parse(row.relatedObjects) : row.relatedObjects;
        if (evidence?.outputStorageKey) keys.add(normalize(evidence.outputStorageKey));
      }
    }
  }
  return [...keys].sort();
}

/** Only measured objects or durable exact-size PUT evidence can initialize usage.
 * Missing historical bytes remain an explicit blocker, never a zero balance. */
export async function reconcileWorkspaceStorageInventory(client: Knex, workspaceId: string, options: {
  inspect?: (objectKey: string) => Promise<{ bytes: number; providerFingerprint: string; versionId: string | null; evidence: Record<string, unknown> }>;
  apply?: boolean;
} = {}) {
  const keys = await workspaceStoredObjectKeys(client, workspaceId);
  const intents = await client.schema.hasTable("o_object_write_intent")
    ? await client("o_object_write_intent").where({ workspaceId }).whereNot("status", "compensated") : [];
  const uploads = await client.schema.hasTable("o_reference_multipart_upload")
    ? await client("o_reference_multipart_upload").where({ workspaceId }).whereNot("status", "aborted") : [];
  const rows = await client(T.storage).where({ workspaceId }).whereNot("state", "released");
  const knownKeys = new Set([...rows.map(row => normalize(row.objectKey)), ...intents.map(row => normalize(row.objectKey)), ...uploads.map(row => normalize(row.storageKey))]);
  const measured: Array<{ key: string; bytes: number; providerFingerprint: string; versionId: string | null; evidence: Record<string, unknown> }> = [];
  const unresolved: string[] = [];
  for (const key of keys.filter(key => !knownKeys.has(key))) {
    if (!options.inspect) { unresolved.push(key); continue; }
    try {
      const result = await options.inspect(key);
      if (!Number.isSafeInteger(result.bytes) || result.bytes < 0 || !result.providerFingerprint) throw new Error("invalid object inventory evidence");
      measured.push({ key, ...result });
    } catch { unresolved.push(key); }
  }
  const report = { workspaceId, referencedObjects: keys.length, durableIntents: intents.length, measuredObjects: measured.length,
    unresolvedCount: unresolved.length, unresolved, ready: unresolved.length === 0, checkedAt: Date.now() };
  if (!options.apply) return report;
  await client.transaction(async trx => {
    await trx(T.account).insert({ workspaceId, inventoryReady: false, updatedAt: report.checkedAt }).onConflict("workspaceId").ignore();
    await trx(T.account).where({ workspaceId }).forUpdate().first();
    // Do not attest a snapshot while another path added an unmetered reference.
    if (JSON.stringify(await workspaceStoredObjectKeys(trx, workspaceId)) !== JSON.stringify(keys)) throw new Error("Storage inventory changed; repeat inventory");
    for (const intent of intents) {
      const at = report.checkedAt;
      const receipt = JSON.parse(intent.writeReceiptJson || "{}");
      await trx(T.storage).insert({ id: `intent:${intent.id}`, workspaceId, objectKey: intent.objectKey,
        providerFingerprint: intent.providerFingerprint, bytes: Number(intent.expectedSize),
        versionId: receipt.receipt?.versionId ?? null,
        state: ["stored", "committed"].includes(intent.status) ? "stored" : "reserved",
        temporary: /\/portrait-detector\/video-samples\//.test(intent.objectKey),
        createdAt: at, updatedAt: at, evidence: intent.writeReceiptJson || "{}" }).onConflict("id").ignore();
    }
    for (const upload of uploads) {
      const identity = { provider: upload.storageProvider, bucket: upload.storageBucket, region: upload.storageRegion,
        endpoint: upload.storageEndpoint, keyPrefix: upload.storageKeyPrefix, forcePathStyle: !!upload.storageForcePathStyle };
      const providerFingerprint = crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
      await trx(T.storage).insert({ id: `multipart:${upload.id}`, workspaceId, objectKey: upload.storageKey, providerFingerprint,
        versionId: upload.completionVersionId ?? null, bytes: Number(upload.declaredByteSize),
        state: upload.status === "completed" ? "stored" : "reserved", temporary: false,
        createdAt: report.checkedAt, updatedAt: report.checkedAt, evidence: JSON.stringify({ source: "multipart", sessionId: upload.id }) }).onConflict("id").ignore();
    }
    for (const item of measured) {
      const id = `inventory:${crypto.createHash("sha256").update(JSON.stringify([workspaceId, item.providerFingerprint, item.key, item.versionId])).digest("hex")}`;
      await trx(T.storage).insert({ id, workspaceId, objectKey: item.key, providerFingerprint: item.providerFingerprint,
        versionId: item.versionId, bytes: item.bytes, state: "stored", temporary: false, createdAt: report.checkedAt,
        updatedAt: report.checkedAt, evidence: JSON.stringify(item.evidence) }).onConflict("id").ignore();
    }
    await trx(T.account).where({ workspaceId }).update({ inventoryReady: report.ready, inventoryEvidence: JSON.stringify(report), updatedAt: report.checkedAt });
  });
  return report;
}
