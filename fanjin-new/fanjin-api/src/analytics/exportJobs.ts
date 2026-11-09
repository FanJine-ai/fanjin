import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { AnalyticsSubject } from "./service";
import { AnalyticsError, type AnalyticsAction, type AnalyticsInput } from "./contracts";
const TABLE = "o_external_tool_operation", JOB = "analytics_export", PART = "analytics_export_part", TTL = 86400000;
type Core = {
  execute(subject: AnalyticsSubject, action: AnalyticsAction, input: unknown): Promise<Record<string, any>>;
  exportAccess(subject: AnalyticsSubject, input: AnalyticsInput): Promise<string>;
};
const parse = (value: string) => JSON.parse(value || "{}");
const scope = (s: AnalyticsSubject) => ({ userId: s.userId, keyId: s.keyId || `session:${s.userId}` });

// Reuse the durable, leased operation queue and keep bounded export pages as
// private expiring artifacts. No local files or sticky server affinity required.
export function createAnalyticsExportService(db: Knex, core: Core, now = Date.now) {
  const view = (row: any) => {
    const result = parse(row.resultJson), input = parse(row.requestJson).input;
    return { id: row.id, status: Number(row.expiresAt) <= now() ? "expired" : row.status, kind: input.kind, format: input.format,
      rows: result.rows || 0, parts: result.parts || 0, createdAt: Number(row.createdAt), expiresAt: Number(row.expiresAt), errorCode: row.errorCode || null,
      filename: `fanjin-${input.scope}-${input.kind}-${row.createdAt}.${input.format}` };
  };
  async function readable(s: AnalyticsSubject, id?: string) {
    const row = id ? await db(TABLE).where({ ...scope(s), id, kind: JOB }).first() : null;
    if (!row) throw new AnalyticsError("NOT_FOUND", "导出任务不存在或无权查看", 404);
    if (Number(row.expiresAt) <= now()) throw new AnalyticsError("EXPORT_EXPIRED", "导出已过期，请重新创建", 410);
    const request = parse(row.requestJson);
    // Reauthorize against live membership/key state; reduced permissions must
    // never expose an artifact generated with earlier broader permissions.
    if (await core.exportAccess(s, request.input) !== request.access) throw new AnalyticsError("EXPORT_SCOPE_CHANGED", "查询权限已变化，请重新导出", 403);
    return row;
  }
  async function execute(s: AnalyticsSubject, action: AnalyticsAction, input: AnalyticsInput) {
    if (action === "export-create") {
      const { id, part, idempotencyKey, cursor, ...filters } = input;
      if (!idempotencyKey) throw new AnalyticsError("IDEMPOTENCY_REQUIRED", "请提供导出请求编号");
      const timestamp = now();
      const china = new Date(timestamp + 28800000);
      const query = { ...filters, kind: filters.kind || "usage", from: filters.from ?? Date.UTC(china.getUTCFullYear(), china.getUTCMonth(), 1) - 28800000, to: filters.to ?? timestamp, limit: 100 };
      const access = await core.exportAccess(s, query);
      const hash = createHash("sha256").update(JSON.stringify({ filters, access })).digest("hex");
      const identity = { ...scope(s), workspaceId: input.scope === "account" ? "account" : input.workspaceId || s.workspaceId || "account" };
      return db.transaction(async trx => {
        // Serialize creation per user, including concurrent retries on other API nodes.
        await trx("o_user").where({ id: s.userId }).forUpdate().first();
        const existing = await trx(TABLE).where({ ...identity, kind: JOB, idempotencyKey }).first();
        if (existing) { if (existing.requestHash !== hash) throw new AnalyticsError("IDEMPOTENCY_CONFLICT", "导出请求编号已用于其他筛选", 409); if (Number(existing.expiresAt) <= now()) throw new AnalyticsError("EXPORT_EXPIRED", "导出已过期，请重新创建", 410); return view(existing); }
        const active = await trx(TABLE).where({ ...scope(s), kind: JOB }).whereIn("status", ["queued", "running"]).where("expiresAt", ">", timestamp).count({ n: "id" }).first();
        if (Number(active?.n) >= 2) throw new AnalyticsError("EXPORT_BUSY", "已有两个导出任务进行中，请完成或取消后再试", 429);
        const jobId = randomUUID();
        await trx(TABLE).insert({ ...identity, id: jobId, kind: JOB, idempotencyKey, requestHash: hash,
          requestJson: JSON.stringify({ subject: s, input: query, access }), resultJson: JSON.stringify({ cursor: null, parts: 0, rows: 0 }), status: "queued", createdAt: timestamp, updatedAt: timestamp, expiresAt: timestamp + TTL })
          .onConflict(["workspaceId", "keyId", "kind", "idempotencyKey"]).ignore();
        const created = await trx(TABLE).where({ ...identity, kind: JOB, idempotencyKey }).first();
        if (!created || created.requestHash !== hash) throw new AnalyticsError("IDEMPOTENCY_CONFLICT", "导出请求编号已用于其他筛选", 409);
        return view(created);
      });
    }
    if (action === "export-jobs") {
      await core.exportAccess(s, input);
      const rows = await db(TABLE).where({ ...scope(s), kind: JOB, workspaceId: input.scope === "account" ? "account" : input.workspaceId || s.workspaceId || "account" }).where("expiresAt", ">", now()).orderBy("createdAt", "desc").limit(20);
      const items = [];
      for (const row of rows) {
        const request = parse(row.requestJson);
        if (request.input.scope !== input.scope || input.scope === "workspace" && row.workspaceId !== (input.workspaceId || s.workspaceId)) continue;
        try { await readable(s, row.id); items.push(view(row)); } catch (error) { if (!(error instanceof AnalyticsError)) throw error; }
      }
      return { items };
    }
    const row = await readable(s, input.id);
    if (action === "export-status") return view(row);
    if (action === "export-cancel") {
      await db(TABLE).where({ id: row.id, kind: JOB }).whereIn("status", ["queued", "running"]).update({ status: "cancelled", updatedAt: now(), claimedBy: null });
      return view(await db(TABLE).where({ id: row.id }).first());
    }
    if (action === "export-part") {
      if (row.status !== "succeeded") throw new AnalyticsError("EXPORT_NOT_READY", "导出尚未完成，暂不能下载", 409);
      const result = parse(row.resultJson), index = input.part ?? 0;
      if (index >= result.parts) throw new AnalyticsError("EXPORT_PART_INVALID", "导出分段不存在", 404);
      const chunk = await db(TABLE).where({ id: `${row.id}:${index}`, kind: PART, ...scope(s) }).first();
      if (!chunk) throw new AnalyticsError("EXPORT_ARTIFACT_MISSING", "导出文件不可用，请重新导出", 410);
      return { ...view(row), content: parse(chunk.resultJson).content, nextPart: index + 1 < result.parts ? index + 1 : null };
    }
    throw new AnalyticsError("NOT_FOUND", "导出操作不存在", 404);
  }
  async function tick(keepRunning: () => boolean = () => true) {
    // Bounded expiry cleanup; pages and parent are deleted in one transaction.
    const expired = await db(TABLE).where({ kind: JOB }).where("expiresAt", "<=", now()).select("id").limit(20);
    for (const row of expired) await db.transaction(async trx => {
      await trx(TABLE).where({ kind: PART }).where("id", "like", `${row.id}:%`).delete();
      await trx(TABLE).where({ id: row.id, kind: JOB }).delete();
    });
    if (!keepRunning()) return;
    const row = await db(TABLE).where({ kind: JOB }).where("expiresAt", ">", now())
      .where(q => q.where("status", "queued").orWhere(q => q.where("status", "running").where("updatedAt", "<", now() - 60000)))
      .orderBy("updatedAt", "asc").first();
    if (!row) return;
    const owner = randomUUID();
    const won = await db(TABLE).where({ id: row.id, status: row.status, updatedAt: row.updatedAt }).update({ status: "running", claimedBy: owner, updatedAt: now() });
    if (!won) return;
    const request = parse(row.requestJson); let progress = parse(row.resultJson);
    try {
      for (let pageIndex = 0; pageIndex < 5 && keepRunning(); pageIndex++) {
        if (await core.exportAccess(request.subject, request.input) !== request.access) throw new AnalyticsError("EXPORT_SCOPE_CHANGED", "权限已变化", 403);
        const page = await core.execute(request.subject, "export", { ...request.input, cursor: progress.cursor || undefined });
        // Each page remains under the machine tool response envelope limit.
        const part = progress.parts, rows = page.rowCount;
        const next = { cursor: page.nextCursor, parts: part + 1, rows: progress.rows + rows };
        const saved = await db.transaction(async trx => {
          const count = await trx(TABLE).where({ id: row.id, status: "running", claimedBy: owner }).where("expiresAt", ">", now()).update({ resultJson: JSON.stringify(next), status: page.complete ? "succeeded" : "running", updatedAt: now() });
          if (!count) return false;
          await trx(TABLE).insert({ id: `${row.id}:${part}`, ...scope(request.subject), workspaceId: row.workspaceId, kind: PART, idempotencyKey: `${row.id}:${part}`,
            requestHash: row.requestHash, requestJson: "{}", resultJson: JSON.stringify({ content: page.content }), status: "succeeded", createdAt: now(), updatedAt: now(), expiresAt: row.expiresAt });
          return true;
        });
        if (!saved || page.complete) return;
        progress = next;
      }
      await db(TABLE).where({ id: row.id, status: "running", claimedBy: owner }).update({ status: "queued", claimedBy: null, updatedAt: now() });
    } catch (error) {
      await db(TABLE).where({ id: row.id, status: "running", claimedBy: owner }).update({ status: "failed", claimedBy: null, updatedAt: now(), errorCode: error instanceof AnalyticsError ? error.code : "EXPORT_FAILED" });
    }
  }
  return { execute, tick };
}
