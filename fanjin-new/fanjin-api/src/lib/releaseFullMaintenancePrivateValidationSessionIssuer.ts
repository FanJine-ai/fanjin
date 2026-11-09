import { createHash } from "node:crypto";

import jwt from "jsonwebtoken";
import knexFactory, { type Knex } from "knex";
import { v4 as uuid } from "uuid";

import { postgresConnectionFromEnv } from "@/lib/databaseConfig";
import {
  assertReleaseFullMaintenancePrivateValidationBinding,
  releaseFullMaintenancePrivateValidationSha256,
  type ReleaseFullMaintenancePrivateValidationBinding,
  type ReleaseFullMaintenancePrivateValidationProductionConfig,
} from "@/lib/releaseFullMaintenancePrivateValidation";
import {
  assertReleaseFullMaintenancePrivateValidationIntent,
  type ReleaseFullMaintenancePrivateValidationIntent,
  type ReleaseFullMaintenancePrivateValidationIntentPrincipal,
} from "@/lib/releaseFullMaintenancePrivateValidationIntent";
import { platformRoles } from "@/lib/sharedTypes";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";

export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_ISSUER_ROLE =
  "fanjin_release_private_validation_session_issuer" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_AUTHORITY_FORMAT =
  "fanjin-release-full-maintenance-private-validation-session-database-authority/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_REVOCATION_FORMAT =
  "fanjin-release-full-maintenance-private-validation-session-revocation/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_MAX_TTL_MS =
  60 * 60 * 1_000;

const DATABASE_URL_ENV = "FANJIN_RELEASE_PRIVATE_VALIDATION_SESSION_DATABASE_URL";
const SHA256 = /^[a-f0-9]{64}$/u;

type IssuerSession = ReleaseFullMaintenancePrivateValidationProductionConfig["sessions"]["user"];

export type ReleaseFullMaintenancePrivateValidationSessionDatabaseAuthority = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_AUTHORITY_FORMAT;
  role: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_ISSUER_ROLE;
  databaseNameSha256: string;
  verifiedAt: number;
  evidenceSha256: string;
}>;

export type ReleaseFullMaintenancePrivateValidationSessionRevocationReceipt = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_REVOCATION_FORMAT;
  bindingSha256: string;
  sessionIdsSha256: string;
  revokedAt: number;
  evidenceSha256: string;
}>;

export type IssuedReleaseFullMaintenancePrivateValidationSessions = Readonly<{
  sessions: Readonly<{ user: IssuerSession; admin: IssuerSession }>;
  sessionIdsSha256: string;
  revokeAndVerify(): Promise<ReleaseFullMaintenancePrivateValidationSessionRevocationReceipt>;
}>;

type CreateSessionLike = (
  database: Knex,
  user: Record<string, unknown>,
  authInfo?: Readonly<{ userAgent?: string; ip?: string }>,
) => Promise<Record<string, unknown>>;
type RevokeSessionLike = (
  database: Knex,
  rawToken: string,
  sessionId: string,
  userAgent: string,
  expected: Readonly<{
    userId: number;
    workspaceId: string;
    issuedAt: number;
    expiresAt: number;
  }>,
) => Promise<number>;

export class ReleaseFullMaintenancePrivateValidationSessionIssuerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseFullMaintenancePrivateValidationSessionIssuerError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseFullMaintenancePrivateValidationSessionIssuerError(code, message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashAuthToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_INVALID", `${label} is invalid`);
  }
  return Number(value);
}

function safeTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 60_000 || Number(value) > 30 * 60_000) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_INVALID",
      "validation timeout is outside the production contract",
    );
  }
  return Number(value);
}

function exactDatabaseUrl(environment: NodeJS.ProcessEnv): string {
  const raw = String(environment[DATABASE_URL_ENV] || "").trim();
  if (!raw || /[\0\r\n]/u.test(raw)) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_INVALID",
      `${DATABASE_URL_ENV} is required in the protected environment`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_INVALID",
      "session issuer database URL is invalid",
    );
  }
  let username = "";
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    return fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_INVALID",
      "session issuer database username is invalid",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || username !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_ISSUER_ROLE
    || !parsed.password
    || !parsed.hostname
    || !parsed.pathname
    || parsed.pathname === "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || raw === String(environment.DATABASE_URL || "").trim()
    || raw === String(environment.FANJIN_RELEASE_MIGRATION_DATABASE_URL || "").trim()
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_INVALID",
      "session issuer must use its exact independent PostgreSQL login without URL options",
    );
  }
  return raw;
}

export function createReleaseFullMaintenancePrivateValidationSessionDatabase(
  environment: NodeJS.ProcessEnv,
): Knex {
  const databaseUrl = exactDatabaseUrl(environment);
  const connection = postgresConnectionFromEnv({
    DATABASE_URL: databaseUrl,
    FANJIN_DATABASE_SSL: environment.FANJIN_DATABASE_SSL,
    FANJIN_DATABASE_SSL_CA: environment.FANJIN_DATABASE_SSL_CA,
    FANJIN_DATABASE_SSL_CA_FILE: environment.FANJIN_DATABASE_SSL_CA_FILE,
    FANJIN_DATABASE_SSL_REJECT_UNAUTHORIZED:
      environment.FANJIN_DATABASE_SSL_REJECT_UNAUTHORIZED,
  });
  return knexFactory({
    client: "pg",
    connection,
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 30_000,
  });
}

export async function inspectReleaseFullMaintenancePrivateValidationSessionDatabaseAuthority(input: {
  database: Knex;
  now?: number;
}): Promise<ReleaseFullMaintenancePrivateValidationSessionDatabaseAuthority> {
  const now = input.now ?? Date.now();
  const response = await input.database.raw(`
    SELECT
      current_user::text AS current_role,
      current_database()::text AS database_name,
      role.rolsuper AS is_superuser,
      role.rolcreaterole AS can_create_role,
      role.rolcreatedb AS can_create_database,
      role.rolcanlogin AS can_login,
      role.rolreplication AS can_replicate,
      role.rolbypassrls AS can_bypass_rls,
      has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_in_database,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public_schema,
      (
        SELECT count(*)::int
        FROM pg_auth_members membership
        WHERE membership.member = role.oid
      ) AS role_membership_count
    FROM pg_roles role
    WHERE role.rolname = current_user
  `);
  const rows = Array.isArray(response?.rows) ? response.rows : [];
  const row = rows.length === 1 ? rows[0] as Record<string, unknown> : null;
  if (
    !row
    || row.current_role !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_ISSUER_ROLE
    || typeof row.database_name !== "string"
    || !row.database_name
    || row.is_superuser !== false
    || row.can_create_role !== false
    || row.can_create_database !== false
    || row.can_login !== true
    || row.can_replicate !== false
    || row.can_bypass_rls !== false
    || row.can_create_in_database !== false
    || row.can_create_in_public_schema !== false
    || Number(row.role_membership_count) !== 0
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_AUTHORITY_INVALID",
      "session issuer database login is missing or over-privileged",
    );
  }
  const commitment = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_AUTHORITY_FORMAT,
    role: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_ISSUER_ROLE,
    databaseNameSha256: sha256(row.database_name),
    verifiedAt: safeTimestamp(now, "database authority timestamp"),
  };
  return Object.freeze({
    ...commitment,
    evidenceSha256: releaseFullMaintenancePrivateValidationSha256(commitment),
  });
}

function assertDatabaseAuthority(
  value: ReleaseFullMaintenancePrivateValidationSessionDatabaseAuthority,
  now: number,
): void {
  const { evidenceSha256, ...commitment } = value;
  if (
    value.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_AUTHORITY_FORMAT
    || value.role !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_ISSUER_ROLE
    || !SHA256.test(value.databaseNameSha256)
    || !SHA256.test(evidenceSha256)
    || evidenceSha256 !== releaseFullMaintenancePrivateValidationSha256(commitment)
    || !Number.isSafeInteger(value.verifiedAt)
    || value.verifiedAt < now - 5_000
    || value.verifiedAt > now
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_AUTHORITY_INVALID",
    "session issuer database authority proof is stale or invalid",
  );
}

function actualPlatformRole(value: unknown): string | null {
  const role = String(value || "");
  return (platformRoles as readonly string[]).includes(role) ? role : null;
}

function assertPrincipalRows(input: {
  principal: ReleaseFullMaintenancePrivateValidationIntentPrincipal;
  user: Record<string, unknown>;
  workspace: Record<string, unknown>;
  membership: Record<string, unknown>;
  label: string;
}): void {
  const workspaceRole = getConsistentWorkspaceRole({
    userId: input.user.id,
    memberRole: input.membership.role,
    ownerUserId: input.workspace.ownerUserId,
  });
  if (
    Number(input.user.id) !== input.principal.userId
    || input.user.status !== "active"
    || String(input.user.currentWorkspaceId || "") !== input.principal.workspaceId
    || actualPlatformRole(input.user.role) !== input.principal.platformRole
    || input.workspace.id !== input.principal.workspaceId
    || input.workspace.status !== "active"
    || Number(input.membership.userId) !== input.principal.userId
    || input.membership.workspaceId !== input.principal.workspaceId
    || input.membership.status !== "active"
    || workspaceRole !== input.principal.workspaceRole
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_PRINCIPAL_MISMATCH",
    `${input.label} principal differs from the Root-MFA-authorized intent`,
  );
}

function assertTestDependenciesAllowed(input: {
  databaseAuthority?: ReleaseFullMaintenancePrivateValidationSessionDatabaseAuthority;
  createSession?: CreateSessionLike;
  revokeSession?: RevokeSessionLike;
  now?: number;
}): void {
  if (
    (input.databaseAuthority !== undefined
      || input.createSession !== undefined
      || input.revokeSession !== undefined
      || input.now !== undefined)
    && process.env.NODE_ENV !== "test"
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_TEST_OVERRIDE_FORBIDDEN",
    "production session issuance does not accept injected authority, clock or auth functions",
  );
}

async function revokeExactSession(
  database: Knex,
  rawToken: string,
  sessionId: string,
  userAgent: string,
  expected: Readonly<{
    userId: number;
    workspaceId: string;
    issuedAt: number;
    expiresAt: number;
  }>,
): Promise<number> {
  return Number(await database<Record<string, unknown>>("o_user_session")
    .where({
      id: sessionId,
      tokenHash: hashAuthToken(rawToken),
      userAgent,
      userId: expected.userId,
      workspaceId: expected.workspaceId,
      createdAt: expected.issuedAt,
      expiresAt: expected.expiresAt,
    })
    .whereNull("revokedAt")
    .update({ revokedAt: Date.now(), updatedAt: Date.now() }));
}

async function createBoundedJitSession(
  database: Knex,
  user: Record<string, unknown>,
  authInfo: Readonly<{ userAgent?: string; ip?: string }> = {},
): Promise<Record<string, unknown>> {
  const userId = Number(user.id);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_PRINCIPAL_MISMATCH",
      "session principal is invalid",
    );
  }
  const liveUser = await database<Record<string, unknown>>("o_user")
    .where({ id: userId, status: "active" })
    .forUpdate()
    .first();
  const workspaceId = String(liveUser?.currentWorkspaceId || "");
  const tokenKeyRow = await database<Record<string, unknown>>("o_setting")
    .where({ key: "tokenKey" })
    .forShare()
    .first();
  const tokenKey = String(tokenKeyRow?.value || "");
  if (!liveUser || !workspaceId || tokenKey.length < 16) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_INVALID",
      "session principal or existing token key is unavailable",
    );
  }
  const sessionId = uuid();
  const timestamp = Date.now();
  const expiresAt = timestamp
    + RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_MAX_TTL_MS;
  const rawToken = jwt.sign({
    id: userId,
    name: String(liveUser.name || ""),
    role: String(liveUser.role || "member"),
    workspaceId,
    sid: sessionId,
  }, tokenKey, {
    expiresIn: Math.floor(
      RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_MAX_TTL_MS / 1_000,
    ),
  });
  await database<Record<string, unknown>>("o_user_session").insert({
    id: sessionId,
    userId,
    workspaceId,
    tokenHash: hashAuthToken(rawToken),
    userAgent: authInfo.userAgent ?? null,
    ip: authInfo.ip ?? null,
    expiresAt,
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  });
  const updated = await database<Record<string, unknown>>("o_user")
    .where({ id: userId, status: "active" })
    .update({ currentWorkspaceId: workspaceId, lastLoginAt: timestamp, updatedAt: timestamp });
  if (Number(updated) !== 1) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_INVALID",
      "session principal changed while issuing a token",
    );
  }
  return { rawToken, token: `Bearer ${rawToken}`, sessionId };
}

export async function issueReleaseFullMaintenancePrivateValidationSessions(input: {
  database: Knex;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  validationPlanIntent: ReleaseFullMaintenancePrivateValidationIntent;
  validationTimeoutMs: number;
  databaseAuthority?: ReleaseFullMaintenancePrivateValidationSessionDatabaseAuthority;
  createSession?: CreateSessionLike;
  revokeSession?: RevokeSessionLike;
  now?: number;
}): Promise<IssuedReleaseFullMaintenancePrivateValidationSessions> {
  assertTestDependenciesAllowed(input);
  const now = input.now ?? Date.now();
  const timeoutMs = safeTimeout(input.validationTimeoutMs);
  const binding = assertReleaseFullMaintenancePrivateValidationBinding(input.binding, { now });
  const intent = assertReleaseFullMaintenancePrivateValidationIntent(
    input.validationPlanIntent,
    {
      target: binding.target,
      privateApiInventorySha256: binding.privateApiInventorySha256,
      now,
    },
  );
  if (intent.validationPlanIntentSha256 !== binding.validationAuthority.validationPlanIntentSha256) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_AUTHORITY_MISMATCH",
      "session intent differs from the dynamic binding authority",
    );
  }
  const authority = input.databaseAuthority
    ?? await inspectReleaseFullMaintenancePrivateValidationSessionDatabaseAuthority({
      database: input.database,
      now,
    });
  assertDatabaseAuthority(authority, now);

  const sessionCreator = input.createSession ?? createBoundedJitSession;
  const sessionRevoker = input.revokeSession ?? revokeExactSession;
  const principals = [
    ["user", intent.principals.user] as const,
    ["admin", intent.principals.admin] as const,
  ].sort((left, right) => left[1].userId - right[1].userId);
  if (principals[0][1].userId === principals[1][1].userId) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_PRINCIPAL_MISMATCH",
      "validation user and admin must be distinct",
    );
  }
  const userAgent = `fanjin-private-validation/${binding.bindingSha256}`;
  const issued = await input.database.transaction(async (trx) => {
    const userIds = principals.map(([, principal]) => principal.userId);
    const users = await trx<Record<string, unknown>>("o_user")
      .whereIn("id", userIds)
      .orderBy("id", "asc")
      .forUpdate();
    const workspace = await trx<Record<string, unknown>>("o_workspace")
      .where({ id: intent.workspaceId })
      .forShare()
      .first();
    const memberships = await trx<Record<string, unknown>>("o_workspace_member")
      .where({ workspaceId: intent.workspaceId })
      .whereIn("userId", userIds)
      .orderBy("userId", "asc")
      .forShare();
    if (users.length !== 2 || memberships.length !== 2 || !workspace) {
      fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_PRINCIPAL_MISMATCH",
        "validation principals or workspace membership are incomplete",
      );
    }
    for (const [label, principal] of principals) {
      const user = users.find((row) => Number(row.id) === principal.userId);
      const membership = memberships.find((row) => Number(row.userId) === principal.userId);
      if (!user || !membership) {
        fail(
          "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_PRINCIPAL_MISMATCH",
          `${label} principal is missing`,
        );
      }
      assertPrincipalRows({ principal, user, workspace, membership, label });
    }
    const tokenKey = await trx<Record<string, unknown>>("o_setting")
      .where({ key: "tokenKey" })
      .forShare()
      .first();
    if (typeof tokenKey?.value !== "string" || tokenKey.value.length < 16) {
      fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_DATABASE_INVALID",
        "the existing production token key is unavailable",
      );
    }
    const replay = await trx<Record<string, unknown>>("o_user_session")
      .where({ userAgent })
      .first();
    if (replay) {
      fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_REPLAY",
        "this binding already issued private-validation sessions",
      );
    }

    const byLabel = new Map<string, {
      rawToken: string;
      token: string;
      sessionId: string;
      userId: number;
      workspaceId: string;
      issuedAt: number;
      expiresAt: number;
    }>();
    for (const [label, principal] of principals) {
      const user = users.find((row) => Number(row.id) === principal.userId)!;
      const created = await sessionCreator(trx, user, {
        userAgent,
        ip: "127.0.0.1",
      });
      const rawToken = String(created.rawToken || "");
      const token = String(created.token || "");
      const sessionId = String(created.sessionId || "");
      const row = await trx<Record<string, unknown>>("o_user_session")
        .where({ id: sessionId, userId: principal.userId, userAgent })
        .forUpdate()
        .first();
      const issuedAt = safeTimestamp(row?.createdAt, `${label} session issuedAt`);
      const storedExpiresAt = safeTimestamp(row?.expiresAt, `${label} session expiresAt`);
      const expiresAt = Math.min(
        storedExpiresAt,
        now + RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_MAX_TTL_MS,
        binding.validationAuthority.expiresAt,
      );
      if (
        !rawToken
        || token !== `Bearer ${rawToken}`
        || !sessionId
        || issuedAt < binding.requestedAt
        || issuedAt > Date.now() + 5_000
        || expiresAt <= now + timeoutMs
        || expiresAt < intent.expiresAt
      ) fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_INVALID",
        `${label} session is not fresh or cannot cover the authorized validation deadline`,
      );
      const updated = await trx<Record<string, unknown>>("o_user_session")
        .where({ id: sessionId, userId: principal.userId, userAgent })
        .whereNull("revokedAt")
        .update({ expiresAt, updatedAt: now });
      if (Number(updated) !== 1) {
        fail(
          "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_INVALID",
          `${label} session expiry could not be bounded`,
        );
      }
      byLabel.set(label, {
        rawToken,
        token,
        sessionId,
        userId: principal.userId,
        workspaceId: intent.workspaceId,
        issuedAt,
        expiresAt,
      });
    }
    const user = byLabel.get("user")!;
    const admin = byLabel.get("admin")!;
    if (user.rawToken === admin.rawToken || user.token === admin.token || user.sessionId === admin.sessionId) {
      fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_COLLISION",
        "user and admin session credentials are not distinct",
      );
    }
    return { user, admin };
  });

  const sessionIdsSha256 = releaseFullMaintenancePrivateValidationSha256(
    [issued.user.sessionId, issued.admin.sessionId].sort(),
  );
  let revocationReceipt: ReleaseFullMaintenancePrivateValidationSessionRevocationReceipt | undefined;
  const revokeAndVerify = async (): Promise<ReleaseFullMaintenancePrivateValidationSessionRevocationReceipt> => {
    if (revocationReceipt) return revocationReceipt;
    const attempts = await Promise.allSettled([
      sessionRevoker(input.database, issued.user.rawToken, issued.user.sessionId, userAgent, issued.user),
      sessionRevoker(input.database, issued.admin.rawToken, issued.admin.sessionId, userAgent, issued.admin),
    ]);
    const rows = await input.database<Record<string, unknown>>("o_user_session")
      .whereIn("id", [issued.user.sessionId, issued.admin.sessionId])
      .orderBy("id", "asc");
    const cleanupReadbackAt = Date.now();
    const revokedAtValues = rows.map((row) => Number(row.revokedAt));
    const expectedTokenHashBySessionId = new Map([
      [issued.user.sessionId, hashAuthToken(issued.user.rawToken)],
      [issued.admin.sessionId, hashAuthToken(issued.admin.rawToken)],
    ]);
    const expectedSessionById = new Map([
      [issued.user.sessionId, issued.user],
      [issued.admin.sessionId, issued.admin],
    ]);
    if (
      attempts.some((attempt) => (
        attempt.status === "rejected"
        || (attempt.value !== 0 && attempt.value !== 1)
      ))
      || rows.length !== 2
      || rows.some((row) => (
        (() => {
          const sessionId = String(row.id || "");
          const expected = expectedSessionById.get(sessionId);
          return !expected
            || !Number.isSafeInteger(Number(row.revokedAt))
            || Number(row.revokedAt) < Number(row.createdAt)
            || Number(row.revokedAt) > cleanupReadbackAt + 5_000
            || Number(row.userId) !== expected.userId
            || row.workspaceId !== expected.workspaceId
            || Number(row.createdAt) !== expected.issuedAt
            || Number(row.expiresAt) !== expected.expiresAt
            || row.userAgent !== userAgent
            || row.tokenHash !== expectedTokenHashBySessionId.get(sessionId);
        })()
      ))
    ) fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_REVOCATION_FAILED",
      "private-validation sessions were not both revoked in the database",
    );
    const commitment = {
      format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_REVOCATION_FORMAT,
      bindingSha256: binding.bindingSha256,
      sessionIdsSha256,
      revokedAt: Math.max(...revokedAtValues),
    };
    revocationReceipt = Object.freeze({
      ...commitment,
      evidenceSha256: releaseFullMaintenancePrivateValidationSha256(commitment),
    });
    return revocationReceipt;
  };

  return Object.freeze({
    sessions: Object.freeze({
      user: Object.freeze({
        token: issued.user.token,
        issuedAt: issued.user.issuedAt,
        expiresAt: issued.user.expiresAt,
        purpose: "full-maintenance-private-validation" as const,
      }),
      admin: Object.freeze({
        token: issued.admin.token,
        issuedAt: issued.admin.issuedAt,
        expiresAt: issued.admin.expiresAt,
        purpose: "full-maintenance-private-validation" as const,
      }),
    }),
    sessionIdsSha256,
    revokeAndVerify,
  });
}
