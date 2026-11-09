import type { Knex } from "knex";
import { GU_UNITS, ledgerAmount, moneyAmount } from "./contracts";
import type { ToolIdentity } from "./creationService";

/** Read customer ledger facts only. This never settles, releases or dispatches. */
export async function readTaskBilling(db: Knex, identity: ToolIdentity, task: Record<string, any>, maximum: bigint, now: number) {
  const base = { taskId: task.id, projectId: Number(task.projectId), maximum: moneyAmount(maximum),
    units: GU_UNITS, checkedAt: now, blocksDelivery: false };
  const unknown = { ...base, status: "updating", amountsKnown: false, frozen: null, charged: null,
    released: null, refunded: null, netCharged: null, entries: [],
    message: "账单暂未同步，未知金额不等于零；作品交付不受影响。" };
  try {
    const requestId = `tools:${task.id}`;
    const owned = () => db("o_billing_ledger").select("id")
      .where({ workspaceId: identity.workspaceId, apiKeyId: identity.keyId }).andWhere(q => {
        q.where("requestId", requestId).orWhere("requestId", "like", `${requestId}:scope:%`);
        if (task.relayTaskId) q.orWhere("relatedTaskId", task.relayTaskId);
      });
    // Release/refund entries may omit apiKeyId/requestId. Follow only ledger
    // parents already proven to belong to this key and task, in one snapshot.
    const children = () => db("o_billing_ledger").select("id").where({ workspaceId: identity.workspaceId })
      .whereIn("relatedLedgerId", owned());
    const rows = await db("o_billing_ledger").where({ workspaceId: identity.workspaceId })
      .andWhere(q => q.whereIn("id", owned()).orWhereIn("relatedLedgerId", owned()).orWhereIn("relatedLedgerId", children()))
      .whereIn("type", ["freeze", "deduct", "release", "refund"])
      .orderBy("createdAt", "asc").orderBy("id", "asc").limit(101);
    if (rows.length > 100) return unknown;
    if (!rows.length) {
      const output = task.resultJson ? JSON.parse(task.resultJson) : {};
      const notStarted = task.status === "queued" || ["failed", "cancelled"].includes(task.status) && output.billingStatus === "not_started";
      if (!notStarted) return unknown;
      return { ...base, status: "not_started", amountsKnown: true, frozen: moneyAmount(0n), charged: moneyAmount(0n),
        released: moneyAmount(0n), refunded: moneyAmount(0n), netCharged: moneyAmount(0n), entries: [], message: "尚未开始计费。" };
    }
    let frozen = 0n, charged = 0n, released = 0n, refunded = 0n;
    const entries = rows.map(row => {
      if (row.currency !== "GU") throw new Error("Unknown ledger currency");
      const amount = ledgerAmount(row.amountMicros);
      if (amount < 0n) throw new Error("Invalid ledger amount");
      if (row.type === "freeze") {
        const remaining = ledgerAmount(row.remainingMicros);
        if (remaining < 0n || remaining > amount) throw new Error("Invalid frozen amount");
        frozen += remaining;
      } else if (row.type === "deduct") charged += amount;
      else if (row.type === "release") released += amount;
      else if (row.type === "refund") refunded += amount;
      return { id: String(row.id), type: String(row.type), amount: moneyAmount(amount), createdAt: Number(row.createdAt) };
    });
    if (refunded > charged) return unknown;
    // Rows represent recorded facts, not an estimated final supplier charge.
    return { ...base, status: frozen > 0n ? "reserved" : refunded > 0n ? "refunded" : charged > 0n ? "settled" : released > 0n ? "released" : "updating",
      amountsKnown: true, frozen: moneyAmount(frozen), charged: moneyAmount(charged), released: moneyAmount(released),
      refunded: moneyAmount(refunded), netCharged: moneyAmount(charged - refunded), entries,
      message: "金额来自已记录的账本流水；冻结不是实际扣费，释放冻结不是退款。" };
  } catch { return unknown; }
}
