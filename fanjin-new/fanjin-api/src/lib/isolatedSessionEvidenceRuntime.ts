import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_EXACT_VALUES,
  CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_KEYS,
} from "@/lib/candidateRuntimeAttestation";
import {
  IsolatedSessionQuickCreateBodyContractError,
  assertQuickCreateEmptyDraftBodyContract,
  buildQuickCreateEmptyDraftExemplar,
  createQuickCreateEmptyDraftMatcher,
  quickCreateEmptyDraftBodyContractBinding,
  quickCreateEmptyDraftProfileBinding,
  type IsolatedSessionRequestBodyContract,
  type QuickCreateEmptyDraftBodyContract,
} from "@/lib/isolatedSessionQuickCreateBodyContract";

export const ISOLATED_SESSION_EVIDENCE_MODE_ENV =
  "FANJIN_ISOLATED_SESSION_EVIDENCE_MODE" as const;
export const ISOLATED_SESSION_EVIDENCE_SEQUENCE_HEADER =
  "x-fanjin-isolated-evidence-sequence" as const;
export const ISOLATED_SESSION_EVIDENCE_REQUEST_LEDGER_VERSION =
  "fanjin-isolated-session-evidence-request-ledger/v1" as const;
export const ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_VERSION =
  "fanjin-isolated-session-evidence-runtime-config/v1" as const;

const BINDING = /^sha256:[a-f0-9]{64}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const RUN_NONCE = /^[A-Za-z0-9_-]{43}$/u;
const SECRET_KEY = /^(?:api[-_]?key|authorization|cookie|credential|password|secret|token)$/iu;
const REQUEST_METHODS = new Set(["GET", "POST", "PUT"]);
const REQUEST_CLASSES = new Set([
  "READ",
  "READ_ONLY_POST",
  "SESSION_ENSURE",
  "SESSION_CAS",
]);

export class IsolatedSessionEvidenceRuntimeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "IsolatedSessionEvidenceRuntimeError";
  }
}

function fail(code: string): never {
  throw new IsolatedSessionEvidenceRuntimeError(code);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 30) fail("ISOLATED_SESSION_EVIDENCE_VALUE_INVALID");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("ISOLATED_SESSION_EVIDENCE_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 20_000) fail("ISOLATED_SESSION_EVIDENCE_VALUE_INVALID");
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("ISOLATED_SESSION_EVIDENCE_VALUE_INVALID");
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (
      entries.length > 500
      || entries.some(([key, item]) => (
        key.length > 200
        || SECRET_KEY.test(key)
        || ["__proto__", "constructor", "prototype"].includes(key)
        || item === undefined
      ))
    ) fail("ISOLATED_SESSION_EVIDENCE_VALUE_INVALID");
    return `{${entries
      .sort(([left], [right]) => compare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`)
      .join(",")}}`;
  }
  return fail("ISOLATED_SESSION_EVIDENCE_VALUE_INVALID");
}

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function binding(domain: string, value: unknown): string {
  return `sha256:${sha256(canonicalJson({ domain, value }))}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort(compare).join("\0")
    === [...keys].sort(compare).join("\0");
}

function exactOwnedDirectory(value: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    return fail("ISOLATED_SESSION_EVIDENCE_DATA_DIR_INVALID");
  }
  let canonical: string;
  let stat: fs.Stats;
  try {
    canonical = fs.realpathSync(value);
    stat = fs.lstatSync(value);
  } catch {
    return fail("ISOLATED_SESSION_EVIDENCE_DATA_DIR_INVALID");
  }
  if (
    canonical !== value
    || stat.isSymbolicLink()
    || !stat.isDirectory()
    || (stat.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) return fail("ISOLATED_SESSION_EVIDENCE_DATA_DIR_INVALID");
  return canonical;
}

export const ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_EXACT_VALUES = Object.freeze({
  ...CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_EXACT_VALUES,
  // The isolated API is production-shaped but is consumed by the separately
  // supervised loopback Vite origin. The previous browser route fulfilled
  // responses with synthetic CORS headers; the real-loopback cutover must let
  // the API itself authorize only local browser origins instead.
  FANJIN_ALLOW_LOCAL_CORS: "1",
  FANJIN_READONLY_EVIDENCE_MODE: "0",
  FANJIN_SQLITE_READONLY: "0",
  [ISOLATED_SESSION_EVIDENCE_MODE_ENV]: "1",
} as const);

export const ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_KEYS = Object.freeze([
  ...CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_KEYS,
  "FANJIN_ALLOW_LOCAL_CORS",
  ISOLATED_SESSION_EVIDENCE_MODE_ENV,
].sort(compare));

export type IsolatedSessionEvidenceRuntimeEnvironmentProfile = Readonly<{
  canonicalDataDir: string;
  databaseFile: string;
  variables: Readonly<Record<string, string>>;
  binding: string;
}>;

export function buildIsolatedSessionEvidenceRuntimeEnvironment(
  dataDir: string,
): NodeJS.ProcessEnv {
  const canonicalDataDir = exactOwnedDirectory(dataDir);
  const temporaryDirectory = fs.realpathSync(os.tmpdir());
  const macOsEncoding = /^0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+$/u.test(
    String(process.env.__CF_USER_TEXT_ENCODING || ""),
  )
    ? String(process.env.__CF_USER_TEXT_ENCODING)
    : "0x0:0x0:0x0";
  return Object.freeze({
    ...ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_EXACT_VALUES,
    FANJIN_DATA_DIR: canonicalDataDir,
    TMPDIR: temporaryDirectory,
    __CF_USER_TEXT_ENCODING: macOsEncoding,
  });
}

export function inspectIsolatedSessionEvidenceRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  expected?: Readonly<{ dataDir: string; databaseDev: number; databaseIno: number }>,
): IsolatedSessionEvidenceRuntimeEnvironmentProfile {
  if (!exactKeys(
    environment as Record<string, unknown>,
    ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_KEYS,
  )) return fail("ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_INVALID");
  const canonicalDataDir = exactOwnedDirectory(String(environment.FANJIN_DATA_DIR || ""));
  if (
    expected
    && fs.realpathSync(expected.dataDir) !== canonicalDataDir
  ) return fail("ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_INVALID");
  for (const [key, value] of Object.entries(
    ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_EXACT_VALUES,
  )) {
    if (environment[key] !== value) {
      return fail("ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_INVALID");
    }
  }
  const temporaryDirectory = String(environment.TMPDIR || "");
  try {
    if (
      !path.isAbsolute(temporaryDirectory)
      || path.normalize(temporaryDirectory) !== temporaryDirectory
      || fs.realpathSync(temporaryDirectory) !== temporaryDirectory
    ) return fail("ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_INVALID");
  } catch (error) {
    if (error instanceof IsolatedSessionEvidenceRuntimeError) throw error;
    return fail("ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_INVALID");
  }
  if (
    process.platform === "darwin"
    && !/^0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+$/u.test(
      String(environment.__CF_USER_TEXT_ENCODING || ""),
    )
  ) return fail("ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_INVALID");
  const databaseFile = path.join(canonicalDataDir, "db2.sqlite");
  let stat: fs.Stats;
  try {
    const pathStat = fs.lstatSync(databaseFile);
    stat = fs.statSync(databaseFile);
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || !stat.isFile()
      || pathStat.dev !== stat.dev
      || pathStat.ino !== stat.ino
      || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (
        expected
        && (stat.dev !== expected.databaseDev || stat.ino !== expected.databaseIno)
      )
    ) return fail("ISOLATED_SESSION_EVIDENCE_DATABASE_IDENTITY_INVALID");
  } catch (error) {
    if (error instanceof IsolatedSessionEvidenceRuntimeError) throw error;
    return fail("ISOLATED_SESSION_EVIDENCE_DATABASE_IDENTITY_INVALID");
  }
  const variables = Object.freeze(Object.fromEntries(
    ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_KEYS.map((key) => [
      key,
      String(environment[key] ?? ""),
    ]),
  ));
  return Object.freeze({
    canonicalDataDir,
    databaseFile,
    variables,
    binding: binding(
      `${ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_VERSION}/environment`,
      { variables, databaseDev: stat.dev, databaseIno: stat.ino },
    ),
  });
}

export function isIsolatedSessionEvidenceMode(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = String(environment[ISOLATED_SESSION_EVIDENCE_MODE_ENV] || "").trim();
  if (!raw || raw === "0") return false;
  if (raw === "1") return true;
  return fail("ISOLATED_SESSION_EVIDENCE_MODE_INVALID");
}

export type IsolatedSessionEvidenceRequestClass =
  | "READ"
  | "READ_ONLY_POST"
  | "SESSION_ENSURE"
  | "SESSION_CAS";

export type IsolatedSessionEvidencePlanEntry = Readonly<{
  key: string;
  requestClass: IsolatedSessionEvidenceRequestClass;
  contractId: string;
  method: "GET" | "POST" | "PUT";
  normalizedTarget: string;
  canonicalBody: string;
  bodyContract: IsolatedSessionRequestBodyContract;
  minOccurrences: number;
  maxOccurrences: number;
}>;

export type IsolatedSessionEvidenceRuntimeConfig = Readonly<{
  version: typeof ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_VERSION;
  viewportId: "R1" | "R2";
  launchBinding: string;
  apiBaseUrl: string;
  planSha256: string;
  runtimePolicyBinding: string;
  runNonce: string;
  database: Readonly<{
    directory: string;
    file: string;
    dev: number;
    ino: number;
  }>;
  requestEntries: readonly IsolatedSessionEvidencePlanEntry[];
}>;

export type IsolatedSessionEvidenceRequestLedgerRecord = Readonly<{
  sequence: number;
  planEntryKey: string;
  requestClass: IsolatedSessionEvidenceRequestClass;
  method: "GET" | "POST" | "PUT";
  normalizedTarget: string;
  canonicalBody: string;
  bodyContractBinding: string;
  bodyInstanceBinding: string;
  capturedDraftBinding: string | null;
  responseStatus: number;
}>;

export type IsolatedSessionEvidenceRequestLedger = Readonly<{
  version: typeof ISOLATED_SESSION_EVIDENCE_REQUEST_LEDGER_VERSION;
  runtimeConfigBinding: string;
  apiProcessBinding: string;
  launchBinding: string;
  viewportId: "R1" | "R2";
  planSha256: string;
  runtimePolicyBinding: string;
  runNonceBinding: string;
  databaseDev: number;
  databaseIno: number;
  records: readonly IsolatedSessionEvidenceRequestLedgerRecord[];
  acceptedRequestCount: number;
  completedRequestCount: number;
  preflightRequestCount: number;
  blockedRequestCount: number;
  activeRequestCount: 0;
  complete: true;
  ledgerBinding: string;
}>;

function normalizeRequestTarget(value: unknown): string {
  const raw = String(value || "");
  if (
    !raw.startsWith("/api/")
    || raw.length > 8_192
    || /[\\\0\r\n]/u.test(raw)
    || /%(?:2e|2f|5c)/iu.test(raw)
  ) return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_TARGET_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(raw, "http://127.0.0.1");
  } catch {
    return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_TARGET_INVALID");
  }
  if (parsed.origin !== "http://127.0.0.1" || parsed.hash) {
    return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_TARGET_INVALID");
  }
  const query: Record<string, string> = {};
  for (const [key, item] of parsed.searchParams) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key)
      || Object.prototype.hasOwnProperty.call(query, key)
      || item.length > 2_048
      || SECRET_KEY.test(key)
    ) return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_TARGET_INVALID");
    query[key] = item;
  }
  const normalized = new URLSearchParams();
  for (const key of Object.keys(query).sort(compare)) normalized.set(key, query[key]);
  const suffix = normalized.toString();
  return `${parsed.pathname}${suffix ? `?${suffix}` : ""}`;
}

function parseCanonicalBody(method: string, value: unknown): string {
  if (method === "GET" || method === "OPTIONS") {
    if (value !== undefined && value !== "" && canonicalJson(value) !== "{}") {
      return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_BODY_INVALID");
    }
    return "";
  }
  let parsed = value;
  if (typeof parsed === "string") {
    if (Buffer.byteLength(parsed, "utf8") > 1024 * 1024) {
      return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_BODY_INVALID");
    }
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_BODY_INVALID");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_BODY_INVALID");
  }
  return canonicalJson(parsed);
}

function runtimeProjection(config: IsolatedSessionEvidenceRuntimeConfig): unknown {
  return {
    version: config.version,
    viewportId: config.viewportId,
    launchBinding: config.launchBinding,
    apiBaseUrl: config.apiBaseUrl,
    planSha256: config.planSha256,
    runtimePolicyBinding: config.runtimePolicyBinding,
    runNonce: config.runNonce,
    database: config.database,
    requestEntries: config.requestEntries,
  };
}

export function isolatedSessionEvidenceRuntimeConfigBinding(
  config: IsolatedSessionEvidenceRuntimeConfig,
): string {
  assertRuntimeConfig(config);
  return binding(
    `${ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_VERSION}/config`,
    runtimeProjection(config),
  );
}

export function isolatedSessionEvidenceApiProcessBinding(
  config: IsolatedSessionEvidenceRuntimeConfig,
): string {
  const runtimeConfigBinding = isolatedSessionEvidenceRuntimeConfigBinding(config);
  return binding(
    `${ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_VERSION}/api-process`,
    {
      runtimeConfigBinding,
      launchBinding: config.launchBinding,
      viewportId: config.viewportId,
      planSha256: config.planSha256,
      runtimePolicyBinding: config.runtimePolicyBinding,
      runNonce: config.runNonce,
      databaseDev: config.database.dev,
      databaseIno: config.database.ino,
    },
  );
}

function assertRuntimeConfig(
  config: IsolatedSessionEvidenceRuntimeConfig,
): void {
  if (
    !config
    || typeof config !== "object"
    || Array.isArray(config)
    || !exactKeys(config as unknown as Record<string, unknown>, [
      "apiBaseUrl",
      "database",
      "launchBinding",
      "planSha256",
      "requestEntries",
      "runNonce",
      "runtimePolicyBinding",
      "version",
      "viewportId",
    ])
    || config.version !== ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_VERSION
    || !["R1", "R2"].includes(config.viewportId)
    || !BINDING.test(config.launchBinding)
    || !DIGEST.test(config.planSha256)
    || !BINDING.test(config.runtimePolicyBinding)
    || !RUN_NONCE.test(config.runNonce)
    || !Array.isArray(config.requestEntries)
    || config.requestEntries.length < 1
    || config.requestEntries.length > 10_000
  ) return fail("ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_INVALID");
  let apiBase: URL;
  try {
    apiBase = new URL(config.apiBaseUrl);
  } catch {
    return fail("ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_INVALID");
  }
  if (
    !config.database
    || typeof config.database !== "object"
    || Array.isArray(config.database)
    || !exactKeys(config.database as unknown as Record<string, unknown>, [
      "dev",
      "directory",
      "file",
      "ino",
    ])
  ) return fail("ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_INVALID");
  if (
    apiBase.protocol !== "http:"
    || apiBase.hostname !== "127.0.0.1"
    || !apiBase.port
    || apiBase.pathname !== "/api"
    || apiBase.search
    || apiBase.hash
    || apiBase.toString() !== `${apiBase.origin}/api`
  ) return fail("ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_INVALID");
  const canonicalDirectory = exactOwnedDirectory(config.database.directory);
  if (
    config.database.file !== path.join(canonicalDirectory, "db2.sqlite")
    || !Number.isSafeInteger(config.database.dev)
    || !Number.isSafeInteger(config.database.ino)
    || config.database.dev < 0
    || config.database.ino < 1
  ) return fail("ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_INVALID");
  const routeKeys = new Set<string>();
  const templateGroups = new Map<string, IsolatedSessionEvidencePlanEntry[]>();
  let ensureCount = 0;
  let casCount = 0;
  for (const entry of config.requestEntries) {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || !exactKeys(entry as unknown as Record<string, unknown>, [
        "bodyContract",
        "canonicalBody",
        "contractId",
        "key",
        "maxOccurrences",
        "method",
        "minOccurrences",
        "normalizedTarget",
        "requestClass",
      ])
      || !REQUEST_CLASSES.has(entry.requestClass)
      || !REQUEST_METHODS.has(entry.method)
      || typeof entry.contractId !== "string"
      || entry.contractId.length < 1
      || entry.contractId.length > 200
      || typeof entry.key !== "string"
      || normalizeRequestTarget(entry.normalizedTarget) !== entry.normalizedTarget
      || parseCanonicalBody(entry.method, entry.canonicalBody) !== entry.canonicalBody
      || !Number.isSafeInteger(entry.minOccurrences)
      || !Number.isSafeInteger(entry.maxOccurrences)
      || entry.minOccurrences < 0
      || entry.maxOccurrences < entry.minOccurrences
      || entry.maxOccurrences > 10_000
      || (entry.requestClass === "READ" && entry.method !== "GET")
      || (entry.requestClass === "READ_ONLY_POST" && entry.method !== "POST")
      || (entry.requestClass === "SESSION_ENSURE" && entry.method !== "POST")
      || (entry.requestClass === "SESSION_CAS" && entry.method !== "PUT")
    ) return fail("ISOLATED_SESSION_EVIDENCE_PLAN_ENTRY_INVALID");
    let expectedKey: string;
    if (entry.bodyContract?.kind === "exact/v1") {
      if (!exactKeys(entry.bodyContract as Record<string, unknown>, ["kind"])) {
        return fail("ISOLATED_SESSION_EVIDENCE_PLAN_ENTRY_INVALID");
      }
      expectedKey = `${entry.requestClass}\n${entry.method}\n${entry.normalizedTarget}\n${entry.canonicalBody}`;
    } else {
      try {
        assertQuickCreateEmptyDraftBodyContract(entry.bodyContract);
      } catch {
        return fail("ISOLATED_SESSION_EVIDENCE_PLAN_ENTRY_INVALID");
      }
      if (
        entry.requestClass !== "SESSION_CAS"
        || entry.method !== "PUT"
        || canonicalJson(buildQuickCreateEmptyDraftExemplar(entry.bodyContract))
          !== entry.canonicalBody
      ) return fail("ISOLATED_SESSION_EVIDENCE_PLAN_ENTRY_INVALID");
      expectedKey = `${entry.requestClass}\n${entry.method}\n${entry.normalizedTarget}\n@body-contract:${quickCreateEmptyDraftBodyContractBinding(entry.bodyContract)}`;
      const group = templateGroups.get(entry.bodyContract.templateId) ?? [];
      group.push(entry);
      templateGroups.set(entry.bodyContract.templateId, group);
    }
    if (entry.key !== expectedKey) {
      return fail("ISOLATED_SESSION_EVIDENCE_PLAN_ENTRY_INVALID");
    }
    const routeKey = entry.key;
    if (routeKeys.has(routeKey)) {
      return fail("ISOLATED_SESSION_EVIDENCE_PLAN_ENTRY_DUPLICATE");
    }
    routeKeys.add(routeKey);
    if (entry.requestClass === "SESSION_ENSURE") ensureCount += entry.minOccurrences;
    if (entry.requestClass === "SESSION_CAS") casCount += entry.minOccurrences;
  }
  for (const group of templateGroups.values()) {
    const first = group[0].bodyContract as QuickCreateEmptyDraftBodyContract;
    const profile = quickCreateEmptyDraftProfileBinding(first);
    const initial = group.filter((entry) => (
      (entry.bodyContract as QuickCreateEmptyDraftBodyContract).expectedVersion
        === first.initialVersion
    ));
    const retry = group.filter((entry) => (
      (entry.bodyContract as QuickCreateEmptyDraftBodyContract).expectedVersion
        === first.initialVersion + 1
    ));
    if (
      group.some((entry) => (
        quickCreateEmptyDraftProfileBinding(
          entry.bodyContract as QuickCreateEmptyDraftBodyContract,
        ) !== profile
        || entry.normalizedTarget !== group[0].normalizedTarget
      ))
      || initial.reduce((sum, entry) => sum + entry.minOccurrences, 0) !== 2
      || initial.reduce((sum, entry) => sum + entry.maxOccurrences, 0) !== 2
      || retry.reduce((sum, entry) => sum + entry.minOccurrences, 0) !== 1
      || retry.reduce((sum, entry) => sum + entry.maxOccurrences, 0) !== 1
    ) return fail("ISOLATED_SESSION_EVIDENCE_SESSION_PLAN_INCOMPLETE");
  }
  if (ensureCount < 1 || casCount < 3) {
    return fail("ISOLATED_SESSION_EVIDENCE_SESSION_PLAN_INCOMPLETE");
  }
}

function assertDatabaseIdentity(config: IsolatedSessionEvidenceRuntimeConfig): void {
  let stat: fs.Stats;
  let pathStat: fs.Stats;
  try {
    stat = fs.statSync(config.database.file);
    pathStat = fs.lstatSync(config.database.file);
  } catch {
    return fail("ISOLATED_SESSION_EVIDENCE_DATABASE_IDENTITY_INVALID");
  }
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || !stat.isFile()
    || stat.dev !== pathStat.dev
    || stat.ino !== pathStat.ino
    || stat.dev !== config.database.dev
    || stat.ino !== config.database.ino
    || stat.nlink !== 1
    || (stat.mode & 0o777) !== 0o600
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) return fail("ISOLATED_SESSION_EVIDENCE_DATABASE_IDENTITY_INVALID");
}

export type IsolatedSessionEvidenceRequestFenceTicket =
  | Readonly<{
    kind: "planned";
    sequence: number;
    complete: (responseStatus: number) => void;
    abort: () => void;
  }>
  | Readonly<{
    kind: "preflight";
    sequence: null;
    complete: (responseStatus: number) => void;
    abort: () => void;
  }>;

export type IsolatedSessionEvidenceRequestFence = Readonly<{
  runtimeConfigBinding: string;
  apiProcessBinding: string;
  authorize: (input: Readonly<{
    method?: unknown;
    target?: unknown;
    body?: unknown;
  }>) => IsolatedSessionEvidenceRequestFenceTicket | null;
  assertCurrent: () => void;
  seal: () => IsolatedSessionEvidenceRequestLedger;
}>;

export function createIsolatedSessionEvidenceRequestFence(
  config: IsolatedSessionEvidenceRuntimeConfig,
): IsolatedSessionEvidenceRequestFence {
  assertRuntimeConfig(config);
  assertDatabaseIdentity(config);
  const runtimeConfigBinding = isolatedSessionEvidenceRuntimeConfigBinding(config);
  const apiProcessBinding = isolatedSessionEvidenceApiProcessBinding(config);
  const runNonceBinding = binding(
    `${ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_VERSION}/run-nonce`,
    config.runNonce,
  );
  const exactEntries = new Map(config.requestEntries
    .filter((entry) => entry.bodyContract.kind === "exact/v1")
    .map((entry) => [
      `${entry.method}\n${entry.normalizedTarget}\n${entry.canonicalBody}`,
      entry,
    ]));
  const templateEntries = new Map<string, IsolatedSessionEvidencePlanEntry[]>();
  for (const entry of config.requestEntries) {
    if (entry.bodyContract.kind !== "quick-create-empty-draft/v1") continue;
    const key = `${entry.method}\n${entry.normalizedTarget}`;
    const group = templateEntries.get(key) ?? [];
    group.push(entry);
    templateEntries.set(key, group);
  }
  const quickCreateMatcher = createQuickCreateEmptyDraftMatcher();
  const targets = new Set(config.requestEntries.map((entry) => entry.normalizedTarget));
  const counts = new Map(config.requestEntries.map((entry) => [entry.key, 0]));
  const records: IsolatedSessionEvidenceRequestLedgerRecord[] = [];
  const active = new Set<number>();
  let nextSequence = 1;
  let preflightRequestCount = 0;
  let blockedRequestCount = 0;
  let sealed = false;

  const authorize: IsolatedSessionEvidenceRequestFence["authorize"] = (input) => {
    if (sealed) return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_AFTER_SEAL");
    let method: string;
    let normalizedTarget: string;
    let canonicalBody: string;
    try {
      method = String(input.method || "GET").trim().toUpperCase();
      normalizedTarget = normalizeRequestTarget(input.target);
      canonicalBody = parseCanonicalBody(method, input.body);
    } catch (error) {
      blockedRequestCount += 1;
      if (error instanceof IsolatedSessionEvidenceRuntimeError) return null;
      return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_INVALID");
    }
    if (method === "OPTIONS") {
      if (!targets.has(normalizedTarget)) {
        blockedRequestCount += 1;
        return null;
      }
      preflightRequestCount += 1;
      let completed = false;
      return Object.freeze({
        kind: "preflight" as const,
        sequence: null,
        complete: (status: number) => {
          if (
            completed
            || !Number.isSafeInteger(status)
            || status < 100
            || status > 599
          ) return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_COMPLETION_INVALID");
          completed = true;
        },
        abort: () => {
          if (completed) return;
          completed = true;
          blockedRequestCount += 1;
        },
      });
    }
    if (!REQUEST_METHODS.has(method)) {
      blockedRequestCount += 1;
      return null;
    }
    let entry = exactEntries.get(`${method}\n${normalizedTarget}\n${canonicalBody}`);
    let bodyContractBinding: string;
    let bodyInstanceBinding: string;
    let capturedDraftBinding: string | null;
    if (entry) {
      bodyContractBinding = binding(
        `${ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_VERSION}/exact-body-contract`,
        { canonicalBody: entry.canonicalBody },
      );
      bodyInstanceBinding = binding(
        `${ISOLATED_SESSION_EVIDENCE_RUNTIME_CONFIG_VERSION}/exact-body-instance`,
        { bodyContractBinding, canonicalBody },
      );
      capturedDraftBinding = null;
    } else {
      const matches: Array<Readonly<{
        entry: IsolatedSessionEvidencePlanEntry;
        bodyContractBinding: string;
        bodyInstanceBinding: string;
        capturedDraftBinding: string;
      }>> = [];
      for (const candidate of templateEntries.get(`${method}\n${normalizedTarget}`) ?? []) {
        try {
          const matched = quickCreateMatcher.match(
            candidate.bodyContract as QuickCreateEmptyDraftBodyContract,
            input.body,
          );
          matches.push(Object.freeze({
            entry: candidate,
            bodyContractBinding: matched.bodyContractBinding,
            bodyInstanceBinding: matched.bodyInstanceBinding,
            capturedDraftBinding: matched.capturedDraftBinding,
          }));
        } catch (error) {
          if (!(error instanceof IsolatedSessionQuickCreateBodyContractError)) throw error;
        }
      }
      if (matches.length === 1) {
        entry = matches[0].entry;
        bodyContractBinding = matches[0].bodyContractBinding;
        bodyInstanceBinding = matches[0].bodyInstanceBinding;
        capturedDraftBinding = matches[0].capturedDraftBinding;
      } else {
        blockedRequestCount += 1;
        return null;
      }
    }
    if (!entry) {
      blockedRequestCount += 1;
      return null;
    }
    const current = counts.get(entry.key) ?? 0;
    if (current >= entry.maxOccurrences) {
      blockedRequestCount += 1;
      return null;
    }
    counts.set(entry.key, current + 1);
    const sequence = nextSequence;
    nextSequence += 1;
    active.add(sequence);
    let completed = false;
    const finish = (responseStatus: number, aborted: boolean): void => {
      if (
        completed
        || !Number.isSafeInteger(responseStatus)
        || responseStatus < 100
        || responseStatus > 599
      ) return fail("ISOLATED_SESSION_EVIDENCE_REQUEST_COMPLETION_INVALID");
      completed = true;
      active.delete(sequence);
      if (aborted) blockedRequestCount += 1;
      records.push(Object.freeze({
        sequence,
        planEntryKey: entry.key,
        requestClass: entry.requestClass,
        method: entry.method,
        normalizedTarget: entry.normalizedTarget,
        canonicalBody,
        bodyContractBinding,
        bodyInstanceBinding,
        capturedDraftBinding,
        responseStatus,
      }));
    };
    return Object.freeze({
      kind: "planned" as const,
      sequence,
      complete: (status: number) => finish(status, false),
      abort: () => finish(499, true),
    });
  };

  return Object.freeze({
    runtimeConfigBinding,
    apiProcessBinding,
    authorize,
    assertCurrent: () => {
      if (sealed) return fail("ISOLATED_SESSION_EVIDENCE_RUNTIME_ALREADY_SEALED");
      assertDatabaseIdentity(config);
    },
    seal: () => {
      if (sealed) return fail("ISOLATED_SESSION_EVIDENCE_LEDGER_ALREADY_SEALED");
      if (active.size !== 0) return fail("ISOLATED_SESSION_EVIDENCE_REQUESTS_NOT_DRAINED");
      assertDatabaseIdentity(config);
      sealed = true;
      const sorted = Object.freeze([...records]
        .sort((left, right) => left.sequence - right.sequence));
      const projection = {
        version: ISOLATED_SESSION_EVIDENCE_REQUEST_LEDGER_VERSION,
        runtimeConfigBinding,
        apiProcessBinding,
        launchBinding: config.launchBinding,
        viewportId: config.viewportId,
        planSha256: config.planSha256,
        runtimePolicyBinding: config.runtimePolicyBinding,
        runNonceBinding,
        databaseDev: config.database.dev,
        databaseIno: config.database.ino,
        records: sorted,
        acceptedRequestCount: nextSequence - 1,
        completedRequestCount: sorted.length,
        preflightRequestCount,
        blockedRequestCount,
        activeRequestCount: 0 as const,
        complete: true as const,
      };
      return Object.freeze({
        ...projection,
        ledgerBinding: binding(
          `${ISOLATED_SESSION_EVIDENCE_REQUEST_LEDGER_VERSION}/ledger`,
          projection,
        ),
      });
    },
  });
}

let installedRuntime: Readonly<{
  config: IsolatedSessionEvidenceRuntimeConfig;
  environmentBinding: string;
  fence: IsolatedSessionEvidenceRequestFence;
}> | null = null;

export function installIsolatedSessionEvidenceRuntime(
  config: IsolatedSessionEvidenceRuntimeConfig,
): Readonly<{
  runtimeConfigBinding: string;
  apiProcessBinding: string;
  assertCurrent: () => void;
  seal: () => IsolatedSessionEvidenceRequestLedger;
  dispose: () => void;
}> {
  if (installedRuntime) return fail("ISOLATED_SESSION_EVIDENCE_RUNTIME_ALREADY_INSTALLED");
  const profile = inspectIsolatedSessionEvidenceRuntimeEnvironment(process.env, {
    dataDir: config.database.directory,
    databaseDev: config.database.dev,
    databaseIno: config.database.ino,
  });
  const fence = createIsolatedSessionEvidenceRequestFence(config);
  installedRuntime = Object.freeze({
    config,
    environmentBinding: profile.binding,
    fence,
  });
  const assertCurrent = (): void => {
    if (!installedRuntime || installedRuntime.fence !== fence) {
      return fail("ISOLATED_SESSION_EVIDENCE_RUNTIME_NOT_INSTALLED");
    }
    const current = inspectIsolatedSessionEvidenceRuntimeEnvironment(process.env, {
      dataDir: config.database.directory,
      databaseDev: config.database.dev,
      databaseIno: config.database.ino,
    });
    if (current.binding !== profile.binding) {
      return fail("ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_CHANGED");
    }
    fence.assertCurrent();
  };
  return Object.freeze({
    runtimeConfigBinding: fence.runtimeConfigBinding,
    apiProcessBinding: fence.apiProcessBinding,
    assertCurrent,
    seal: () => {
      assertCurrent();
      return fence.seal();
    },
    dispose: () => {
      if (!installedRuntime || installedRuntime.fence !== fence) return;
      installedRuntime = null;
    },
  });
}

export function authorizeInstalledIsolatedSessionEvidenceRequest(input: Readonly<{
  method?: unknown;
  target?: unknown;
  body?: unknown;
}>): IsolatedSessionEvidenceRequestFenceTicket | null {
  if (!installedRuntime) return fail("ISOLATED_SESSION_EVIDENCE_RUNTIME_NOT_INSTALLED");
  const profile = inspectIsolatedSessionEvidenceRuntimeEnvironment(process.env, {
    dataDir: installedRuntime.config.database.directory,
    databaseDev: installedRuntime.config.database.dev,
    databaseIno: installedRuntime.config.database.ino,
  });
  if (profile.binding !== installedRuntime.environmentBinding) {
    return fail("ISOLATED_SESSION_EVIDENCE_ENVIRONMENT_CHANGED");
  }
  installedRuntime.fence.assertCurrent();
  return installedRuntime.fence.authorize(input);
}
