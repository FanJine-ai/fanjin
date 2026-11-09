import { createHash, createPublicKey, verify } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { isPostgresClient } from "@/lib/dbDialect";
import { DATABASE_MIGRATIONS } from "@/lib/databaseMigrations";
import { getObjectWriteIntent, objectWriteProviderIdentity, type ObjectWriteIntentRecord } from "@/lib/objectWriteIntent";
import { OBJECT_WRITE_INTENT_TABLE } from "@/lib/migrations/objectWriteIntent";
import { OBJECT_WRITE_ABSENCE_AUDIT_TABLE, OBJECT_WRITE_ABSENCE_FORMAT, OBJECT_WRITE_ABSENCE_MIGRATION_IDENTITY } from "@/lib/migrations/objectWriteAbsenceReconciliation";
import { collectObjectWriteAbsenceReferences, lockObjectWriteAbsenceReferences, OBJECT_WRITE_ABSENCE_REFERENCE_MANIFEST_SHA256 } from "@/lib/objectWriteAbsenceReferences";
import type { ObjectStorageConfiguration } from "@/lib/objectStorageConfig";
import { createObjectWriteAbsenceStorage, type ObjectWriteAbsenceObservation } from "@/lib/objectWriteAbsenceStorage";

export const HISTORICAL_REFERENCE_UPLOAD_INTENT_IDS = Object.freeze([
  "78f99b4e-3f3c-415d-8948-7b11ebbaa0b5", "8a2057a6-1a45-45b1-9518-97f9877ecfe5",
  "76db00b1-cf10-4e4b-8fe8-f4cb9db3d7ce", "53cfd135-a786-4550-9ec0-fb27cf342801",
  "d43eb599-0911-45e4-b345-ad287b136d23", "1fef8a9f-e6e4-419e-b4d6-ae733d449834",
  "828f9d03-78d3-400c-902f-6910985e356e", "38ce7785-d95f-46c3-9c28-5aeb1e652348",
  "9f96bdb7-bbda-471f-b587-c93408598ed7",
].sort());
export const OBJECT_WRITE_ABSENCE_AUTHORIZATION_DOMAIN = "fanjin-object-write-absence-authorization/v1";
const MINIMUM_PRODUCER_SETTLEMENT_MS = 15 * 60_000;
const MAXIMUM_AUTHORIZATION_MS = 5 * 60_000;
const MAXIMUM_PLAN_AGE_MS = 60 * 60_000;
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const boundedText = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/u);
const operation = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/u);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const objectWriteAbsenceBindingSchema = z.object({
  targetId: operation,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  candidateDigest: digest,
  artifactSha256: digest,
  configSha256: digest,
  databaseName: boundedText,
  databaseSchema: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u),
  databaseIdentitySha256: sha,
  schemaVersion: z.literal(54),
}).strict();
export type ObjectWriteAbsenceBinding = z.infer<typeof objectWriteAbsenceBindingSchema>;
const sessionSchema = z.object({
  pid: z.number().int().positive(), backendStartedAt: timestamp,
  databaseRole: boundedText, applicationName: z.string().max(255), clientAddress: boundedText,
}).strict();
const memberSchema = z.object({
  memberId: z.enum(["api-a", "api-b", "worker-a", "worker-b"]),
  instanceId: boundedText, containerId: sha, address: boundedText,
  stoppedAt: timestamp, observedAt: timestamp,
  state: z.literal("stopped"), sourceEvidenceSha256: sha,
}).strict();
const authorizationBodySchema = z.object({
  format: z.literal(OBJECT_WRITE_ABSENCE_AUTHORIZATION_DOMAIN),
  operationId: operation, planSha256: sha,
  binding: objectWriteAbsenceBindingSchema,
  issuedAt: timestamp, expiresAt: timestamp,
  quiescence: z.object({
    members: z.array(memberSchema).length(4),
    allowedDatabaseSessions: z.array(sessionSchema).max(64),
    maintenanceEvidenceSha256: sha,
  }).strict(),
}).strict();
export const objectWriteAbsenceAuthorizationSchema = z.object({
  body: authorizationBodySchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
}).strict();
export type ObjectWriteAbsenceAuthorization = z.infer<typeof objectWriteAbsenceAuthorizationSchema>;

export interface ObjectWriteAbsencePlan {
  format: "object-write-absence-plan.v1";
  operationId: string;
  binding: ObjectWriteAbsenceBinding;
  createdAt: number;
  intentIds: readonly string[];
  rows: ObjectWriteIntentRecord[];
  rowsSha256: string;
  referenceManifestSha256: string;
  referenceScan: Awaited<ReturnType<typeof collectObjectWriteAbsenceReferences>>;
}
export interface ObjectWriteAbsenceReceipt {
  format: "object-write-absence-batch-receipt.v1";
  operationId: string;
  planSha256: string;
  authorizationSha256: string;
  binding: ObjectWriteAbsenceBinding;
  intentIds: readonly string[];
  beforeRowsSha256: string;
  afterRowsSha256: string;
  evidenceSha256: string;
  completedAt: number;
  databaseRowsChanged: 9;
  objectStorageWrites: 0;
}
export interface ObjectWriteAbsenceRuntime {
  database: Knex;
  configuration: ObjectStorageConfiguration;
  binding: ObjectWriteAbsenceBinding;
  clock?: () => number;
  // Dependency injection is programmatic only. The production CLI creates
  // the LIST/HEAD-only adapter itself and accepts no observation JSON.
  storage?: { observe(intent: { id: string; objectKey: string }): Promise<ObjectWriteAbsenceObservation> };
}

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function check(condition: unknown, code: string): asserts condition { if (!condition) fail(code); }
export function objectWriteAbsenceCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail("OBJECT_WRITE_ABSENCE_JSON_INVALID");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(objectWriteAbsenceCanonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${objectWriteAbsenceCanonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export const objectWriteAbsenceSha256 = (value: unknown): string => createHash("sha256").update(objectWriteAbsenceCanonicalJson(value)).digest("hex");
export const objectWriteAbsenceAuthorizationBytes = (body: ObjectWriteAbsenceAuthorization["body"]): Buffer =>
  Buffer.from(`${OBJECT_WRITE_ABSENCE_AUTHORIZATION_DOMAIN}\n${objectWriteAbsenceCanonicalJson(body)}`, "utf8");

function exactIntentSet(ids: readonly string[]): void {
  check(Array.isArray(ids) && ids.length === 9 && new Set(ids).size === 9
    && objectWriteAbsenceCanonicalJson([...ids].sort()) === objectWriteAbsenceCanonicalJson(HISTORICAL_REFERENCE_UPLOAD_INTENT_IDS),
  "OBJECT_WRITE_ABSENCE_INTENT_SET_MISMATCH");
}
function validateOriginalRows(rows: ObjectWriteIntentRecord[], configuration: ObjectStorageConfiguration): void {
  exactIntentSet(rows.map((row) => row.id));
  const provider = objectWriteProviderIdentity(configuration);
  check(configuration.provider !== "local", "OBJECT_WRITE_ABSENCE_REMOTE_REQUIRED");
  for (const row of rows) {
    check(row.status === "compensation_pending" && row.errorCode === "OBJECT_WRITE_PUT_OUTCOME_UNCERTAIN"
      && row.purpose === "direct_upload" && [143, 144].includes(row.projectId)
      && row.objectKey === `${row.projectId}/assets/references/${row.id}.png`
      && row.providerFingerprint === provider.providerFingerprint,
    "OBJECT_WRITE_ABSENCE_ROW_NOT_ELIGIBLE");
    for (const field of ["writeReceiptJson", "writeReceiptHash", "putCompletedAt", "referenceJson", "referenceHash", "committedAt",
      "compensationEvidenceJson", "compensationEvidenceHash", "compensatedAt", "leaseOwner", "leaseExpiresAt"] as const) {
      check(row[field] === null, "OBJECT_WRITE_ABSENCE_ROW_NOT_ELIGIBLE");
    }
  }
}
async function assertDatabaseBinding(trx: Knex.Transaction, binding: ObjectWriteAbsenceBinding): Promise<void> {
  const identity = (await trx.raw("SELECT current_database() AS name, current_schema() AS schema")).rows[0];
  check(identity.name === binding.databaseName && identity.schema === binding.databaseSchema, "OBJECT_WRITE_ABSENCE_DATABASE_MISMATCH");
  const rows = await trx("o_schema_migration").select("version", "name", "checksum").orderBy("version");
  check(rows.length === OBJECT_WRITE_ABSENCE_MIGRATION_IDENTITY.version && rows.length === DATABASE_MIGRATIONS.length
    && rows.every((row, index) => Number(row.version) === index + 1
      && row.name === DATABASE_MIGRATIONS[index].name && row.checksum === DATABASE_MIGRATIONS[index].checksum),
  "OBJECT_WRITE_ABSENCE_SCHEMA_MISMATCH");
}
async function lockAndRead(trx: Knex.Transaction): Promise<ObjectWriteIntentRecord[]> {
  await trx.raw("SET LOCAL lock_timeout = '5s'");
  await trx.raw("SET LOCAL statement_timeout = '20s'");
  await trx.raw("SET LOCAL idle_in_transaction_session_timeout = '30s'");
  await trx.raw("SELECT pg_advisory_xact_lock(hashtext('fanjin-object-write-absence-reconciliation-v1'))");
  const keys = await trx(OBJECT_WRITE_INTENT_TABLE).select("id", "projectId")
    .whereIn("id", [...HISTORICAL_REFERENCE_UPLOAD_INTENT_IDS]).orderBy("id").forUpdate();
  exactIntentSet(keys.map((row) => row.id));
  const projects = await trx("o_project").select("id").whereIn("id", [143, 144]).orderBy("id").forUpdate();
  check(projects.length === 2 && Number(projects[0].id) === 143 && Number(projects[1].id) === 144,
    "OBJECT_WRITE_ABSENCE_PROJECT_MISSING");
  await lockObjectWriteAbsenceReferences(trx);
  const rows: ObjectWriteIntentRecord[] = [];
  for (const id of HISTORICAL_REFERENCE_UPLOAD_INTENT_IDS) {
    const row = await getObjectWriteIntent(id, { database: trx });
    check(row, "OBJECT_WRITE_ABSENCE_INTENT_MISSING");
    rows.push(row);
  }
  return rows;
}
function validateRuntime(runtime: ObjectWriteAbsenceRuntime): void {
  check(isPostgresClient(runtime.database), "OBJECT_WRITE_ABSENCE_POSTGRES_REQUIRED");
  check(objectWriteAbsenceBindingSchema.safeParse(runtime.binding).success, "OBJECT_WRITE_ABSENCE_BINDING_INVALID");
}

/** A data-read-only planning transaction; table locks prevent an incomplete
 * reference snapshot. It neither observes nor mutates provider objects. */
export async function prepareObjectWriteAbsencePlan(operationId: string, runtime: ObjectWriteAbsenceRuntime): Promise<ObjectWriteAbsencePlan> {
  validateRuntime(runtime);
  check(operation.safeParse(operationId).success, "OBJECT_WRITE_ABSENCE_OPERATION_ID_INVALID");
  return runtime.database.transaction(async (trx) => {
    await assertDatabaseBinding(trx, runtime.binding);
    const rows = await lockAndRead(trx);
    validateOriginalRows(rows, runtime.configuration);
    const referenceScan = await collectObjectWriteAbsenceReferences(trx, rows);
    return {
      format: "object-write-absence-plan.v1", operationId, binding: runtime.binding,
      createdAt: (runtime.clock ?? Date.now)(), intentIds: [...HISTORICAL_REFERENCE_UPLOAD_INTENT_IDS],
      rows, rowsSha256: objectWriteAbsenceSha256(rows),
      referenceManifestSha256: OBJECT_WRITE_ABSENCE_REFERENCE_MANIFEST_SHA256, referenceScan,
    };
  }, { isolationLevel: "read committed" });
}

function validatePlan(plan: ObjectWriteAbsencePlan, runtime: ObjectWriteAbsenceRuntime): void {
  check(plan?.format === "object-write-absence-plan.v1" && operation.safeParse(plan.operationId).success
    && timestamp.safeParse(plan.createdAt).success, "OBJECT_WRITE_ABSENCE_PLAN_INVALID");
  exactIntentSet(plan.intentIds);
  check(objectWriteAbsenceSha256(plan.binding) === objectWriteAbsenceSha256(runtime.binding)
    && plan.rowsSha256 === objectWriteAbsenceSha256(plan.rows)
    && plan.referenceManifestSha256 === OBJECT_WRITE_ABSENCE_REFERENCE_MANIFEST_SHA256,
  "OBJECT_WRITE_ABSENCE_PLAN_MISMATCH");
  validateOriginalRows(plan.rows, runtime.configuration);
}
function parseAuthorization(input: unknown, publicKeyPem: string, plan: ObjectWriteAbsencePlan): ObjectWriteAbsenceAuthorization {
  const parsed = objectWriteAbsenceAuthorizationSchema.safeParse(input);
  check(parsed.success, "OBJECT_WRITE_ABSENCE_AUTHORIZATION_INVALID");
  const authorization = parsed.data;
  let valid = false;
  try {
    const key = createPublicKey(publicKeyPem);
    valid = key.asymmetricKeyType === "ed25519"
      && verify(null, objectWriteAbsenceAuthorizationBytes(authorization.body), key, Buffer.from(authorization.signature, "base64"));
  } catch { /* Fail without exposing key or provider material. */ }
  check(valid, "OBJECT_WRITE_ABSENCE_AUTHORIZATION_SIGNATURE_INVALID");
  check(authorization.body.planSha256 === objectWriteAbsenceSha256(plan)
    && authorization.body.operationId === plan.operationId
    && objectWriteAbsenceSha256(authorization.body.binding) === objectWriteAbsenceSha256(plan.binding),
  "OBJECT_WRITE_ABSENCE_AUTHORIZATION_MISMATCH");
  return authorization;
}
function assertFreshAuthorization(authorization: ObjectWriteAbsenceAuthorization, plan: ObjectWriteAbsencePlan, now: number): void {
  const body = authorization.body;
  check(body.issuedAt <= now && body.expiresAt > now && body.expiresAt > body.issuedAt
    && body.expiresAt - body.issuedAt <= MAXIMUM_AUTHORIZATION_MS
    && plan.createdAt <= body.issuedAt && now - plan.createdAt <= MAXIMUM_PLAN_AGE_MS,
  "OBJECT_WRITE_ABSENCE_AUTHORIZATION_EXPIRED");
  const members = body.quiescence.members;
  check(new Set(members.map((member) => member.memberId)).size === 4
    && new Set(members.map((member) => member.instanceId)).size === 4
    && new Set(members.map((member) => member.containerId)).size === 4,
  "OBJECT_WRITE_ABSENCE_QUIESCENCE_INVALID");
  for (const member of members) {
    check(member.observedAt <= body.issuedAt && body.issuedAt - member.observedAt <= 60_000
      && member.stoppedAt <= member.observedAt - MINIMUM_PRODUCER_SETTLEMENT_MS,
    "OBJECT_WRITE_ABSENCE_PRODUCER_NOT_SETTLED");
  }
}
async function assertNoNewWriters(trx: Knex.Transaction, authorization: ObjectWriteAbsenceAuthorization): Promise<void> {
  const rows = (await trx.raw(`SELECT pid, usename AS "databaseRole", application_name AS "applicationName",
    COALESCE(client_addr::text, 'local') AS "clientAddress",
    floor(extract(epoch FROM backend_start) * 1000)::bigint AS "backendStartedAt"
    FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()`)).rows;
  check(rows.length <= 64, "OBJECT_WRITE_ABSENCE_WRITER_PRESENT");
  const blockedAddresses = new Set(authorization.body.quiescence.members.map((member) => member.address));
  const allowed = new Set(authorization.body.quiescence.allowedDatabaseSessions.map(objectWriteAbsenceSha256));
  for (const raw of rows) {
    const row = { ...raw, pid: Number(raw.pid), backendStartedAt: Number(raw.backendStartedAt) };
    check(sessionSchema.safeParse(row).success && !blockedAddresses.has(row.clientAddress)
      && allowed.has(objectWriteAbsenceSha256(row)), "OBJECT_WRITE_ABSENCE_WRITER_PRESENT");
  }
}
function assertAbsenceObservation(observation: ObjectWriteAbsenceObservation, row: ObjectWriteIntentRecord, startedAt: number, now: number): void {
  check(observation.intentId === row.id && observation.bucket === row.bucket
    && observation.key === [row.keyPrefix, row.objectKey].filter(Boolean).join("/")
    && observation.startedAt >= startedAt && observation.completedAt >= observation.startedAt
    && observation.completedAt <= now && now - observation.completedAt <= 60_000,
  "OBJECT_WRITE_ABSENCE_OBSERVATION_MISMATCH");
  check(observation.pages.length > 0 && observation.pages.length <= 10
    && observation.pages.at(-1)?.isTruncated === false
    && observation.head.httpStatus === 404 && /^[\x21-\x7e]{1,512}$/u.test(observation.head.requestId),
  "OBJECT_WRITE_ABSENCE_OBSERVATION_INCOMPLETE");
  const markers = new Set<string>();
  for (const [index, page] of observation.pages.entries()) {
    check(page.exactVersions === 0 && page.exactDeleteMarkers === 0
      && /^[\x21-\x7e]{1,512}$/u.test(page.requestId) && sha.safeParse(page.responseSha256).success,
    "OBJECT_WRITE_ABSENCE_OBSERVATION_INCOMPLETE");
    const previous = observation.pages[index - 1];
    check(index === 0 ? page.keyMarker === null && page.versionIdMarker === null
      : previous.isTruncated === true && page.keyMarker === previous.nextKeyMarker
        && page.versionIdMarker === previous.nextVersionIdMarker,
    "OBJECT_WRITE_ABSENCE_OBSERVATION_INCOMPLETE");
    const marker = `${page.keyMarker}\0${page.versionIdMarker}`;
    check(!markers.has(marker), "OBJECT_WRITE_ABSENCE_OBSERVATION_INCOMPLETE");
    markers.add(marker);
  }
}

async function verifiedRecordedReceipt(trx: Knex.Transaction, previous: Record<string, unknown>, runtime: ObjectWriteAbsenceRuntime): Promise<ObjectWriteAbsenceReceipt> {
  try {
    const receipt = JSON.parse(String(previous.receiptJson)) as ObjectWriteAbsenceReceipt;
    const before = JSON.parse(String(previous.beforeRowsJson));
    const after = JSON.parse(String(previous.afterRowsJson));
    const evidence = JSON.parse(String(previous.evidenceJson));
    const plan = JSON.parse(String(previous.planJson));
    const authorization = JSON.parse(String(previous.authorizationJson));
    exactIntentSet(receipt.intentIds);
    check(receipt.format === "object-write-absence-batch-receipt.v1" && receipt.operationId === previous.operationId
      && objectWriteAbsenceSha256(receipt) === previous.receiptSha256
      && objectWriteAbsenceSha256(receipt.binding) === objectWriteAbsenceSha256(runtime.binding)
      && receipt.beforeRowsSha256 === objectWriteAbsenceSha256(before)
      && receipt.afterRowsSha256 === objectWriteAbsenceSha256(after)
      && receipt.evidenceSha256 === objectWriteAbsenceSha256(evidence)
      && receipt.planSha256 === objectWriteAbsenceSha256(plan)
      && receipt.authorizationSha256 === objectWriteAbsenceSha256(authorization)
      && previous.requestSha256 === objectWriteAbsenceSha256({ plan, authorization }), "OBJECT_WRITE_ABSENCE_AUDIT_CORRUPT");
    const current = [];
    for (const id of HISTORICAL_REFERENCE_UPLOAD_INTENT_IDS) current.push(await getObjectWriteIntent(id, { database: trx }));
    check(objectWriteAbsenceSha256(current) === receipt.afterRowsSha256, "OBJECT_WRITE_ABSENCE_TERMINAL_STATE_MISMATCH");
    return receipt;
  } catch (error) {
    if (typeof (error as { code?: unknown })?.code === "string") throw error;
    return fail("OBJECT_WRITE_ABSENCE_AUDIT_CORRUPT");
  }
}

/** Query an uncertain COMMIT by its original operation ID, without renewing
 * authority or issuing another mutation/provider call. */
export async function inspectObjectWriteAbsenceOperation(operationId: string, runtime: ObjectWriteAbsenceRuntime): Promise<ObjectWriteAbsenceReceipt | null> {
  validateRuntime(runtime);
  check(operation.safeParse(operationId).success, "OBJECT_WRITE_ABSENCE_OPERATION_ID_INVALID");
  return runtime.database.transaction(async trx => {
    await assertDatabaseBinding(trx, runtime.binding);
    const row = await trx(OBJECT_WRITE_ABSENCE_AUDIT_TABLE).where({ operationId }).first();
    return row ? verifiedRecordedReceipt(trx, row, runtime) : null;
  }, { isolationLevel: "repeatable read", readOnly: true });
}

/** Exactly nine rows plus one immutable audit are committed atomically. A
 * retry uses the SAME signed operation; changed bodies never renew authority. */
export async function applyObjectWriteAbsencePlan(input: {
  plan: ObjectWriteAbsencePlan; authorization: unknown; trustedPublicKeyPem: string;
}, runtime: ObjectWriteAbsenceRuntime): Promise<ObjectWriteAbsenceReceipt> {
  validateRuntime(runtime);
  validatePlan(input.plan, runtime);
  const authorization = parseAuthorization(input.authorization, input.trustedPublicKeyPem, input.plan);
  const requestSha256 = objectWriteAbsenceSha256({ plan: input.plan, authorization });
  const clock = runtime.clock ?? Date.now;
  const ownedStorage = runtime.storage ? null : createObjectWriteAbsenceStorage(runtime.configuration);
  const storage = runtime.storage ?? ownedStorage!;
  try {
    return await runtime.database.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '5s'");
      await trx.raw("SELECT pg_advisory_xact_lock(hashtext('fanjin-object-write-absence-reconciliation-v1'))");
      await assertDatabaseBinding(trx, runtime.binding);
      const previous = await trx(OBJECT_WRITE_ABSENCE_AUDIT_TABLE).where({ operationId: input.plan.operationId }).first();
      if (previous) {
        check(previous.requestSha256 === requestSha256, "OBJECT_WRITE_ABSENCE_OPERATION_CONFLICT");
        return verifiedRecordedReceipt(trx, previous, runtime);
      }
      assertFreshAuthorization(authorization, input.plan, clock());
      const before = await lockAndRead(trx);
      validateOriginalRows(before, runtime.configuration);
      check(objectWriteAbsenceSha256(before) === input.plan.rowsSha256, "OBJECT_WRITE_ABSENCE_PRESTATE_CHANGED");
      await assertNoNewWriters(trx, authorization);
      const referenceScan = await collectObjectWriteAbsenceReferences(trx, before);
      const startedAt = clock();
      const observations: ObjectWriteAbsenceObservation[] = [];
      // Concurrent reads shorten the period for which reference writes are
      // blocked. There are exactly eighteen SDK reads for the empty one-page case.
      const observed = await Promise.all(before.map((row) => storage.observe(row)));
      for (const [index, item] of observed.entries()) {
        assertAbsenceObservation(item, before[index], startedAt, clock());
        observations.push(item);
      }
      assertFreshAuthorization(authorization, input.plan, clock());
      await assertNoNewWriters(trx, authorization);
      await collectObjectWriteAbsenceReferences(trx, before);
      const completedAt = clock();
      const evidence = { referenceScan, observations, quiescence: authorization.body.quiescence };
      const evidenceSha256 = objectWriteAbsenceSha256(evidence);
      const planSha256 = objectWriteAbsenceSha256(input.plan);
      const authorizationSha256 = objectWriteAbsenceSha256(authorization);
      const after = before.map((row) => {
        const compensation = {
          format: OBJECT_WRITE_ABSENCE_FORMAT, mode: "remote_now_absent_no_put_claim",
          intentId: row.id, objectKey: row.objectKey, providerFingerprint: row.providerFingerprint,
          operationId: input.plan.operationId, planSha256, authorizationSha256, evidenceSha256, compensatedAt: completedAt,
        };
        return { ...row, status: "compensated" as const,
          compensationEvidenceJson: objectWriteAbsenceCanonicalJson(compensation),
          compensationEvidenceHash: objectWriteAbsenceSha256(compensation),
          compensatedAt: completedAt, updatedAt: completedAt };
      });
      const receipt: ObjectWriteAbsenceReceipt = {
        format: "object-write-absence-batch-receipt.v1", operationId: input.plan.operationId,
        planSha256, authorizationSha256, binding: runtime.binding, intentIds: [...HISTORICAL_REFERENCE_UPLOAD_INTENT_IDS],
        beforeRowsSha256: objectWriteAbsenceSha256(before), afterRowsSha256: objectWriteAbsenceSha256(after),
        evidenceSha256, completedAt, databaseRowsChanged: 9, objectStorageWrites: 0,
      };
      await trx(OBJECT_WRITE_ABSENCE_AUDIT_TABLE).insert({
        operationId: receipt.operationId, requestSha256,
        planJson: objectWriteAbsenceCanonicalJson(input.plan), authorizationJson: objectWriteAbsenceCanonicalJson(authorization),
        beforeRowsJson: objectWriteAbsenceCanonicalJson(before), afterRowsJson: objectWriteAbsenceCanonicalJson(after),
        evidenceJson: objectWriteAbsenceCanonicalJson(evidence), receiptJson: objectWriteAbsenceCanonicalJson(receipt),
        receiptSha256: objectWriteAbsenceSha256(receipt), completedAt,
      });
      for (const row of after) {
        const changed = await trx(OBJECT_WRITE_INTENT_TABLE).where({ id: row.id, status: "compensation_pending" }).update({
          status: row.status, compensationEvidenceJson: row.compensationEvidenceJson,
          compensationEvidenceHash: row.compensationEvidenceHash, compensatedAt: row.compensatedAt, updatedAt: row.updatedAt,
        });
        check(changed === 1, "OBJECT_WRITE_ABSENCE_ATOMIC_UPDATE_FAILED");
      }
      return receipt;
    }, { isolationLevel: "read committed" });
  } finally { ownedStorage?.destroy(); }
}
