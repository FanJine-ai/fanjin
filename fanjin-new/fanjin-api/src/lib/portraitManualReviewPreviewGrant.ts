import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Knex } from "knex";
import { enforceSessionPolicy } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";
import { PORTRAIT_MANUAL_REVIEW_TABLE } from "@/lib/migrations/portraitAssetAdmission";
import {
  PortraitManualReviewError,
  portraitManualReviewActor,
  portraitManualReviewSessionHash,
  portraitManualReviewSessionHashFromId,
  resolvePortraitManualReviewPreview,
} from "@/lib/portraitManualReview";

type Database = Knex | Knex.Transaction;
type Row = Record<string, any>;

export const PORTRAIT_MANUAL_REVIEW_PREVIEW_PATH =
  "/api/admin/portraitAssets/manual-review/preview" as const;
export const PORTRAIT_MANUAL_REVIEW_PREVIEW_GRANT_PATH =
  `${PORTRAIT_MANUAL_REVIEW_PREVIEW_PATH}/grant` as const;
export const PORTRAIT_MANUAL_REVIEW_PREVIEW_GRANT_COOKIE =
  "__Secure-fj_portrait_review_preview" as const;
export const PORTRAIT_MANUAL_REVIEW_PREVIEW_GRANT_TTL_MS = 2 * 60_000;

const GRANT_TYPE = "portrait_manual_review_preview_grant_v1";
const GRANT_VERSION = 1;
const GRANT_RE = /^[A-Za-z0-9_-]{43}$/u;
const HASH_RE = /^[a-f0-9]{64}$/u;
const PLATFORM_ADMIN_ROLES = new Set(["root", "admin", "super_admin"]);

export class PortraitManualReviewPreviewGrantError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status = 401,
    code = "PORTRAIT_REVIEW_PREVIEW_GRANT_INVALID",
    message = "视频预览授权无效或已过期",
  ) {
    super(message);
    this.name = "PortraitManualReviewPreviewGrantError";
    this.status = status;
    this.code = code;
  }
}

function invalidGrant(): never {
  throw new PortraitManualReviewPreviewGrantError();
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function grantHash(rawGrant: string): string {
  return sha256(`portrait-review-preview-grant/v1:${rawGrant}`);
}

function grantSlotId(sessionId: string): string {
  return `portrait-review-preview:${sha256(`session:${sessionId}`)}`;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) invalidGrant();
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidGrant();
    return parsed as Record<string, unknown>;
  } catch {
    return invalidGrant();
  }
}

function safeEqualHash(left: unknown, right: unknown): boolean {
  const a = String(left ?? "").trim().toLowerCase();
  const b = String(right ?? "").trim().toLowerCase();
  if (!HASH_RE.test(a) || !HASH_RE.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function readGrantCookie(req: Request): string {
  const values: string[] = [];
  for (const part of String(req.header("cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== PORTRAIT_MANUAL_REVIEW_PREVIEW_GRANT_COOKIE) continue;
    try {
      values.push(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      invalidGrant();
    }
  }
  // Duplicate cookie names are ambiguous across proxy/browser parsers. Never
  // guess which credential the caller intended us to authenticate.
  if (values.length !== 1 || !GRANT_RE.test(values[0])) invalidGrant();
  return values[0];
}

function cookieOptions(maxAge: number) {
  return {
    secure: true,
    httpOnly: true,
    sameSite: "strict" as const,
    path: PORTRAIT_MANUAL_REVIEW_PREVIEW_PATH,
    maxAge,
  };
}

export function setPortraitManualReviewPreviewPrivateHeaders(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export function clearPortraitManualReviewPreviewGrant(res: Response): void {
  res.clearCookie(
    PORTRAIT_MANUAL_REVIEW_PREVIEW_GRANT_COOKIE,
    cookieOptions(0),
  );
}

export function isPortraitManualReviewPreviewGrantRequest(
  method: unknown,
  path: unknown,
): boolean {
  const normalizedMethod = String(method || "").trim().toUpperCase();
  const normalizedPath = String(path || "").split("?", 1)[0].replace(/\/+$/u, "") || "/";
  return normalizedMethod === "GET"
    && normalizedPath === PORTRAIT_MANUAL_REVIEW_PREVIEW_PATH;
}

export interface PortraitManualReviewPreviewGrantAuth {
  auth: {
    user: Record<string, unknown>;
    session: Row;
    workspaceId: string | null;
    token: "";
  };
  user: Record<string, unknown>;
}

export async function authenticatePortraitManualReviewPreviewGrant(
  database: Knex,
  req: Request,
  timestamp = Date.now(),
): Promise<PortraitManualReviewPreviewGrantAuth> {
  if (!isPortraitManualReviewPreviewGrantRequest(req.method, req.path)) invalidGrant();
  // SameSite is site-scoped, not origin-scoped. Reject a browser request that
  // came from a sibling origin even if that origin shares the registrable
  // domain and would otherwise receive Strict cookies.
  const fetchSite = String(req.header("sec-fetch-site") || "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") invalidGrant();
  const reviewId = typeof req.query?.reviewId === "string"
    ? req.query.reviewId.trim()
    : "";
  if (!reviewId || reviewId.length > 256) invalidGrant();

  const rawGrant = readGrantCookie(req);
  const row = await database<Row>("o_auth_token")
    .where({ tokenHash: grantHash(rawGrant), type: GRANT_TYPE })
    .whereNull("usedAt")
    .first();
  if (!row || Number(row.expiresAt || 0) <= timestamp) invalidGrant();

  const metadata = parseMetadata(row.metadata);
  const actorUserId = Number(metadata.actorUserId || 0);
  const reviewRevision = Number(metadata.reviewRevision || 0);
  const sessionId = String(metadata.sessionId || "").trim();
  const sessionHash = String(metadata.sessionHash || "").trim().toLowerCase();
  let expectedSessionHash = "";
  try {
    expectedSessionHash = portraitManualReviewSessionHashFromId(sessionId);
  } catch {
    invalidGrant();
  }
  if (
    Number(metadata.grantVersion) !== GRANT_VERSION
    || metadata.scope !== "portrait_manual_review_preview"
    || String(metadata.reviewId || "") !== reviewId
    || !Number.isSafeInteger(reviewRevision)
    || reviewRevision < 1
    || !Number.isSafeInteger(actorUserId)
    || actorUserId < 1
    || Number(row.userId || 0) !== actorUserId
    || !sessionId
    || !safeEqualHash(sessionHash, expectedSessionHash)
  ) invalidGrant();

  const storedSession = await database<Row>("o_user_session")
    .where({ id: sessionId, userId: actorUserId })
    .whereNull("revokedAt")
    .first();
  if (!storedSession || Number(storedSession.expiresAt || 0) <= timestamp) invalidGrant();
  let session: Row;
  try {
    session = await enforceSessionPolicy(database, storedSession, timestamp, {
      touch: true,
      revokeExpired: true,
    });
  } catch {
    invalidGrant();
  }

  const [user, review] = await Promise.all([
    database<Row>("o_user").where({ id: actorUserId, status: "active" }).first(),
    database<Row>(PORTRAIT_MANUAL_REVIEW_TABLE).where({
      id: reviewId,
      revision: reviewRevision,
      state: "claimed",
      claimOwnerUserId: actorUserId,
      claimSessionHash: sessionHash,
    }).where("claimLeaseExpiresAt", ">", timestamp).first(),
  ]);
  const role = String(user?.role || "").trim().toLowerCase();
  if (
    !user
    || !PLATFORM_ADMIN_ROLES.has(role)
    || !review
    || String(row.workspaceId || "") !== String(review.workspaceId || "")
    || String(metadata.admissionId || "") !== String(review.admissionId || "")
  ) invalidGrant();

  const workspaceId = String(session.workspaceId || "").trim() || null;
  const authUser = {
    id: actorUserId,
    name: user.name,
    role,
    status: user.status,
    authorizationRevision: Number(user.authorizationRevision || 0),
    workspaceId,
  };
  (req as any).portraitManualReviewPreviewGrant = {
    id: String(row.id),
    reviewId,
    reviewRevision,
    expiresAt: Number(row.expiresAt),
  };
  return {
    auth: { user: authUser, session, workspaceId, token: "" },
    user: authUser,
  };
}

export async function mintPortraitManualReviewPreviewGrant(input: {
  database: Database;
  request: Request;
  response: Response;
  reviewId: string;
  expectedReviewRevision: number;
  now?: number;
}): Promise<{ expiresAt: number }> {
  const timestamp = input.now ?? Date.now();
  const actor = portraitManualReviewActor(input.request);
  const sessionId = String((input.request as any).auth?.session?.id || "").trim();
  const authenticatedSession = (input.request as any).auth?.session || {};
  const sessionHash = portraitManualReviewSessionHash(input.request);
  if (!sessionId) {
    throw new PortraitManualReviewPreviewGrantError(
      401,
      "PORTRAIT_REVIEW_PREVIEW_SESSION_REQUIRED",
      "需要可验证的登录会话",
    );
  }

  const issue = async (trx: Knex.Transaction): Promise<{
    expiresAt: number;
    rawGrant: string;
  }> => {
    const session = await trx<Row>("o_user_session")
      .where({ id: sessionId, userId: actor.userId })
      .whereNull("revokedAt")
      .forUpdate()
      .first();
    const user = await trx<Row>("o_user")
      .where({ id: actor.userId, status: "active" })
      .first();
    if (
      !session
      || !user
      || !PLATFORM_ADMIN_ROLES.has(String(user.role || "").trim().toLowerCase())
      || String(session.tokenHash || "") !== String(authenticatedSession.tokenHash || "")
      || Number(session.expiresAt || 0) <= timestamp
    ) invalidGrant();

    const review = await trx<Row>(PORTRAIT_MANUAL_REVIEW_TABLE)
      .where({ id: input.reviewId })
      .first();
    if (!review) {
      throw new PortraitManualReviewError(404, "portrait_review_not_found", "素材复核不存在");
    }
    if (Number(review.revision) !== input.expectedReviewRevision) {
      throw new PortraitManualReviewError(
        409,
        "portrait_review_revision_conflict",
        "复核状态已更新，请刷新后重试",
      );
    }
    await resolvePortraitManualReviewPreview({
      database: trx,
      reviewId: input.reviewId,
      actorUserId: actor.userId,
      sessionHash,
      now: timestamp,
    });

    const expiresAt = Math.min(
      timestamp + PORTRAIT_MANUAL_REVIEW_PREVIEW_GRANT_TTL_MS,
      Number(review.claimLeaseExpiresAt || 0),
      Number(session.expiresAt || 0),
    );
    if (expiresAt <= timestamp) invalidGrant();

    const rawGrant = crypto.randomBytes(32).toString("base64url");
    const tokenRow = {
      id: grantSlotId(sessionId),
      userId: actor.userId,
      workspaceId: String(review.workspaceId),
      tokenHash: grantHash(rawGrant),
      type: GRANT_TYPE,
      metadata: JSON.stringify({
        grantVersion: GRANT_VERSION,
        scope: "portrait_manual_review_preview",
        reviewId: String(review.id),
        reviewRevision: Number(review.revision),
        admissionId: String(review.admissionId),
        actorUserId: actor.userId,
        sessionId,
        sessionHash,
      }),
      expiresAt,
      usedAt: null,
      createdAt: timestamp,
    };
    await trx<Row>("o_auth_token")
      .insert(tokenRow)
      .onConflict("id")
      .merge(tokenRow);
    await writeAuditLog(input.request, {
      workspaceId: String(review.workspaceId),
      action: "admin.portrait_manual_review.preview_grant",
      resourceType: "portrait_manual_review",
      resourceId: String(review.id),
      required: true,
      metadata: {
        admissionId: String(review.admissionId),
        reviewRevision: Number(review.revision),
        delivery: "native_http_range_cookie_grant",
        expiresAt,
      },
    }, trx);
    return { expiresAt, rawGrant };
  };

  const issued = (input.database as Knex.Transaction).isTransaction
    ? await issue(input.database as Knex.Transaction)
    : await (input.database as Knex).transaction(issue);
  input.response.cookie(
    PORTRAIT_MANUAL_REVIEW_PREVIEW_GRANT_COOKIE,
    issued.rawGrant,
    cookieOptions(Math.max(0, issued.expiresAt - timestamp)),
  );
  return { expiresAt: issued.expiresAt };
}
