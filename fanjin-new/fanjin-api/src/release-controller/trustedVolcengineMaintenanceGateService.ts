import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  createHash,
  randomBytes,
  sign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

import type { MaintenanceCanaryPlanReceipt } from "./types";
import type {
  VolcengineMaintenanceCanaryTrafficGateObservation,
  VolcengineMaintenanceCanaryTrafficGateQuery,
} from "./volcengineClb";
import {
  assertReleaseMaintenanceProductionObservationBinding,
  assertReleaseMaintenanceProductionObservationMeasurements,
  trustedVolcengineMaintenanceControlPlaneFormats,
  type ReleaseMaintenanceProductionObservationBinding,
  type ReleaseMaintenanceProductionObservationMeasurements,
  type ReleaseMaintenanceProductionObservationPolicy,
} from "./trustedVolcengineMaintenanceControlPlane";

const STATE_FORMAT = "fanjin-trusted-volcengine-maintenance-gate-state/v2" as const;
const ENVELOPE_FORMAT = "fanjin-trusted-maintenance-control-envelope/v1" as const;
const REQUEST_FORMAT = "fanjin-trusted-maintenance-control-request/v1" as const;
const PREFLIGHT_FORMAT = "fanjin-volcengine-maintenance-preflight/v1" as const;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/u;
const MAX_STATE_BYTES = 512 * 1024;
const AUTO_CONTAIN_RETRY_MS = 1_000;

interface BetterSqliteDatabase {
  pragma(statement: string): unknown;
  exec(statement: string): unknown;
  prepare(statement: string): { run(...parameters: unknown[]): unknown };
}

const BetterSqlite3 = require("better-sqlite3") as new (
  filePath: string,
  options?: { fileMustExist?: boolean; timeout?: number },
) => BetterSqliteDatabase;

type GatePhase = "contained" | "opening" | "open" | "containing";

export interface TrustedVolcengineMaintenanceGateProvider {
  /** Read-only exact resource/rule inspection. */
  inspect(
    query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation>;
  /**
   * Owner-only provider mutation. The implementation must compare the exact
   * current rule digest/revision before and after ModifyRules. A plain
   * best-effort ModifyRules call is not a conforming implementation.
   */
  open(input: Readonly<{
    plan: MaintenanceCanaryPlanReceipt;
    expectedProviderRevision: string;
    autoContainDeadlineAt: number;
  }>): Promise<VolcengineMaintenanceCanaryTrafficGateObservation>;
  /** Idempotent fail-closed mutation of the dedicated gate. */
  contain(input: Readonly<{
    query: VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string };
    expectedProviderRevision?: string;
    reason: "requested" | "open-failed" | "ttl-expired" | "restart-recovery";
  }>): Promise<VolcengineMaintenanceCanaryTrafficGateObservation>;
}

export interface TrustedVolcengineMaintenanceGateState {
  format: typeof STATE_FORMAT;
  serviceId: string;
  controlPlaneConfigSha256: string;
  revision: number;
  /** Monotonic generation that makes a contained cloud snapshot non-replayable. */
  containedEpoch: number;
  phase: GatePhase;
  operationId: string | null;
  artifactSha256: string | null;
  planDigestSha256: string | null;
  topologySha256: string;
  providerRevision: string;
  autoContainDeadlineAt: number | null;
  updatedAt: number;
  stateSha256: string;
}

export interface TrustedVolcengineMaintenanceGateServiceOptions {
  serviceId: string;
  controlPlaneConfigSha256: string;
  stateFile: string;
  topology: Omit<
    VolcengineMaintenanceCanaryTrafficGateQuery,
    "operationId" | "artifactSha256" | "planDigestSha256"
  >;
  provider: TrustedVolcengineMaintenanceGateProvider;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => { cancel(): void };
}

export interface ReleaseMaintenanceProductionMetricsCollector {
  collect(input: Readonly<{
    binding: ReleaseMaintenanceProductionObservationBinding;
    policy: ReleaseMaintenanceProductionObservationPolicy;
  }>): Promise<ReleaseMaintenanceProductionObservationMeasurements>;
}

export interface TrustedReleaseMaintenanceProductionObserverServiceOptions {
  observerId: string;
  policy: ReleaseMaintenanceProductionObservationPolicy;
  collector: ReleaseMaintenanceProductionMetricsCollector;
}

export interface ReleaseMaintenanceProductionObservationPayload {
  format: "fanjin-release-maintenance-production-observation/v1";
  provider: "volcengine-clb";
  observerId: string;
  binding: ReleaseMaintenanceProductionObservationBinding;
  policy: ReleaseMaintenanceProductionObservationPolicy;
  measurements: ReleaseMaintenanceProductionObservationMeasurements;
  verdict: "PASS";
}

export interface TrustedMaintenanceControlRequestHandlerOptions {
  controlPlaneConfigSha256: string;
  authorizationTokenSha256: string;
  receiptKeyId: string;
  receiptPrivateKey: KeyObject;
  maximumClockSkewMs: number;
  responseTtlMs: number;
  now?: () => number;
}

export class TrustedVolcengineMaintenanceGateServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TrustedVolcengineMaintenanceGateServiceError";
  }
}

function fail(code: string, message: string): never {
  throw new TrustedVolcengineMaintenanceGateServiceError(code, message);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(",")}}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("MAINTENANCE_GATE_REQUEST_INVALID", `${label} is invalid`);
  }
  const object = value as Record<string, unknown>;
  if (!sameJson(Object.keys(object).sort(), [...keys].sort())) {
    fail("MAINTENANCE_GATE_REQUEST_INVALID", `${label} fields are invalid`);
  }
  return object;
}

function trustedOwner(uid: number): boolean {
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : uid;
  return uid === 0 || uid === effectiveUid;
}

function assertSafeStateParent(filePath: string): string {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
    fail("MAINTENANCE_GATE_STATE_PATH_UNSAFE", "gate state path must be canonical and absolute");
  }
  const directory = path.dirname(filePath);
  let metadata;
  try {
    metadata = lstatSync(directory);
  } catch {
    return fail("MAINTENANCE_GATE_STATE_PATH_UNSAFE", "gate state directory is unavailable");
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || (metadata.mode & 0o7777) !== 0o700
    || !trustedOwner(metadata.uid)
    || realpathSync(directory) !== directory
  ) {
    fail("MAINTENANCE_GATE_STATE_PATH_UNSAFE", "gate state directory must be owned 0700");
  }
  return directory;
}

function stateWithoutDigest(input: Omit<TrustedVolcengineMaintenanceGateState, "stateSha256">) {
  return { ...input };
}

function stateWithDigest(
  input: Omit<TrustedVolcengineMaintenanceGateState, "stateSha256">,
): TrustedVolcengineMaintenanceGateState {
  return {
    ...input,
    stateSha256: sha256(canonicalJson(stateWithoutDigest(input))),
  };
}

function assertState(value: unknown): TrustedVolcengineMaintenanceGateState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("MAINTENANCE_GATE_STATE_INVALID", "gate state is invalid");
  }
  const state = value as TrustedVolcengineMaintenanceGateState;
  const keys = Object.keys(state).sort();
  const expectedKeys = [
    "format",
    "serviceId",
    "controlPlaneConfigSha256",
    "revision",
    "containedEpoch",
    "phase",
    "operationId",
    "artifactSha256",
    "planDigestSha256",
    "topologySha256",
    "providerRevision",
    "autoContainDeadlineAt",
    "updatedAt",
    "stateSha256",
  ].sort();
  const { stateSha256, ...withoutDigest } = state;
  if (
    !sameJson(keys, expectedKeys)
    || state.format !== STATE_FORMAT
    || !SAFE_ID_RE.test(state.serviceId)
    || !SHA256_RE.test(state.controlPlaneConfigSha256)
    || !Number.isSafeInteger(state.revision)
    || state.revision < 1
    || !Number.isSafeInteger(state.containedEpoch)
    || state.containedEpoch < 1
    || !["contained", "opening", "open", "containing"].includes(state.phase)
    || (state.operationId !== null && !SAFE_ID_RE.test(state.operationId))
    || (state.artifactSha256 !== null && !SHA256_RE.test(state.artifactSha256))
    || (state.planDigestSha256 !== null && !SHA256_RE.test(state.planDigestSha256))
    || !SHA256_RE.test(state.topologySha256)
    || typeof state.providerRevision !== "string"
    || !state.providerRevision
    || state.providerRevision.length > 256
    || !Number.isSafeInteger(state.updatedAt)
    || (state.autoContainDeadlineAt !== null && !Number.isSafeInteger(state.autoContainDeadlineAt))
    || stateSha256 !== sha256(canonicalJson(withoutDigest))
  ) {
    fail("MAINTENANCE_GATE_STATE_INVALID", "gate state identity or digest is invalid");
  }
  return state;
}

class DurableGateStateStore {
  private readonly filePath: string;
  private readonly directory: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.directory = assertSafeStateParent(filePath);
  }

  read(): TrustedVolcengineMaintenanceGateState | null {
    if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
      fail("MAINTENANCE_GATE_STATE_PATH_UNSAFE", "safe gate state access is unsupported");
    }
    let before;
    try {
      before = lstatSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o7777) !== 0o600
      || !trustedOwner(before.uid)
      || before.size < 1
      || before.size > MAX_STATE_BYTES
    ) {
      fail("MAINTENANCE_GATE_STATE_PATH_UNSAFE", "gate state file is unsafe");
    }
    const descriptor = openSync(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor);
      if (
        opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.uid !== before.uid
        || opened.nlink !== 1
        || (opened.mode & 0o7777) !== 0o600
        || opened.size !== before.size
        || opened.mtimeMs !== before.mtimeMs
      ) {
        fail("MAINTENANCE_GATE_STATE_PATH_UNSAFE", "gate state changed during secure open");
      }
      const bytes = readFileSync(descriptor);
      return assertState(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error instanceof TrustedVolcengineMaintenanceGateServiceError) throw error;
      return fail("MAINTENANCE_GATE_STATE_INVALID", "gate state is not valid JSON");
    } finally {
      closeSync(descriptor);
    }
  }

  cas(input: {
    expectedRevision: number | null;
    next: Omit<TrustedVolcengineMaintenanceGateState, "stateSha256">;
  }): TrustedVolcengineMaintenanceGateState {
    const current = this.read();
    if ((current?.revision ?? null) !== input.expectedRevision) {
      fail("MAINTENANCE_GATE_STATE_CAS_CONFLICT", "gate state revision changed");
    }
    const next = assertState(stateWithDigest(input.next));
    const bytes = Buffer.from(`${JSON.stringify(next)}\n`, "utf8");
    if (bytes.length > MAX_STATE_BYTES) {
      fail("MAINTENANCE_GATE_STATE_INVALID", "gate state exceeds the protected limit");
    }
    const temporary = path.join(
      this.directory,
      `.${path.basename(this.filePath)}.${randomBytes(12).toString("hex")}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
        if (written < 1) fail("MAINTENANCE_GATE_STATE_WRITE_FAILED", "gate state write made no progress");
        offset += written;
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.filePath);
      const directoryDescriptor = openSync(
        this.directory,
        constants.O_RDONLY | (constants.O_DIRECTORY || 0),
      );
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      const readback = this.read();
      if (!readback || !sameJson(readback, next)) {
        fail("MAINTENANCE_GATE_STATE_WRITE_FAILED", "gate state readback differs");
      }
      return readback;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* private best-effort cleanup */ }
    }
  }

  /** Preserve a safe-but-invalid receipt for forensics before rebuilding it. */
  quarantineInvalid(): string | null {
    let metadata;
    try {
      metadata = lstatSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink !== 1
      || (metadata.mode & 0o7777) !== 0o600
      || !trustedOwner(metadata.uid)
    ) {
      fail("MAINTENANCE_GATE_STATE_PATH_UNSAFE", "unsafe gate state cannot be quarantined");
    }
    const quarantine = `${this.filePath}.quarantine.${Date.now()}.${randomBytes(8).toString("hex")}`;
    renameSync(this.filePath, quarantine);
    const directoryDescriptor = openSync(
      this.directory,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0),
    );
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return quarantine;
  }
}

/** Kernel-released SQLite exclusive lock: cross-process and crash-safe. */
class OwnerOnlyGateMutationLock {
  private readonly database: BetterSqliteDatabase;

  constructor(stateFile: string) {
    const directory = assertSafeStateParent(stateFile);
    const lockFile = `${stateFile}.owner-lock.sqlite`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        lockFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      closeSync(descriptor);
      descriptor = undefined;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = lstatSync(lockFile);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink !== 1
      || (metadata.mode & 0o7777) !== 0o600
      || !trustedOwner(metadata.uid)
      || realpathSync(path.dirname(lockFile)) !== directory
    ) {
      fail("MAINTENANCE_GATE_LOCK_UNSAFE", "gate mutation lock must be an owned 0600 regular file");
    }
    this.database = new BetterSqlite3(lockFile, { fileMustExist: true, timeout: 0 });
    this.database.pragma("journal_mode = DELETE");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("busy_timeout = 0");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS gate_lock_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        service TEXT NOT NULL
      );
    `);
  }

  async run<T>(serviceId: string, operation: () => Promise<T>): Promise<T> {
    try {
      this.database.exec("BEGIN EXCLUSIVE");
    } catch {
      return fail("MAINTENANCE_GATE_OWNER_LOCKED", "another trusted gate owner holds the mutation lock");
    }
    try {
      this.database.prepare(`
        INSERT INTO gate_lock_identity (singleton, service)
        VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET service = excluded.service
      `).run(serviceId);
      const result = await operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* crash-safe SQLite cleanup */ }
      throw error;
    }
  }
}

function topologyFromQuery(query: VolcengineMaintenanceCanaryTrafficGateQuery) {
  const {
    operationId: _operationId,
    artifactSha256: _artifactSha256,
    planDigestSha256: _planDigestSha256,
    ...topology
  } = query;
  return topology;
}

function queryFromPlan(plan: MaintenanceCanaryPlanReceipt): VolcengineMaintenanceCanaryTrafficGateQuery & {
  planDigestSha256: string;
} {
  return {
    operationId: plan.operationId,
    artifactSha256: plan.artifactSha256,
    planDigestSha256: plan.planDigestSha256,
    productionListenerId: plan.productionListenerId,
    productionServerGroupId: plan.productionServerGroupId,
    canaryListenerId: plan.canaryListenerId,
    trafficGateId: plan.trafficGateId,
    maintenanceServerGroupId: plan.maintenanceServerGroupId,
    canaryServerGroupId: plan.canaryServerGroupId,
    apiNodeIds: plan.apiNodeIds,
    productionTargets: plan.productionTargets,
    canaryTargets: plan.canaryTargets,
    productionBackendWeight: plan.productionBackendWeight ?? 0,
    maintenanceTrafficWeightPercent:
      plan.maintenanceTrafficWeightPercent ?? 100 - plan.trafficWeightPercent,
    trafficWeightPercent: plan.trafficWeightPercent,
    autoContainAfterMs: plan.autoContainAfterMs,
  };
}

function defaultSchedule(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

/** Public revision never exposes a replayable cloud-snapshot digest by itself. */
export function trustedVolcengineMaintenanceGateProviderRevision(
  containedEpoch: number,
  rawProviderRevision: string,
): string {
  if (!Number.isSafeInteger(containedEpoch) || containedEpoch < 1 || !rawProviderRevision) {
    fail("MAINTENANCE_GATE_STATE_INVALID", "gate provider revision input is invalid");
  }
  return `gate-epoch:${containedEpoch}:sha256:${sha256(rawProviderRevision)}`;
}

/**
 * Single-machine owner for the dedicated maintenance rule. Production IAM
 * must make this service the only principal allowed to mutate that rule.
 */
export class TrustedVolcengineMaintenanceGateService {
  private readonly options: TrustedVolcengineMaintenanceGateServiceOptions;
  private readonly store: DurableGateStateStore;
  private readonly topologySha256: string;
  private readonly now: () => number;
  private readonly schedule: NonNullable<TrustedVolcengineMaintenanceGateServiceOptions["schedule"]>;
  private readonly ownerLock: OwnerOnlyGateMutationLock;
  private tail: Promise<void> = Promise.resolve();
  private autoContainTimer?: { cancel(): void };
  private autoContainGeneration = 0;

  constructor(options: TrustedVolcengineMaintenanceGateServiceOptions) {
    if (
      !SAFE_ID_RE.test(options.serviceId)
      || !SHA256_RE.test(options.controlPlaneConfigSha256)
    ) {
      fail("MAINTENANCE_GATE_SERVICE_CONFIG_INVALID", "gate service identity is invalid");
    }
    this.options = options;
    this.store = new DurableGateStateStore(options.stateFile);
    this.ownerLock = new OwnerOnlyGateMutationLock(options.stateFile);
    this.topologySha256 = sha256(canonicalJson(options.topology));
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.ownerLock.run(this.options.serviceId, operation);
    } finally {
      release();
    }
  }

  private assertTopology(query: VolcengineMaintenanceCanaryTrafficGateQuery): void {
    if (!sameJson(topologyFromQuery(query), this.options.topology)) {
      fail("MAINTENANCE_GATE_TOPOLOGY_MISMATCH", "request is not bound to the pre-provisioned topology");
    }
  }

  private nextState(input: {
    current: TrustedVolcengineMaintenanceGateState | null;
    phase: GatePhase;
    observation: VolcengineMaintenanceCanaryTrafficGateObservation;
    deadlineAt: number | null;
    advanceContainedEpoch?: boolean;
  }): TrustedVolcengineMaintenanceGateState {
    const containedEpoch = input.current
      ? input.current.containedEpoch + (input.advanceContainedEpoch ? 1 : 0)
      : 1;
    return this.store.cas({
      expectedRevision: input.current?.revision ?? null,
      next: {
        format: STATE_FORMAT,
        serviceId: this.options.serviceId,
        controlPlaneConfigSha256: this.options.controlPlaneConfigSha256,
        revision: (input.current?.revision ?? 0) + 1,
        containedEpoch,
        phase: input.phase,
        operationId: input.observation.operationId,
        artifactSha256: input.observation.artifactSha256,
        planDigestSha256: input.observation.planDigestSha256,
        topologySha256: this.topologySha256,
        providerRevision: input.observation.providerRevision,
        autoContainDeadlineAt: input.deadlineAt,
        updatedAt: this.now(),
      },
    });
  }

  private publicObservation(
    observation: VolcengineMaintenanceCanaryTrafficGateObservation,
    state: TrustedVolcengineMaintenanceGateState,
  ): VolcengineMaintenanceCanaryTrafficGateObservation {
    return {
      ...observation,
      providerRevision: trustedVolcengineMaintenanceGateProviderRevision(
        state.containedEpoch,
        observation.providerRevision,
      ),
    };
  }

  private assertStateIdentity(state: TrustedVolcengineMaintenanceGateState): void {
    if (
      state.serviceId !== this.options.serviceId
      || state.controlPlaneConfigSha256 !== this.options.controlPlaneConfigSha256
      || state.topologySha256 !== this.topologySha256
    ) {
      fail("MAINTENANCE_GATE_STATE_IDENTITY_MISMATCH", "gate state belongs to another control plane");
    }
  }

  private armAutoContain(plan: MaintenanceCanaryPlanReceipt, deadlineAt: number): void {
    this.autoContainTimer?.cancel();
    const generation = ++this.autoContainGeneration;
    const query = queryFromPlan(plan);
    const attempt = () => {
      if (generation !== this.autoContainGeneration) return;
      this.autoContainTimer = undefined;
      void this.serialized(() => this.containLocked(query, "ttl-expired", generation)).catch(() => {
        if (generation === this.autoContainGeneration) {
          this.autoContainTimer = this.scheduleSafely(attempt, AUTO_CONTAIN_RETRY_MS);
        }
      });
    };
    this.autoContainTimer = this.scheduleSafely(attempt, Math.max(0, deadlineAt - this.now()));
  }

  private scheduleSafely(callback: () => void, delayMs: number): { cancel(): void } {
    try {
      return this.schedule(callback, delayMs);
    } catch {
      // A test seam or wrapper scheduler must never be able to suppress the
      // production safety timer after the cloud mutation may have succeeded.
      return defaultSchedule(callback, delayMs);
    }
  }

  private async containUncertainOnceLocked(
    query: VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string },
    deadlineAt: number,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    this.assertTopology(query);
    let current = this.store.read();
    if (current) this.assertStateIdentity(current);
    const before = await this.options.provider.inspect(query);
    if (before.productionBackendsAllZero !== true) {
      fail("MAINTENANCE_GATE_PROVIDER_DRIFT", "production backends are not fully drained");
    }
    current = this.nextState({
      current,
      phase: "containing",
      observation: before,
      deadlineAt,
    });
    if (before.state === "contained") return before;
    if (
      (before.planDigestSha256 && before.planDigestSha256 !== query.planDigestSha256)
      || (current.planDigestSha256 && current.planDigestSha256 !== query.planDigestSha256)
    ) {
      fail("MAINTENANCE_GATE_CONTAIN_IDENTITY_MISMATCH", "uncertain open belongs to another operation");
    }
    const contained = await this.options.provider.contain({
      query,
      expectedProviderRevision: before.providerRevision,
      reason: "open-failed",
    });
    if (
      contained.state !== "contained"
      || contained.productionBackendsAllZero !== true
      || contained.planDigestSha256 !== query.planDigestSha256
      || contained.providerRevision === before.providerRevision
    ) {
      fail("MAINTENANCE_GATE_CONTAIN_RECEIPT_INVALID", "uncertain open did not prove containment");
    }
    this.nextState({
      current,
      phase: "containing",
      observation: contained,
      deadlineAt,
    });
    return contained;
  }

  /**
   * A failed/timed-out open is an indeterminate cloud mutation. Keep probing
   * and containing through the whole provider completion window, then require
   * two separated contained readbacks before publishing stable containment.
   */
  private armUncertainContainment(
    query: VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string },
    deadlineAt: number,
  ): void {
    this.autoContainTimer?.cancel();
    const generation = ++this.autoContainGeneration;
    let stableContainedSamples = 0;
    const attempt = () => {
      if (generation !== this.autoContainGeneration) return;
      this.autoContainTimer = undefined;
      void this.serialized(async () => {
        const observation = await this.containUncertainOnceLocked(query, deadlineAt);
        if (this.now() >= deadlineAt && observation.state === "contained") {
          stableContainedSamples += 1;
        } else {
          stableContainedSamples = 0;
        }
        if (stableContainedSamples < 2) return false;
        const current = this.store.read();
        if (!current || current.phase !== "containing") {
          fail("MAINTENANCE_GATE_STATE_INVALID", "uncertain containment state disappeared");
        }
        this.nextState({
          current,
          phase: "contained",
          observation,
          deadlineAt: null,
          advanceContainedEpoch: true,
        });
        this.autoContainGeneration += 1;
        return true;
      }).then((done) => {
        if (!done && generation === this.autoContainGeneration) {
          this.autoContainTimer = this.scheduleSafely(attempt, AUTO_CONTAIN_RETRY_MS);
        }
      }).catch(() => {
        stableContainedSamples = 0;
        if (generation === this.autoContainGeneration) {
          this.autoContainTimer = this.scheduleSafely(attempt, AUTO_CONTAIN_RETRY_MS);
        }
      });
    };
    this.autoContainTimer = this.scheduleSafely(attempt, 0);
  }

  async preflight(
    query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    return this.serialized(async () => {
      this.assertTopology(query);
      const observation = await this.options.provider.inspect(query);
      let state = this.store.read();
      if (state) this.assertStateIdentity(state);
      if (state?.phase === "contained" && observation.state !== "contained") {
        fail("MAINTENANCE_GATE_PROVIDER_DRIFT", "provider is open while durable state is contained");
      }
      if (!state) {
        if (observation.state !== "contained" || observation.productionBackendsAllZero !== true) {
          fail("MAINTENANCE_GATE_PROVIDER_DRIFT", "provider is not safely contained at initialization");
        }
        state = this.nextState({
          current: null,
          phase: "contained",
          observation,
          deadlineAt: null,
        });
      }
      if (state.phase === "opening" || state.phase === "containing") {
        fail("MAINTENANCE_GATE_RECOVERY_PENDING", "gate recovery has not reached stable containment");
      }
      return this.publicObservation(observation, state);
    });
  }

  async open(
    plan: Readonly<MaintenanceCanaryPlanReceipt>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    return this.serialized(async () => {
      const query = queryFromPlan(plan);
      this.assertTopology(query);
      let current = this.store.read();
      if (current) this.assertStateIdentity(current);
      const before = await this.options.provider.inspect(query);
      if (
        before.state !== "contained"
        || before.productionBackendsAllZero !== true
        || trustedVolcengineMaintenanceGateProviderRevision(
          current?.containedEpoch ?? 1,
          before.providerRevision,
        ) !== plan.expectedContainedProviderRevision
        || (current && (
          current.phase !== "contained"
          || current.providerRevision !== before.providerRevision
        ))
      ) {
        fail("MAINTENANCE_GATE_OPEN_CAS_REJECTED", "provider/durable contained revision changed");
      }
      if (!current) {
        current = this.nextState({
          current: null,
          phase: "contained",
          observation: before,
          deadlineAt: null,
        });
      }
      const deadlineAt = this.now() + plan.autoContainAfterMs;
      current = this.nextState({
        current,
        phase: "opening",
        observation: {
          ...before,
          operationId: plan.operationId,
          artifactSha256: plan.artifactSha256,
          planDigestSha256: plan.planDigestSha256,
        },
        deadlineAt,
      });
      let opened: VolcengineMaintenanceCanaryTrafficGateObservation;
      try {
        opened = await this.options.provider.open({
          plan: {
            ...plan,
            expectedContainedProviderRevision: before.providerRevision,
          },
          expectedProviderRevision: before.providerRevision,
          autoContainDeadlineAt: deadlineAt,
        });
      } catch (error) {
        this.armUncertainContainment(query, deadlineAt);
        throw error;
      }
      if (
        opened.state !== "open"
        || opened.planDigestSha256 !== plan.planDigestSha256
        || opened.operationId !== plan.operationId
        || opened.artifactSha256 !== plan.artifactSha256
        || opened.productionBackendsAllZero !== true
        || opened.autoContainAfterMs !== plan.autoContainAfterMs
        || opened.providerRevision === before.providerRevision
      ) {
        this.armUncertainContainment(query, deadlineAt);
        fail("MAINTENANCE_GATE_OPEN_RECEIPT_INVALID", "provider did not prove an exact CAS open");
      }
      let openedState: TrustedVolcengineMaintenanceGateState;
      try {
        openedState = this.nextState({ current, phase: "open", observation: opened, deadlineAt });
        this.armAutoContain(plan, deadlineAt);
      } catch (error) {
        this.armUncertainContainment(query, deadlineAt);
        throw error;
      }
      return this.publicObservation(opened, openedState);
    });
  }

  private async containLocked(
    query: VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string },
    reason: "requested" | "open-failed" | "ttl-expired" | "restart-recovery",
    autoContainGeneration?: number,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    this.assertTopology(query);
    if (autoContainGeneration === undefined) {
      this.autoContainTimer?.cancel();
      this.autoContainTimer = undefined;
      this.autoContainGeneration += 1;
    } else if (autoContainGeneration !== this.autoContainGeneration) {
      fail("MAINTENANCE_GATE_STALE_AUTO_CONTAIN", "stale auto-containment attempt was rejected");
    }
    let current = this.store.read();
    if (current) this.assertStateIdentity(current);
    const before = await this.options.provider.inspect(query);
    if (before.state === "contained") {
      const containedState = this.nextState({
        current,
        phase: "contained",
        observation: before,
        deadlineAt: null,
        advanceContainedEpoch: Boolean(current && current.phase !== "contained"),
      });
      if (autoContainGeneration !== undefined) this.autoContainGeneration += 1;
      return this.publicObservation(before, containedState);
    }
    if (
      (before.planDigestSha256 && before.planDigestSha256 !== query.planDigestSha256)
      || (current?.planDigestSha256 && current.planDigestSha256 !== query.planDigestSha256)
    ) {
      fail("MAINTENANCE_GATE_CONTAIN_IDENTITY_MISMATCH", "refusing to contain an unrelated gate operation");
    }
    current = this.nextState({
      current,
      phase: "containing",
      observation: before,
      deadlineAt: current?.autoContainDeadlineAt ?? null,
    });
    const contained = await this.options.provider.contain({
      query,
      expectedProviderRevision: before.providerRevision,
      reason,
    });
    if (
      contained.state !== "contained"
      || contained.productionBackendsAllZero !== true
      || contained.planDigestSha256 !== query.planDigestSha256
      || contained.providerRevision === before.providerRevision
    ) {
      fail("MAINTENANCE_GATE_CONTAIN_RECEIPT_INVALID", "provider did not prove containment");
    }
    const containedState = this.nextState({
      current,
      phase: "contained",
      observation: contained,
      deadlineAt: null,
      advanceContainedEpoch: Boolean(current),
    });
    if (autoContainGeneration !== undefined) this.autoContainGeneration += 1;
    return this.publicObservation(contained, containedState);
  }

  async contain(
    query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string }>,
    reason: "requested" | "open-failed" | "ttl-expired" | "restart-recovery" = "requested",
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    return this.serialized(() => this.containLocked({ ...query }, reason));
  }

  /** Startup recovery never reopens traffic; any non-contained evidence is drained. */
  async recover(
    query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    return this.serialized(async () => {
      this.assertTopology(query);
      const current = this.store.read();
      if (current) this.assertStateIdentity(current);
      const observed = await this.options.provider.inspect(query);
      if (
        current
        && (current.phase === "opening" || current.phase === "containing")
        && current.autoContainDeadlineAt !== null
      ) {
        const planDigestSha256 = observed.planDigestSha256
          ?? current.planDigestSha256
          ?? sha256(canonicalJson({
            format: "fanjin-maintenance-gate-emergency-recovery/v1",
            serviceId: this.options.serviceId,
            topologySha256: this.topologySha256,
            providerRevision: observed.providerRevision,
          }));
        const recoveryQuery = { ...query, planDigestSha256 };
        const contained = await this.containUncertainOnceLocked(
          recoveryQuery,
          current.autoContainDeadlineAt,
        );
        this.armUncertainContainment(recoveryQuery, current.autoContainDeadlineAt);
        const recovering = this.store.read();
        if (!recovering) fail("MAINTENANCE_GATE_STATE_INVALID", "recovery state is unavailable");
        return this.publicObservation(contained, recovering);
      }
      if (observed.state === "contained" && (!current || current.phase === "contained")) {
        const containedState = this.nextState({
          current,
          phase: "contained",
          observation: observed,
          deadlineAt: null,
        });
        return this.publicObservation(observed, containedState);
      }
      // A lost/corrupt provider response may leave the exact pinned rule open
      // before an operation identity is durable. Containment must never be
      // blocked by missing business identity, so bind a deterministic recovery
      // digest to the service/topology/provider revision and close the rule.
      const planDigestSha256 = observed.planDigestSha256
        ?? current?.planDigestSha256
        ?? sha256(canonicalJson({
          format: "fanjin-maintenance-gate-emergency-recovery/v1",
          serviceId: this.options.serviceId,
          topologySha256: this.topologySha256,
          providerRevision: observed.providerRevision,
        }));
      return this.containLocked({ ...query, planDigestSha256 }, "restart-recovery");
    });
  }

  /** Must complete before the HTTPS listener accepts any request. */
  async recoverBeforeListen(): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    let current: TrustedVolcengineMaintenanceGateState | null;
    try {
      current = this.store.read();
      if (current) this.assertStateIdentity(current);
    } catch (stateError) {
      return this.serialized(async () => {
        const query: VolcengineMaintenanceCanaryTrafficGateQuery = {
          operationId: `${this.options.serviceId}-unsafe-state-recovery`,
          artifactSha256: "0".repeat(64),
          ...this.options.topology,
        };
        const observed = await this.options.provider.inspect(query);
        let contained = observed;
        const planDigestSha256 = observed.planDigestSha256 ?? sha256(canonicalJson({
          format: "fanjin-maintenance-gate-unsafe-state-recovery/v1",
          serviceId: this.options.serviceId,
          topologySha256: this.topologySha256,
          providerRevision: observed.providerRevision,
        }));
        if (observed.state === "open") {
          contained = await this.options.provider.contain({
            query: { ...query, planDigestSha256 },
            expectedProviderRevision: observed.providerRevision,
            reason: "restart-recovery",
          });
        }
        if (contained.state !== "contained" || contained.productionBackendsAllZero !== true) {
          throw stateError;
        }
        this.store.quarantineInvalid();
        const recovered = this.nextState({
          current: null,
          phase: "contained",
          observation: contained,
          deadlineAt: null,
        });
        return this.publicObservation(contained, recovered);
      });
    }
    return this.recover({
      operationId: current?.operationId ?? `${this.options.serviceId}-startup-recovery`,
      artifactSha256: current?.artifactSha256 ?? "0".repeat(64),
      planDigestSha256: current?.planDigestSha256 ?? undefined,
      ...this.options.topology,
    });
  }

  readState(): TrustedVolcengineMaintenanceGateState | null {
    const state = this.store.read();
    if (state) this.assertStateIdentity(state);
    return state;
  }
}

/** Server-side fixed-policy observer. It never signs a non-PASS payload. */
export class TrustedReleaseMaintenanceProductionObserverService {
  private readonly options: TrustedReleaseMaintenanceProductionObserverServiceOptions;

  constructor(options: TrustedReleaseMaintenanceProductionObserverServiceOptions) {
    if (!SAFE_ID_RE.test(options.observerId)) {
      fail("MAINTENANCE_OBSERVER_CONFIG_INVALID", "production observer identity is invalid");
    }
    this.options = options;
  }

  get observerId(): string {
    return this.options.observerId;
  }

  get policy(): ReleaseMaintenanceProductionObservationPolicy {
    return this.options.policy;
  }

  async observe(
    binding: Readonly<ReleaseMaintenanceProductionObservationBinding>,
  ): Promise<ReleaseMaintenanceProductionObservationPayload> {
    assertReleaseMaintenanceProductionObservationBinding(binding);
    const measured = await this.options.collector.collect({
      binding: { ...binding },
      policy: this.options.policy,
    });
    const measurements = assertReleaseMaintenanceProductionObservationMeasurements({
      measurements: measured,
      expectedBinding: binding,
      policy: this.options.policy,
    });
    return Object.freeze({
      format: trustedVolcengineMaintenanceControlPlaneFormats.observationReceipt,
      provider: "volcengine-clb",
      observerId: this.options.observerId,
      binding: { ...binding },
      policy: this.options.policy,
      measurements,
      verdict: "PASS",
    });
  }
}

/** Strict auth/request/signature boundary to mount behind an HTTPS server. */
export class TrustedVolcengineMaintenanceControlRequestHandler {
  private readonly gate: TrustedVolcengineMaintenanceGateService;
  private readonly observer: TrustedReleaseMaintenanceProductionObserverService;
  private readonly options: TrustedMaintenanceControlRequestHandlerOptions;
  private readonly now: () => number;

  constructor(input: {
    gate: TrustedVolcengineMaintenanceGateService;
    observer: TrustedReleaseMaintenanceProductionObserverService;
    options: TrustedMaintenanceControlRequestHandlerOptions;
  }) {
    if (
      !SHA256_RE.test(input.options.controlPlaneConfigSha256)
      || !SHA256_RE.test(input.options.authorizationTokenSha256)
      || !SAFE_ID_RE.test(input.options.receiptKeyId)
      || input.options.receiptPrivateKey.asymmetricKeyType !== "ed25519"
      || !Number.isSafeInteger(input.options.maximumClockSkewMs)
      || input.options.maximumClockSkewMs < 0
      || input.options.maximumClockSkewMs > 300_000
      || !Number.isSafeInteger(input.options.responseTtlMs)
      || input.options.responseTtlMs < 1_000
      || input.options.responseTtlMs > 600_000
    ) {
      fail("MAINTENANCE_GATE_HANDLER_CONFIG_INVALID", "control request handler configuration is invalid");
    }
    this.gate = input.gate;
    this.observer = input.observer;
    this.options = input.options;
    this.now = input.options.now ?? Date.now;
  }

  private assertAuthorization(token: string): void {
    const actual = Buffer.from(sha256(token), "hex");
    const expected = Buffer.from(this.options.authorizationTokenSha256, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      fail("MAINTENANCE_GATE_UNAUTHORIZED", "trusted maintenance authorization failed");
    }
  }

  async handle(input: {
    authorizationToken: string;
    request: unknown;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.assertAuthorization(input.authorizationToken);
    const request = exactObject(input.request, [
      "format",
      "operation",
      "requestId",
      "issuedAt",
      "controlPlaneConfigSha256",
      "payload",
      "requestSha256",
    ], "trusted maintenance request");
    const operation = String(request.operation || "");
    const issuedAt = Number(request.issuedAt);
    const now = this.now();
    const requestWithoutDigest = {
      format: request.format,
      operation: request.operation,
      requestId: request.requestId,
      issuedAt: request.issuedAt,
      controlPlaneConfigSha256: request.controlPlaneConfigSha256,
      payload: request.payload,
    };
    if (
      request.format !== REQUEST_FORMAT
      || !["preflight", "inspect", "open", "contain", "observe"].includes(operation)
      || !SAFE_ID_RE.test(String(request.requestId || ""))
      || !Number.isSafeInteger(issuedAt)
      || Math.abs(now - issuedAt) > this.options.maximumClockSkewMs
      || request.controlPlaneConfigSha256 !== this.options.controlPlaneConfigSha256
      || request.requestSha256 !== sha256(canonicalJson(requestWithoutDigest))
      || !request.payload
      || typeof request.payload !== "object"
      || Array.isArray(request.payload)
    ) {
      fail("MAINTENANCE_GATE_REQUEST_INVALID", "trusted maintenance request identity is invalid");
    }

    let payload: Record<string, unknown>;
    if (operation === "preflight") {
      const preflight = exactObject(request.payload, [
        "format",
        "provider",
        "observerId",
        "operationId",
        "artifactSha256",
        "topology",
      ], "maintenance preflight request");
      if (
        preflight.format !== PREFLIGHT_FORMAT
        || preflight.provider !== "volcengine-clb"
        || preflight.observerId !== this.observer.observerId
      ) {
        fail("MAINTENANCE_GATE_REQUEST_INVALID", "maintenance preflight identity is invalid");
      }
      const topology = preflight.topology as Omit<
        VolcengineMaintenanceCanaryTrafficGateQuery,
        "operationId" | "artifactSha256" | "planDigestSha256"
      >;
      await this.gate.preflight({
        operationId: String(preflight.operationId || ""),
        artifactSha256: String(preflight.artifactSha256 || ""),
        ...topology,
      });
      payload = {
        ...preflight,
        controlPlaneConfigSha256: this.options.controlPlaneConfigSha256,
        capabilities: {
          atomicOpenCompareAndSwap: true,
          providerAutoContainment: true,
          restartInspection: true,
          signedDurableReceipts: true,
          productionObservationV1: true,
        },
      };
    } else if (operation === "inspect") {
      payload = { ...(await this.gate.preflight(
        request.payload as VolcengineMaintenanceCanaryTrafficGateQuery,
      )) };
    } else if (operation === "open") {
      payload = { ...(await this.gate.open(request.payload as MaintenanceCanaryPlanReceipt)) };
    } else if (operation === "contain") {
      payload = { ...(await this.gate.contain(
        request.payload as VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string },
      )) };
    } else {
      const observation = exactObject(request.payload, [
        "binding",
        "policy",
        "observerId",
      ], "production observation request");
      if (
        observation.observerId !== this.observer.observerId
        || !sameJson(observation.policy, this.observer.policy)
      ) {
        fail("MAINTENANCE_GATE_REQUEST_INVALID", "production observation policy identity is invalid");
      }
      payload = { ...(await this.observer.observe(
        observation.binding as ReleaseMaintenanceProductionObservationBinding,
      )) };
    }

    return signTrustedMaintenanceControlEnvelope({
      requestSha256: String(request.requestSha256),
      keyId: this.options.receiptKeyId,
      privateKey: this.options.receiptPrivateKey,
      payload,
      issuedAt: now,
      expiresAt: now + this.options.responseTtlMs,
    });
  }
}

export function createTrustedVolcengineMaintenanceServiceRuntime(input: {
  gate: TrustedVolcengineMaintenanceGateServiceOptions;
  observer: TrustedReleaseMaintenanceProductionObserverServiceOptions;
}): Readonly<{
  gate: TrustedVolcengineMaintenanceGateService;
  observer: TrustedReleaseMaintenanceProductionObserverService;
}> {
  return Object.freeze({
    gate: new TrustedVolcengineMaintenanceGateService(input.gate),
    observer: new TrustedReleaseMaintenanceProductionObserverService(input.observer),
  });
}

export function createTrustedVolcengineMaintenanceHttpsServiceRuntime(input: {
  gate: TrustedVolcengineMaintenanceGateServiceOptions;
  observer: TrustedReleaseMaintenanceProductionObserverServiceOptions;
  requestHandler: TrustedMaintenanceControlRequestHandlerOptions;
}): Readonly<{
  gate: TrustedVolcengineMaintenanceGateService;
  observer: TrustedReleaseMaintenanceProductionObserverService;
  handle(request: {
    authorizationToken: string;
    request: unknown;
  }): Promise<Readonly<Record<string, unknown>>>;
}> {
  const runtime = createTrustedVolcengineMaintenanceServiceRuntime(input);
  if (input.requestHandler.controlPlaneConfigSha256 !== input.gate.controlPlaneConfigSha256) {
    fail("MAINTENANCE_GATE_HANDLER_CONFIG_INVALID", "handler and durable gate config digests differ");
  }
  const handler = new TrustedVolcengineMaintenanceControlRequestHandler({
    ...runtime,
    options: input.requestHandler,
  });
  return Object.freeze({
    ...runtime,
    handle: (request) => handler.handle(request),
  });
}

export function signTrustedMaintenanceControlEnvelope(input: {
  requestSha256: string;
  keyId: string;
  privateKey: KeyObject;
  payload: Readonly<Record<string, unknown>>;
  issuedAt: number;
  expiresAt: number;
}): Readonly<Record<string, unknown>> {
  if (
    !SHA256_RE.test(input.requestSha256)
    || !SAFE_ID_RE.test(input.keyId)
    || input.privateKey.asymmetricKeyType !== "ed25519"
    || !Number.isSafeInteger(input.issuedAt)
    || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= input.issuedAt
  ) {
    fail("MAINTENANCE_GATE_SIGNING_INPUT_INVALID", "signed envelope identity is invalid");
  }
  const signed = {
    format: ENVELOPE_FORMAT,
    requestSha256: input.requestSha256,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    keyId: input.keyId,
    payload: input.payload,
  };
  return Object.freeze({
    ...signed,
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(signed)),
      input.privateKey,
    ).toString("base64"),
  });
}

export const trustedVolcengineMaintenanceGateStateFormat = STATE_FORMAT;
