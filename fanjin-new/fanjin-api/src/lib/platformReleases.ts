import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";
import { acquireReleaseMutationLock } from "@/lib/releaseDeployments";
import { db } from "@/utils/db";

export const platformReleaseChannels = ["stable", "beta", "internal"] as const;
export const platformReleaseStatuses = ["draft", "deploying", "published", "archived"] as const;
export const PLATFORM_RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type PlatformReleaseChannel = (typeof platformReleaseChannels)[number];
export type PlatformReleaseStatus = (typeof platformReleaseStatuses)[number];

export interface PlatformReleaseRecord {
  id: string;
  version: string;
  title: string;
  channel: PlatformReleaseChannel;
  summary: string;
  releaseNotes: string;
  status: PlatformReleaseStatus;
  revision: number;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  publishedByUserId: number | null;
  archivedByUserId: number | null;
  publishedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformReleaseSummary {
  currentStable: PlatformReleaseRecord | null;
  draftCount: number;
  betaCount: number;
  latestPublishedAt: number | null;
}

export class PlatformReleaseError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "PLATFORM_RELEASE_ERROR") {
    super(message);
    this.name = "PlatformReleaseError";
    this.status = status;
    this.code = code;
  }
}

type ReleaseRow = Record<string, unknown>;
type ReleaseDb = Knex | Knex.Transaction;

function releaseTable(client: ReleaseDb = db) {
  return (client as any)(PLATFORM_RELEASE_TABLE);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapRelease(row: ReleaseRow): PlatformReleaseRecord {
  return {
    id: String(row.id || ""),
    version: String(row.version || ""),
    title: String(row.title || ""),
    channel: String(row.channel || "stable") as PlatformReleaseChannel,
    summary: String(row.summary || ""),
    releaseNotes: String(row.releaseNotes || ""),
    status: String(row.status || "draft") as PlatformReleaseStatus,
    revision: Number(row.revision || 1),
    createdByUserId: nullableNumber(row.createdByUserId),
    updatedByUserId: nullableNumber(row.updatedByUserId),
    publishedByUserId: nullableNumber(row.publishedByUserId),
    archivedByUserId: nullableNumber(row.archivedByUserId),
    publishedAt: nullableNumber(row.publishedAt),
    archivedAt: nullableNumber(row.archivedAt),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v(?=\d)/i, "");
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate?.code === "23505"
    || candidate?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || /unique constraint|unique failed/i.test(String(candidate?.message || ""));
}

async function releaseAfterWrite(id: string, client: ReleaseDb = db): Promise<PlatformReleaseRecord> {
  const row = await releaseTable(client).where({ id }).first();
  if (!row) throw new PlatformReleaseError("版本记录不存在", 404, "PLATFORM_RELEASE_NOT_FOUND");
  return mapRelease(row);
}

async function explainWriteConflict(id: string, expectedStatus: PlatformReleaseStatus, expectedRevision: number): Promise<never> {
  const current = await releaseTable().where({ id }).first();
  if (!current) throw new PlatformReleaseError("版本记录不存在", 404, "PLATFORM_RELEASE_NOT_FOUND");
  if (String(current.status) !== expectedStatus) {
    throw new PlatformReleaseError("版本状态已变化，请刷新后重试", 409, "PLATFORM_RELEASE_STATUS_CHANGED");
  }
  if (Number(current.revision || 0) !== expectedRevision) {
    throw new PlatformReleaseError("版本草稿已被其他管理员更新，请刷新后重试", 409, "PLATFORM_RELEASE_REVISION_CONFLICT");
  }
  throw new PlatformReleaseError("版本操作未完成，请刷新后重试", 409, "PLATFORM_RELEASE_WRITE_CONFLICT");
}

export async function listPlatformReleases(input: {
  query?: string | null;
  channel?: PlatformReleaseChannel | null;
  status?: PlatformReleaseStatus | null;
  pageNum?: number;
  pageSize?: number;
}): Promise<{ items: PlatformReleaseRecord[]; total: number; pageNum: number; pageSize: number; summary: PlatformReleaseSummary }> {
  const pageNum = Math.max(1, Math.floor(input.pageNum || 1));
  const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize || 20)));
  const applyFilters = (builder: any) => {
    if (input.channel) builder.where("channel", input.channel);
    if (input.status) builder.where("status", input.status);
    const search = String(input.query || "").trim();
    if (search) {
      builder.where((nested: any) => {
        nested.where("version", "like", `%${search}%`).orWhere("title", "like", `%${search}%`);
      });
    }
    return builder;
  };

  const rowsQuery = applyFilters(releaseTable().clone())
    .select("*")
    .orderByRaw(
      'CASE WHEN "status" = ? THEN 0 WHEN "status" = ? THEN 1 WHEN "status" = ? THEN 2 ELSE 3 END',
      ["deploying", "draft", "published"],
    )
    .orderBy("updatedAt", "desc")
    .limit(pageSize)
    .offset((pageNum - 1) * pageSize);
  const countQuery = applyFilters(releaseTable().clone()).count({ count: "*" }).first();
  const currentStableQuery = releaseTable()
    .where({ channel: "stable", status: "published" })
    .orderBy("publishedAt", "desc")
    .first();
  const draftCountQuery = releaseTable().where({ status: "draft" }).count({ count: "*" }).first();
  const betaCountQuery = releaseTable().where({ channel: "beta", status: "published" }).count({ count: "*" }).first();
  const latestPublishedQuery = releaseTable()
    .where({ status: "published" })
    .whereNotNull("publishedAt")
    .max({ latestPublishedAt: "publishedAt" })
    .first();

  const [rows, countRow, currentStable, draftCount, betaCount, latestPublished] = await Promise.all([
    rowsQuery,
    countQuery,
    currentStableQuery,
    draftCountQuery,
    betaCountQuery,
    latestPublishedQuery,
  ]);

  return {
    items: (rows as ReleaseRow[]).map(mapRelease),
    total: Number(countRow?.count || 0),
    pageNum,
    pageSize,
    summary: {
      currentStable: currentStable ? mapRelease(currentStable) : null,
      draftCount: Number(draftCount?.count || 0),
      betaCount: Number(betaCount?.count || 0),
      latestPublishedAt: nullableNumber(latestPublished?.latestPublishedAt),
    },
  };
}

export async function createPlatformRelease(input: {
  version: string;
  title: string;
  channel: PlatformReleaseChannel;
  summary: string;
  releaseNotes: string;
  operatorUserId: number | null;
}): Promise<PlatformReleaseRecord> {
  const now = Date.now();
  const id = uuid();
  const version = normalizeVersion(input.version);
  try {
    await releaseTable().insert({
      id,
      version,
      title: input.title.trim(),
      channel: input.channel,
      summary: input.summary.trim(),
      releaseNotes: input.releaseNotes.trim(),
      status: "draft",
      revision: 1,
      createdByUserId: input.operatorUserId,
      updatedByUserId: input.operatorUserId,
      publishedByUserId: null,
      archivedByUserId: null,
      publishedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PlatformReleaseError(`版本 ${version} 已存在`, 409, "PLATFORM_RELEASE_VERSION_EXISTS");
    }
    throw error;
  }
  return releaseAfterWrite(id);
}

export async function updatePlatformRelease(input: {
  id: string;
  revision: number;
  version: string;
  title: string;
  channel: PlatformReleaseChannel;
  summary: string;
  releaseNotes: string;
  operatorUserId: number | null;
}): Promise<PlatformReleaseRecord> {
  const version = normalizeVersion(input.version);
  try {
    const updated = await releaseTable()
      .where({ id: input.id, status: "draft", revision: input.revision })
      .update({
        version,
        title: input.title.trim(),
        channel: input.channel,
        summary: input.summary.trim(),
        releaseNotes: input.releaseNotes.trim(),
        updatedByUserId: input.operatorUserId,
        updatedAt: Date.now(),
        revision: input.revision + 1,
      });
    if (Number(updated || 0) !== 1) await explainWriteConflict(input.id, "draft", input.revision);
  } catch (error) {
    if (error instanceof PlatformReleaseError) throw error;
    if (isUniqueViolation(error)) {
      throw new PlatformReleaseError(`版本 ${version} 已存在`, 409, "PLATFORM_RELEASE_VERSION_EXISTS");
    }
    throw error;
  }
  return releaseAfterWrite(input.id);
}

export async function publishPlatformRelease(input: {
  id: string;
  revision: number;
  operatorUserId: number | null;
}): Promise<PlatformReleaseRecord> {
  void input;
  throw new PlatformReleaseError(
    "直接标记正式发布已停用，只有通过公网冒烟验证的滚动发布任务可以完成发布",
    410,
    "PLATFORM_RELEASE_DEPLOYMENT_REQUIRED",
  );
}

export async function archivePlatformRelease(input: {
  id: string;
  revision: number;
  operatorUserId: number | null;
}): Promise<PlatformReleaseRecord> {
  return (db as unknown as Knex).transaction(async (trx) => {
    // Archiving changes the set used to resolve a channel's published
    // baseline. Serialize it with release start/finalization before taking any
    // row locks, then refuse to remove the baseline the fleet is using.
    await acquireReleaseMutationLock(trx);
    const current = await releaseTable(trx)
      .where({ id: input.id })
      .forUpdate()
      .first();
    if (!current) {
      throw new PlatformReleaseError("版本记录不存在", 404, "PLATFORM_RELEASE_NOT_FOUND");
    }
    if (String(current.status) !== "published") {
      throw new PlatformReleaseError("版本状态已变化，请刷新后重试", 409, "PLATFORM_RELEASE_STATUS_CHANGED");
    }
    if (Number(current.revision || 0) !== input.revision) {
      throw new PlatformReleaseError(
        "版本草稿已被其他管理员更新，请刷新后重试",
        409,
        "PLATFORM_RELEASE_REVISION_CONFLICT",
      );
    }

    const currentBaseline = await releaseTable(trx)
      .where({ channel: String(current.channel), status: "published" })
      .orderBy("publishedAt", "desc")
      .orderBy("updatedAt", "desc")
      .orderBy("createdAt", "desc")
      .forUpdate()
      .first();
    if (!currentBaseline || String(currentBaseline.id) === input.id) {
      throw new PlatformReleaseError(
        "当前生产基线不能归档；请先完成同通道后续版本发布",
        409,
        "PLATFORM_RELEASE_ACTIVE_BASELINE_ARCHIVE_FORBIDDEN",
      );
    }

    const now = Date.now();
    const updated = await releaseTable(trx)
      .where({ id: input.id, status: "published", revision: input.revision })
      .update({
        status: "archived",
        archivedAt: now,
        archivedByUserId: input.operatorUserId,
        updatedByUserId: input.operatorUserId,
        updatedAt: now,
        revision: input.revision + 1,
      });
    if (Number(updated || 0) !== 1) {
      throw new PlatformReleaseError(
        "版本操作未完成，请刷新后重试",
        409,
        "PLATFORM_RELEASE_WRITE_CONFLICT",
      );
    }
    return releaseAfterWrite(input.id, trx);
  });
}
