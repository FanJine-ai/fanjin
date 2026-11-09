import crypto from "node:crypto";
import type { Knex } from "knex";
import { db } from "@/utils/db";
import u from "@/utils";
import { sanitizeFeedbackPageUrl } from "@/lib/feedbackPageUrl";
import {
  USER_FEEDBACK_ATTACHMENT_TABLE,
  USER_FEEDBACK_TABLE,
} from "@/lib/migrations/userFeedback";

const MAX_SCREENSHOTS = 3;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MIN_DESCRIPTION_LENGTH = 2;
const PROCESSING_TIMEOUT_MS = 5 * 60_000;
const WORKER_INTERVAL_MS = 15_000;
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export class UserFeedbackError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "UserFeedbackError";
  }
}

export type FeedbackScreenshotInput = {
  fileName: string;
  mimeType: string;
  dataUrl: string;
};

type StoredAttachment = {
  id: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

type FeedbackRow = {
  id: string;
  feedbackNo: string;
  userLabel: string;
  pageTitle: string;
  pageUrl: string;
  appOrigin: string;
  description: string;
  createdAt: number | string;
  syncAttempts: number;
  processingStartedAt: number | string;
};

function hasImageSignature(mimeType: string, data: Buffer): boolean {
  if (mimeType === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === "image/png") return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/gif") return ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"));
  if (mimeType === "image/webp") return data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

function parseScreenshot(input: FeedbackScreenshotInput): Omit<StoredAttachment, "id" | "storageKey"> & { data: Buffer; ext: string } {
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  const ext = MIME_EXTENSIONS[mimeType];
  if (!ext) throw new UserFeedbackError(415, "Only JPG, PNG, WebP, and GIF screenshots are supported");
  if (String(input.dataUrl || "").length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 64) {
    throw new UserFeedbackError(413, "Each screenshot must be no larger than 5 MB");
  }
  const match = String(input.dataUrl || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].toLowerCase() !== mimeType) throw new UserFeedbackError(400, "Invalid screenshot data");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > MAX_SCREENSHOT_BYTES) throw new UserFeedbackError(413, "Each screenshot must be no larger than 5 MB");
  if (data.toString("base64") !== match[2] || !hasImageSignature(mimeType, data)) {
    throw new UserFeedbackError(415, "Screenshot content does not match its MIME type");
  }
  const fileName = String(input.fileName || `screenshot.${ext}`).trim().slice(0, 255) || `screenshot.${ext}`;
  return { data, ext, fileName, mimeType, sizeBytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
}

function appOriginFrom(pageUrl: string): string {
  const configured = String(process.env.FANJIN_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "").trim();
  const raw = configured || pageUrl;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid protocol");
    return url.origin;
  } catch {
    throw new UserFeedbackError(400, "Invalid page URL");
  }
}

export async function createUserFeedback(input: {
  userId: number;
  workspaceId: string;
  userLabel: string;
  pageTitle: string;
  pageUrl: string;
  description: string;
  screenshots: FeedbackScreenshotInput[];
}, database: Knex = db): Promise<{ id: string; feedbackNo: string }> {
  const description = String(input.description || "").trim();
  if (description.length < MIN_DESCRIPTION_LENGTH || description.length > 4000) {
    throw new UserFeedbackError(400, `Description must contain between ${MIN_DESCRIPTION_LENGTH} and 4000 characters`);
  }
  const pageTitle = String(input.pageTitle || "").trim().slice(0, 200) || "Untitled page";
  let pageUrl: string;
  try { pageUrl = sanitizeFeedbackPageUrl(String(input.pageUrl || "").trim().slice(0, 2048)); }
  catch { throw new UserFeedbackError(400, "Invalid page URL"); }
  const appOrigin = appOriginFrom(pageUrl);
  if (!Number.isSafeInteger(input.userId) || input.userId < 1 || !String(input.workspaceId || "").trim()) {
    throw new UserFeedbackError(401, "Authentication is required");
  }
  if (!Array.isArray(input.screenshots) || input.screenshots.length > MAX_SCREENSHOTS) {
    throw new UserFeedbackError(400, "At most 3 screenshots may be uploaded");
  }

  const feedbackId = crypto.randomUUID();
  const feedbackNo = `FB-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${feedbackId.slice(0, 8).toUpperCase()}`;
  const parsed = input.screenshots.map(parseScreenshot);
  const stored: StoredAttachment[] = [];
  try {
    for (const item of parsed) {
      const id = crypto.randomUUID();
      const storageKey = `feedback/${input.workspaceId}/${feedbackId}/${id}.${item.ext}`;
      await u.oss.writeFile(storageKey, item.data);
      stored.push({ id, storageKey, fileName: item.fileName, mimeType: item.mimeType, sizeBytes: item.sizeBytes, sha256: item.sha256 });
    }
    const now = Date.now();
    await database.transaction(async (trx) => {
      await trx(USER_FEEDBACK_TABLE).insert({
        id: feedbackId,
        feedbackNo,
        userId: input.userId,
        workspaceId: String(input.workspaceId),
        userLabel: String(input.userLabel || `User ${input.userId}`).trim().slice(0, 200),
        pageTitle,
        pageUrl,
        appOrigin,
        description,
        syncStatus: "pending",
        syncAttempts: 0,
        nextSyncAt: now,
        createdAt: now,
        updatedAt: now,
      });
      if (stored.length) {
        await trx(USER_FEEDBACK_ATTACHMENT_TABLE).insert(stored.map((item) => ({
          ...item,
          feedbackId,
          createdAt: now,
        })));
      }
    });
  } catch (error) {
    await Promise.allSettled(stored.map((item) => u.oss.deleteFile(item.storageKey)));
    throw error;
  }
  void triggerUserFeedbackSync();
  return { id: feedbackId, feedbackNo };
}

type FeishuConfig = { appId: string; appSecret: string; wikiToken: string; sheetName: string; publicOrigin: string };

function feishuConfig(): FeishuConfig | null {
  if (process.env.FANJIN_FEISHU_FEEDBACK_ENABLED !== "1") return null;
  const publicBase = String(process.env.FANJIN_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "").trim();
  if (!publicBase) return null;
  let publicOrigin: string;
  try { publicOrigin = new URL(sanitizeFeedbackPageUrl(publicBase)).origin; }
  catch { return null; }
  const config = {
    publicOrigin,
    appId: String(process.env.FANJIN_FEISHU_FEEDBACK_APP_ID || "").trim(),
    appSecret: String(process.env.FANJIN_FEISHU_FEEDBACK_APP_SECRET || "").trim(),
    wikiToken: String(process.env.FANJIN_FEISHU_FEEDBACK_WIKI_TOKEN || "").trim(),
    sheetName: String(process.env.FANJIN_FEISHU_FEEDBACK_SHEET_NAME || "Sheet1").trim(),
  };
  return config.appId && config.appSecret && config.wikiToken ? config : null;
}

let accessTokenCache: { value: string; expiresAt: number } | null = null;
let sheetCache: { spreadsheetToken: string; sheetId: string; expiresAt: number } | null = null;

const FEEDBACK_SHEET_HEADERS = [
  "\u53cd\u9988\u7f16\u53f7",
  "\u63d0\u4ea4\u65f6\u95f4",
  "\u7528\u6237",
  "\u9875\u9762\u6807\u9898",
  "\u9875\u9762\u94fe\u63a5",
  "\u95ee\u9898\u63cf\u8ff0",
  "\u622a\u56fe\u94fe\u63a5",
] as const;

async function feishuJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
  const body = await response.json() as any;
  if (!response.ok || body?.code !== 0) {
    throw new Error(`FEISHU_API_${body?.code ?? response.status}:${String(body?.msg || "request failed").slice(0, 300)}`);
  }
  return body as T;
}

async function tenantAccessToken(config: FeishuConfig): Promise<string> {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now()) return accessTokenCache.value;
  const body = await feishuJson<any>("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
  });
  const value = String(body.tenant_access_token || "");
  if (!value) throw new Error("FEISHU_ACCESS_TOKEN_MISSING");
  accessTokenCache = { value, expiresAt: Date.now() + Math.max(60, Number(body.expire || 7200) - 120) * 1000 };
  return value;
}

async function resolveSheet(config: FeishuConfig, token: string): Promise<{ spreadsheetToken: string; sheetId: string }> {
  if (sheetCache && sheetCache.expiresAt > Date.now()) return sheetCache;
  const headers = { authorization: `Bearer ${token}` };
  const node = await feishuJson<any>(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(config.wikiToken)}`, { headers });
  if (node.data?.node?.obj_type !== "sheet") throw new Error("FEISHU_WIKI_NODE_NOT_SHEET");
  const spreadsheetToken = String(node.data.node.obj_token || "");
  const sheets = await feishuJson<any>(`https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`, { headers });
  const target = (sheets.data?.sheets || []).find((sheet: any) => String(sheet.title) === config.sheetName);
  if (!target?.sheet_id) throw new Error(`FEISHU_SHEET_NOT_FOUND:${config.sheetName}`);
  sheetCache = { spreadsheetToken, sheetId: String(target.sheet_id), expiresAt: Date.now() + 10 * 60_000 };
  return sheetCache;
}

function attachmentViewerUrl(origin: string, attachmentId: string): string {
  return `${origin.replace(/\/$/, "")}/#/feedback/attachments/${encodeURIComponent(attachmentId)}`;
}

async function ensureFeedbackSheetHeaders(
  sheet: { spreadsheetToken: string; sheetId: string },
  headers: Record<string, string>,
): Promise<void> {
  const range = `${sheet.sheetId}!A1:G1`;
  const existing = await feishuJson<any>(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(sheet.spreadsheetToken)}/values/${encodeURIComponent(range)}`,
    { headers },
  );
  const current = existing.data?.valueRange?.values?.[0];
  if (
    Array.isArray(current)
    && FEEDBACK_SHEET_HEADERS.every((value, index) => String(current[index] || "") === value)
  ) {
    return;
  }
  // A misconfigured destination must never overwrite an existing table header.
  if (Array.isArray(current) && current.some((value) => value != null && String(value) !== "")) {
    throw new Error("FEISHU_FEEDBACK_HEADER_MISMATCH");
  }
  await feishuJson<any>(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(sheet.spreadsheetToken)}/values`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ valueRange: { range, values: [[...FEEDBACK_SHEET_HEADERS]] } }),
    },
  );
}

function literalSheetText(value: string): string {
  return /^[\s\u0000-\u001f]*[=+@-]/u.test(value) ? `'${value}` : value;
}

async function syncFeedbackRow(row: FeedbackRow, attachments: Array<{ id: string }>): Promise<void> {
  const config = feishuConfig();
  if (!config) throw new Error("FEISHU_FEEDBACK_NOT_CONFIGURED");
  const token = await tenantAccessToken(config);
  const sheet = await resolveSheet(config, token);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await ensureFeedbackSheetHeaders(sheet, headers);
  const columnRange = `${sheet.sheetId}!A:A`;
  const existing = await feishuJson<any>(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(sheet.spreadsheetToken)}/values/${encodeURIComponent(columnRange)}`,
    { headers },
  );
  const alreadySynced = (existing.data?.valueRange?.values || []).some((value: unknown[]) => String(value?.[0] || "") === row.feedbackNo);
  if (alreadySynced) return;

  const screenshotLinks = attachments.map((item) => attachmentViewerUrl(config.publicOrigin, item.id)).join("\n");
  const route = new URL(sanitizeFeedbackPageUrl(row.pageUrl));
  const publicPageUrl = new URL(config.publicOrigin);
  publicPageUrl.pathname = route.pathname;
  publicPageUrl.search = route.search;
  publicPageUrl.hash = route.hash;
  const values = [[
    row.feedbackNo,
    new Date(Number(row.createdAt)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
    literalSheetText(row.userLabel),
    literalSheetText(row.pageTitle),
    publicPageUrl.toString(),
    literalSheetText(row.description),
    screenshotLinks,
  ]];
  await feishuJson<any>(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(sheet.spreadsheetToken)}/values_append`,
    { method: "POST", headers, body: JSON.stringify({ valueRange: { range: `${sheet.sheetId}!A:G`, values } }) },
  );
}

async function claimFeedback(database: Knex): Promise<FeedbackRow | null> {
  const now = Date.now();
  return database.transaction(async (trx) => {
    const query = trx<FeedbackRow>(USER_FEEDBACK_TABLE)
      .where((builder) => builder
        .whereIn("syncStatus", ["pending", "failed"])
        .andWhere("nextSyncAt", "<=", now)
        .orWhere((stale) => stale.where("syncStatus", "processing").andWhere("processingStartedAt", "<=", now - PROCESSING_TIMEOUT_MS)))
      .orderBy("createdAt", "asc");
    if (trx.client.config.client === "pg") query.forUpdate().skipLocked();
    const row = await query.first();
    if (!row) return null;
    await trx(USER_FEEDBACK_TABLE).where({ id: row.id }).update({
      syncStatus: "processing",
      syncAttempts: Number(row.syncAttempts || 0) + 1,
      processingStartedAt: now,
      updatedAt: now,
    });
    return { ...row, syncAttempts: Number(row.syncAttempts || 0) + 1, processingStartedAt: now };
  });
}

export async function runUserFeedbackSyncBatch(database: Knex = db, limit = 10): Promise<number> {
  if (!feishuConfig()) return 0;
  let processed = 0;
  while (processed < limit) {
    const row = await claimFeedback(database);
    if (!row) break;
    try {
      const attachments = await database(USER_FEEDBACK_ATTACHMENT_TABLE).where({ feedbackId: row.id }).select("id").orderBy("createdAt", "asc");
      await syncFeedbackRow(row, attachments);
      const now = Date.now();
      await database(USER_FEEDBACK_TABLE).where({
        id: row.id, syncStatus: "processing", syncAttempts: row.syncAttempts, processingStartedAt: row.processingStartedAt,
      }).update({
        syncStatus: "synced", syncedAt: now, processingStartedAt: null, lastSyncError: null, updatedAt: now,
      });
    } catch (error) {
      const attempts = Math.max(1, Number(row.syncAttempts || 1));
      const delay = Math.min(60 * 60_000, 15_000 * (2 ** Math.min(attempts - 1, 8)));
      const now = Date.now();
      await database(USER_FEEDBACK_TABLE).where({
        id: row.id, syncStatus: "processing", syncAttempts: row.syncAttempts, processingStartedAt: row.processingStartedAt,
      }).update({
        syncStatus: "failed",
        nextSyncAt: now + delay,
        processingStartedAt: null,
        lastSyncError: String(error instanceof Error ? error.message : error).slice(0, 1000),
        updatedAt: now,
      });
      console.warn(`[feedback] 飞书同步失败，将自动重试: ${row.feedbackNo}`);
    }
    processed += 1;
  }
  return processed;
}

let workerTimer: NodeJS.Timeout | null = null;
let workerRun: Promise<void> | null = null;
let workerDatabase: Knex | null = null;

async function workerTick(): Promise<void> {
  if (!workerDatabase || workerRun) return;
  workerRun = runUserFeedbackSyncBatch(workerDatabase).then(() => undefined).catch((error) => {
    console.error("[feedback] 同步任务运行失败", error);
  }).finally(() => { workerRun = null; });
  await workerRun;
}

export function triggerUserFeedbackSync(): void {
  if (workerDatabase) void workerTick();
}

export function startUserFeedbackSyncWorker(database: Knex = db): void {
  if (workerTimer) return;
  workerDatabase = database;
  void workerTick();
  workerTimer = setInterval(() => void workerTick(), WORKER_INTERVAL_MS);
  workerTimer.unref?.();
}

export async function stopUserFeedbackSyncWorker(): Promise<void> {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerRun;
  workerRun = null;
  workerDatabase = null;
}

export async function getFeedbackAttachment(input: {
  attachmentId: string;
  actorUserId: number;
  actorWorkspaceId: string;
  actorRole: string;
}, database: Knex = db): Promise<{ body: Buffer; mimeType: string; fileName: string } | null> {
  const row = await database(`${USER_FEEDBACK_ATTACHMENT_TABLE} as attachment`)
    .innerJoin(`${USER_FEEDBACK_TABLE} as feedback`, "feedback.id", "attachment.feedbackId")
    .where("attachment.id", input.attachmentId)
    .select("attachment.storageKey", "attachment.mimeType", "attachment.fileName", "feedback.userId", "feedback.workspaceId")
    .first();
  if (!row) return null;
  const privileged = ["root", "admin", "super_admin"].includes(String(input.actorRole || "").toLowerCase());
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId < 1) return null;
  // Auth middleware verifies active membership in actorWorkspaceId. Authorship
  // alone does not grant access after leaving or switching away from a workspace.
  if (!privileged && String(row.workspaceId) !== input.actorWorkspaceId) return null;
  return { body: await u.oss.getFile(String(row.storageKey)), mimeType: String(row.mimeType), fileName: String(row.fileName) };
}
