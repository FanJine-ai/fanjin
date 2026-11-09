import { apiPost } from "./http";

export interface NovelItem {
  id: number | string;
  title?: string;
  content?: string;
  index?: number | string;
  reel?: string;
  chapter?: string;
  chapterData?: string;
  event?: string;
  eventState?: number;
  wordCount?: number;
  status?: string;
  createTime?: string;
}

export interface NovelPageQuery {
  projectId: number;
  page: number;
  limit: number;
  search?: string;
}

export interface NovelPageResult {
  data: NovelItem[];
  total: number;
}

export type CompleteNovelQuery = Omit<NovelPageQuery, "page" | "limit">;

export const NOVEL_PAGE_SIZE = 100 as const;
const NOVEL_API_MAX_PAGE_SIZE = 1_000;
const NOVEL_MAX_PAGES = 1_000;

function normalizeNovelItem(item: NovelItem): NovelItem {
  const content = String(item.content || item.chapterData || "");
  const eventState = Number(item.eventState || 0);
  return {
    ...item,
    title: item.title || item.reel || item.chapter || "未命名",
    content,
    chapter: item.chapter || item.title || item.reel || "—",
    wordCount: content.length,
    status: item.status || (eventState === 1 ? "已分析" : eventState === -1 ? "分析失败" : "待分析"),
  };
}

export function normalizeNovelPageResponse(value: unknown): NovelPageResult {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!source || !Array.isArray(source.data)) {
    throw new Error("小说列表响应格式无效，已阻止展示空数据");
  }
  const total = typeof source.total === "number"
    ? source.total
    : typeof source.total === "string" && /^\d+$/.test(source.total)
      ? Number(source.total)
      : Number.NaN;
  if (!Number.isSafeInteger(total) || total < 0 || total < source.data.length) {
    throw new Error("小说列表总数响应格式无效，已阻止展示不完整数据");
  }
  const data = source.data.map((entry, index) => {
    const row = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const id = Number(row?.id);
    if (
      !row
      || !Number.isSafeInteger(id)
      || id <= 0
      || typeof row.reel !== "string"
      || typeof row.chapter !== "string"
      || typeof row.chapterData !== "string"
    ) {
      throw new Error(`小说列表第 ${index + 1} 条记录格式无效，已阻止展示不完整数据`);
    }
    const chapterIndex = Number(row.index);
    const eventState = Number(row.eventState ?? 0);
    if (
      !Number.isFinite(chapterIndex)
      || chapterIndex <= 0
      || !Number.isFinite(eventState)
    ) {
      throw new Error(`小说列表第 ${index + 1} 条记录状态无效，已阻止展示不完整数据`);
    }
    return normalizeNovelItem({
      id,
      index: chapterIndex,
      reel: row.reel,
      chapter: row.chapter,
      chapterData: row.chapterData,
      event: typeof row.event === "string" ? row.event : "",
      eventState,
    });
  });
  return { data, total };
}

/** Retained for page-level callers that only need the normalized rows. */
export function normalizeNovelListResponse(value: unknown): NovelItem[] {
  return normalizeNovelPageResponse(value).data;
}

export async function listNovelPage(payload: NovelPageQuery): Promise<NovelPageResult> {
  if (
    !Number.isSafeInteger(payload.projectId)
    || payload.projectId <= 0
    || !Number.isSafeInteger(payload.page)
    || payload.page <= 0
    || !Number.isSafeInteger(payload.limit)
    || payload.limit <= 0
    || payload.limit > NOVEL_API_MAX_PAGE_SIZE
    || (payload.search !== undefined && (
      typeof payload.search !== "string" || payload.search.length > 2_048
    ))
  ) {
    throw new Error("小说列表分页参数无效");
  }
  const response = await apiPost<unknown>(
    "/novel/getNovel",
    payload as unknown as Record<string, unknown>,
  );
  const result = normalizeNovelPageResponse(response);
  if (result.data.length > payload.limit) {
    throw new Error("小说列表单页返回数量超限，已阻止展示不完整数据");
  }
  return result;
}

/** Load every response-bound page using the real Web page width. */
export async function listCompleteNovel(payload: CompleteNovelQuery): Promise<NovelItem[]> {
  const rows: NovelItem[] = [];
  const seenIds = new Set<number | string>();
  let expectedTotal: number | null = null;
  for (let page = 1; page <= NOVEL_MAX_PAGES; page += 1) {
    const result = await listNovelPage({
      projectId: payload.projectId,
      page,
      limit: NOVEL_PAGE_SIZE,
      search: payload.search ?? "",
    });
    if (expectedTotal === null) {
      expectedTotal = result.total;
      if (expectedTotal > NOVEL_PAGE_SIZE * NOVEL_MAX_PAGES) {
        throw new Error("小说列表分页超过安全上限，已阻止展示不完整数据");
      }
    }
    if (result.total !== expectedTotal) {
      throw new Error("小说列表总数在读取期间发生变化，已阻止展示不完整数据");
    }
    if (result.data.length > NOVEL_PAGE_SIZE) {
      throw new Error("小说列表单页返回数量超限，已阻止展示不完整数据");
    }
    for (const item of result.data) {
      if (seenIds.has(item.id)) {
        throw new Error("小说列表分页返回重复记录，已阻止展示不完整数据");
      }
      seenIds.add(item.id);
      rows.push(item);
    }
    if (rows.length > expectedTotal) {
      throw new Error("小说列表分页返回数量超过总数，已阻止展示不完整数据");
    }
    if (rows.length === expectedTotal) return rows;
    if (result.data.length < NOVEL_PAGE_SIZE) {
      throw new Error("小说列表分页提前结束，已阻止展示不完整数据");
    }
  }
  throw new Error("小说列表分页超过安全上限，已阻止展示不完整数据");
}
