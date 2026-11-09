import { apiGet } from "../../../../api/http";
import { apiPostWithStepUp } from "../../../../api/stepUp";
import type { RedemptionList } from "./types";

const REDEMPTION_PAGE_SIZE = 100;
const MAX_REDEMPTION_BATCH_SIZE = 1000;

export async function listRedemptionCodes(input: { page?: number; pageSize?: number; status?: string; batchId?: string; signal?: AbortSignal }): Promise<RedemptionList> {
  const query = new URLSearchParams({ page: String(input.page || 1), pageSize: String(input.pageSize || 100) });
  if (input.status) query.set("status", input.status); if (input.batchId) query.set("batchId", input.batchId);
  const value = await apiGet<unknown>(`/admin/redemption/list?${query}`, undefined, { signal: input.signal });
  const payload = value && typeof value === "object" && "data" in value ? (value as { data?: unknown }).data : value;
  const object = payload && typeof payload === "object" ? payload as { total?: unknown; items?: unknown } : {};
  return { total: Number(object.total || 0), items: Array.isArray(object.items) ? object.items as RedemptionList["items"] : [] };
}

/**
 * Fetches one complete redemption batch without silently accepting a partial page.
 *
 * The list endpoint intentionally caps pageSize at 100 while a generated batch can
 * contain 1000 codes. Keep the pagination contract here so every batch consumer
 * (details and exports) gets the same completeness and consistency checks.
 */
export async function listAllRedemptionCodesByBatch(batchId: string, signal?: AbortSignal): Promise<RedemptionList> {
  const normalizedBatchId = batchId.trim();
  if (!normalizedBatchId) throw new Error("批次 ID 不能为空");

  const items: RedemptionList["items"] = [];
  const seenIds = new Set<string>();
  let expectedTotal: number | null = null;

  for (let page = 1; ; page += 1) {
    const result = await listRedemptionCodes({
      page,
      pageSize: REDEMPTION_PAGE_SIZE,
      batchId: normalizedBatchId,
      signal,
    });
    const pageTotal = Math.max(0, Math.trunc(result.total));

    if (expectedTotal === null) {
      expectedTotal = pageTotal;
      if (expectedTotal > MAX_REDEMPTION_BATCH_SIZE) {
        throw new Error(`批次数据异常：数量 ${expectedTotal} 超过单批上限 ${MAX_REDEMPTION_BATCH_SIZE}`);
      }
    } else if (pageTotal !== expectedTotal) {
      throw new Error("批次数据在读取期间发生变化，请重试");
    }

    for (const item of result.items) {
      const id = String(item.id || "");
      if (id && seenIds.has(id)) throw new Error("批次分页返回了重复数据，请重试");
      if (id) seenIds.add(id);
      items.push(item);
    }

    if (items.length === expectedTotal) return { total: expectedTotal, items };
    if (items.length > expectedTotal) throw new Error("批次分页返回数量超过总数，请重试");
    if (result.items.length < REDEMPTION_PAGE_SIZE) {
      throw new Error(`批次数据不完整：应有 ${expectedTotal} 张，实际读取 ${items.length} 张`);
    }
  }
}

export async function generateRedemptionCodes(payload: Record<string, unknown>) {
  const value = await apiPostWithStepUp<unknown>("/admin/redemption/generate", payload, "admin.redemption");
  const object = value && typeof value === "object" && "data" in value ? (value as { data?: unknown }).data : value;
  return object && typeof object === "object" && Array.isArray((object as { codes?: unknown }).codes) ? (object as { codes: string[] }).codes : [];
}
export async function disableRedemptionCode(id: string) { return apiPostWithStepUp(`/admin/redemption/${id}/disable`, {}, "admin.redemption"); }
