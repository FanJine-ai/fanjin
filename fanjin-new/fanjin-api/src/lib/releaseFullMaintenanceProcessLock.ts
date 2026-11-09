import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_PATH =
  "/run/fanjin-maintenance/full-maintenance.lock" as const;
export const RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_DIRECTORY =
  "/run/fanjin-maintenance" as const;
export const RELEASE_FULL_MAINTENANCE_NODE_EXECUTABLE =
  "/usr/local/bin/node" as const;
export const RELEASE_FULL_MAINTENANCE_FLOCK_EXECUTABLE =
  "/usr/bin/flock" as const;
export const RELEASE_FULL_MAINTENANCE_RELEASES_DIRECTORY =
  "/opt/fanjin-release-controller/releases" as const;
export const RELEASE_FULL_MAINTENANCE_SYSTEMCTL_EXECUTABLE =
  "/usr/bin/systemctl" as const;
export const RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT =
  "fanjin-full-maintenance-execution.service" as const;
export const RELEASE_FULL_MAINTENANCE_SYSTEMD_CONTROL_GROUP =
  "/system.slice/fanjin-full-maintenance-execution.service" as const;
export const RELEASE_FULL_MAINTENANCE_SYSTEMD_RUNTIME_MAX = "12h" as const;
export const RELEASE_FULL_MAINTENANCE_SYSTEMD_TIMEOUT_STOP = "5min" as const;

const TRUE_EXECUTABLE = "/usr/bin/true";
const RELEASE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type ReleaseFullMaintenanceLockedEntrypoint = "execute" | "recover";

const ENTRYPOINT_BASENAME: Readonly<
Record<ReleaseFullMaintenanceLockedEntrypoint, string>
> = Object.freeze({
  execute: "execute-release-maintenance-activation.js",
  recover: "recover-release-full-maintenance.js",
});

export interface ReleaseFullMaintenanceProcessFileIdentity {
  type: "file" | "directory" | "other";
  dev: bigint;
  ino: bigint;
  uid: number;
  gid: number;
  mode: number;
  nlink: number;
  size: bigint;
  ctimeNs: bigint;
  devMajor: bigint;
  devMinor: bigint;
}

export type ReleaseFullMaintenanceLockProbeResult =
  | "contended"
  | "available"
  | "failed";

/**
 * Narrow injectable boundary used by unit tests. Production callers must not
 * provide an implementation; both formal entrypoints always use /proc and the
 * fixed absolute executables below.
 */
export interface ReleaseFullMaintenanceProcessLockSystem {
  platform: string;
  effectiveUid: number | undefined;
  processId: number;
  processArgv0: string;
  processArgv: readonly string[];
  processExecArgv: readonly string[];
  processExecutable: string;
  environment: NodeJS.ProcessEnv;
  lstat(filePath: string): ReleaseFullMaintenanceProcessFileIdentity;
  realpath(filePath: string): string;
  readProcExecutable(): string;
  readProcCommandLine(): readonly string[];
  listOpenFileDescriptors(): readonly number[];
  fstat(fileDescriptor: number): ReleaseFullMaintenanceProcessFileIdentity;
  readProcLocks(): string;
  readProcCgroup(): string;
  readBootId(): string;
  inspectSystemdUnit(): ReleaseFullMaintenanceSystemdUnitObservation;
  probeExclusiveLock(filePath: string): ReleaseFullMaintenanceLockProbeResult;
}

export interface ReleaseFullMaintenanceSystemdUnitObservation {
  id: string;
  loadState: string;
  activeState: string;
  subState: string;
  mainPid: number;
  controlGroup: string;
  invocationId: string;
  killMode: string;
  exitType: string;
  delegate: string;
  noNewPrivileges: string;
  collectMode: string;
  runtimeMaxUSec: string;
  timeoutStopUSec: string;
  umask: string;
}

export interface ReleaseFullMaintenanceProcessLockEvidence {
  format: "fanjin-release-full-maintenance-process-lock/v2";
  lockPath: typeof RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_PATH;
  entrypoint: ReleaseFullMaintenanceLockedEntrypoint;
  entrypointPath: string;
  processId: number;
  inheritedLockFileDescriptor: number;
  lockDevice: string;
  lockInode: string;
  systemdUnit: typeof RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT;
  controlGroup: typeof RELEASE_FULL_MAINTENANCE_SYSTEMD_CONTROL_GROUP;
  bootId: string;
  invocationId: string;
  processTokenSha256: string;
}

export const RELEASE_FULL_MAINTENANCE_PROCESS_BOUNDARY_FORMAT =
  "fanjin-release-full-maintenance-process-boundary/v1" as const;

/**
 * Non-secret durable projection of the kernel/systemd ownership proof.  It is
 * small enough for the execution checkpoint, but still lets a later reader
 * recompute the process token instead of trusting an opaque digest.
 */
export interface ReleaseFullMaintenanceProcessBoundaryBinding {
  format: typeof RELEASE_FULL_MAINTENANCE_PROCESS_BOUNDARY_FORMAT;
  entrypoint: ReleaseFullMaintenanceLockedEntrypoint;
  entrypointPath: string;
  processId: number;
  lockDevice: string;
  lockInode: string;
  systemdUnit: typeof RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT;
  controlGroup: typeof RELEASE_FULL_MAINTENANCE_SYSTEMD_CONTROL_GROUP;
  bootId: string;
  invocationId: string;
  processTokenSha256: string;
}

export class ReleaseFullMaintenanceProcessLockError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseFullMaintenanceProcessLockError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseFullMaintenanceProcessLockError(code, message);
}

function exactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function processToken(input: {
  bootId: string;
  invocationId: string;
  controlGroup: string;
  processId: number;
  entrypointPath: string;
  lockDevice: string;
  lockInode: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "fanjin-release-full-maintenance-process-token/v1",
    input.bootId,
    input.invocationId,
    input.controlGroup,
    input.processId,
    input.entrypointPath,
    input.lockDevice,
    input.lockInode,
  ])).digest("hex");
}

export function assertReleaseFullMaintenanceProcessBoundaryBinding(
  value: unknown,
  expectedEntrypoint?: ReleaseFullMaintenanceLockedEntrypoint,
): ReleaseFullMaintenanceProcessBoundaryBinding {
  if (!exactObjectKeys(value, [
    "bootId",
    "controlGroup",
    "entrypoint",
    "entrypointPath",
    "format",
    "invocationId",
    "lockDevice",
    "lockInode",
    "processId",
    "processTokenSha256",
    "systemdUnit",
  ])) {
    return fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_BOUNDARY_INVALID",
      "durable maintenance process boundary has unexpected fields",
    );
  }
  const binding = value as unknown as ReleaseFullMaintenanceProcessBoundaryBinding;
  const relative = typeof binding.entrypointPath === "string"
    ? path.posix.relative(RELEASE_FULL_MAINTENANCE_RELEASES_DIRECTORY, binding.entrypointPath)
    : "";
  const segments = relative.split("/");
  const expectedBasename = binding.entrypoint === "execute"
    ? ENTRYPOINT_BASENAME.execute
    : binding.entrypoint === "recover"
      ? ENTRYPOINT_BASENAME.recover
      : "";
  if (
    binding.format !== RELEASE_FULL_MAINTENANCE_PROCESS_BOUNDARY_FORMAT
    || (expectedEntrypoint !== undefined && binding.entrypoint !== expectedEntrypoint)
    || !expectedBasename
    || !path.posix.isAbsolute(binding.entrypointPath)
    || path.posix.normalize(binding.entrypointPath) !== binding.entrypointPath
    || segments.length !== 3
    || !RELEASE_VERSION_RE.test(segments[0] || "")
    || segments[1] !== "build"
    || segments[2] !== expectedBasename
    || !Number.isSafeInteger(binding.processId)
    || binding.processId < 1
    || !/^(?:0|[1-9][0-9]*)$/u.test(binding.lockDevice)
    || !/^(?:0|[1-9][0-9]*)$/u.test(binding.lockInode)
    || binding.systemdUnit !== RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT
    || binding.controlGroup !== RELEASE_FULL_MAINTENANCE_SYSTEMD_CONTROL_GROUP
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(binding.bootId)
    || !/^[0-9a-f]{32}$/u.test(binding.invocationId)
    || !/^[0-9a-f]{64}$/u.test(binding.processTokenSha256)
    || binding.processTokenSha256 !== processToken(binding)
  ) {
    return fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_BOUNDARY_INVALID",
      "durable maintenance process boundary identity is invalid",
    );
  }
  return Object.freeze({ ...binding });
}

export function releaseFullMaintenanceProcessBoundaryBinding(
  evidence: ReleaseFullMaintenanceProcessLockEvidence,
): ReleaseFullMaintenanceProcessBoundaryBinding {
  return assertReleaseFullMaintenanceProcessBoundaryBinding({
    format: RELEASE_FULL_MAINTENANCE_PROCESS_BOUNDARY_FORMAT,
    entrypoint: evidence.entrypoint,
    entrypointPath: evidence.entrypointPath,
    processId: evidence.processId,
    lockDevice: evidence.lockDevice,
    lockInode: evidence.lockInode,
    systemdUnit: evidence.systemdUnit,
    controlGroup: evidence.controlGroup,
    bootId: evidence.bootId,
    invocationId: evidence.invocationId,
    processTokenSha256: evidence.processTokenSha256,
  }, evidence.entrypoint);
}

function linuxMajor(device: bigint): bigint {
  return ((device >> 8n) & 0xfffn) | ((device >> 32n) & ~0xfffn);
}

function linuxMinor(device: bigint): bigint {
  return (device & 0xffn) | ((device >> 12n) & ~0xffn);
}

function identityFromStats(stats: fs.BigIntStats): ReleaseFullMaintenanceProcessFileIdentity {
  return {
    type: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other",
    dev: stats.dev,
    ino: stats.ino,
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    mode: Number(stats.mode & 0o7777n),
    nlink: Number(stats.nlink),
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    devMajor: linuxMajor(stats.dev),
    devMinor: linuxMinor(stats.dev),
  };
}

function readLinuxProcCommandLine(): readonly string[] {
  const bytes = fs.readFileSync("/proc/self/cmdline");
  if (bytes.length < 1 || bytes[bytes.length - 1] !== 0) {
    return fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_ARGV_INVALID",
      "kernel process command line is not canonical",
    );
  }
  const arguments_ = bytes.subarray(0, bytes.length - 1)
    .toString("utf8")
    .split("\0");
  if (arguments_.some((value) => !value || value.includes("\ufffd"))) {
    return fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_ARGV_INVALID",
      "kernel process command line contains an invalid argument",
    );
  }
  return Object.freeze(arguments_);
}

function inspectProductionSystemdUnit(): ReleaseFullMaintenanceSystemdUnitObservation {
  const properties = [
    "Id",
    "LoadState",
    "ActiveState",
    "SubState",
    "MainPID",
    "ControlGroup",
    "InvocationID",
    "KillMode",
    "ExitType",
    "Delegate",
    "NoNewPrivileges",
    "CollectMode",
    "RuntimeMaxUSec",
    "TimeoutStopUSec",
    "UMask",
  ] as const;
  const result = spawnSync(
    RELEASE_FULL_MAINTENANCE_SYSTEMCTL_EXECUTABLE,
    [
      "show",
      RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT,
      "--no-pager",
      ...properties.map((property) => `--property=${property}`),
    ],
    {
      cwd: "/",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", TZ: "UTC" },
      encoding: "utf8",
      maxBuffer: 32 * 1024,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (
    result.error
    || result.signal !== null
    || result.status !== 0
    || result.stderr !== ""
    || !result.stdout.endsWith("\n")
  ) {
    return fail(
      "RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT_INVALID",
      "systemd did not return the exact full-maintenance service identity",
    );
  }
  const values = new Map<string, string>();
  for (const line of result.stdout.trimEnd().split("\n")) {
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator) : "";
    if (!properties.includes(key as typeof properties[number]) || values.has(key)) {
      return fail(
        "RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT_INVALID",
        "systemd returned an unexpected service property",
      );
    }
    values.set(key, line.slice(separator + 1));
  }
  if (values.size !== properties.length) {
    return fail(
      "RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT_INVALID",
      "systemd omitted a required service property",
    );
  }
  const mainPid = Number(values.get("MainPID"));
  if (!Number.isSafeInteger(mainPid) || mainPid < 1) {
    return fail(
      "RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT_INVALID",
      "systemd returned an invalid service process identity",
    );
  }
  return {
    id: String(values.get("Id")),
    loadState: String(values.get("LoadState")),
    activeState: String(values.get("ActiveState")),
    subState: String(values.get("SubState")),
    mainPid,
    controlGroup: String(values.get("ControlGroup")),
    invocationId: String(values.get("InvocationID")),
    killMode: String(values.get("KillMode")),
    exitType: String(values.get("ExitType")),
    delegate: String(values.get("Delegate")),
    noNewPrivileges: String(values.get("NoNewPrivileges")),
    collectMode: String(values.get("CollectMode")),
    runtimeMaxUSec: String(values.get("RuntimeMaxUSec")),
    timeoutStopUSec: String(values.get("TimeoutStopUSec")),
    umask: String(values.get("UMask")),
  };
}

function productionSystem(): ReleaseFullMaintenanceProcessLockSystem {
  return {
    platform: process.platform,
    effectiveUid: typeof process.geteuid === "function" ? process.geteuid() : undefined,
    processId: process.pid,
    processArgv0: process.argv0,
    processArgv: process.argv,
    processExecArgv: process.execArgv,
    processExecutable: process.execPath,
    environment: process.env,
    lstat: (filePath) => identityFromStats(fs.lstatSync(filePath, { bigint: true })),
    realpath: (filePath) => fs.realpathSync(filePath),
    readProcExecutable: () => fs.realpathSync("/proc/self/exe"),
    readProcCommandLine: readLinuxProcCommandLine,
    listOpenFileDescriptors: () => fs.readdirSync("/proc/self/fd")
      .filter((value) => /^(?:0|[1-9][0-9]*)$/u.test(value))
      .map(Number)
      .filter(Number.isSafeInteger)
      .sort((left, right) => left - right),
    fstat: (fileDescriptor) => identityFromStats(fs.fstatSync(
      fileDescriptor,
      { bigint: true },
    )),
    readProcLocks: () => fs.readFileSync("/proc/locks", "utf8"),
    readProcCgroup: () => fs.readFileSync("/proc/self/cgroup", "utf8"),
    readBootId: () => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8"),
    inspectSystemdUnit: inspectProductionSystemdUnit,
    probeExclusiveLock: (filePath) => {
      const result = spawnSync(
        RELEASE_FULL_MAINTENANCE_FLOCK_EXECUTABLE,
        ["--exclusive", "--nonblock", filePath, TRUE_EXECUTABLE],
        {
          cwd: "/",
          env: {
            LANG: "C",
            LC_ALL: "C",
            PATH: "/usr/bin:/bin",
            TZ: "UTC",
          },
          encoding: "utf8",
          stdio: "ignore",
          timeout: 5_000,
          windowsHide: true,
        },
      );
      if (result.error || result.signal !== null || result.status === null) return "failed";
      if (result.status === 1) return "contended";
      if (result.status === 0) return "available";
      return "failed";
    },
  };
}

function assertSystemdProcessBoundary(input: {
  system: ReleaseFullMaintenanceProcessLockSystem;
  entrypointPath: string;
  lock: ReleaseFullMaintenanceProcessFileIdentity;
}): Pick<
ReleaseFullMaintenanceProcessLockEvidence,
"systemdUnit" | "controlGroup" | "bootId" | "invocationId" | "processTokenSha256"
> {
  const observation = input.system.inspectSystemdUnit();
  const bootId = input.system.readBootId().trim();
  if (
    input.system.readProcCgroup()
      !== `0::${RELEASE_FULL_MAINTENANCE_SYSTEMD_CONTROL_GROUP}\n`
    || observation.id !== RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT
    || observation.loadState !== "loaded"
    || observation.activeState !== "active"
    || observation.subState !== "running"
    || observation.mainPid !== input.system.processId
    || observation.controlGroup !== RELEASE_FULL_MAINTENANCE_SYSTEMD_CONTROL_GROUP
    || !/^[0-9a-f]{32}$/u.test(observation.invocationId)
    || observation.killMode !== "control-group"
    || observation.exitType !== "cgroup"
    || observation.delegate !== "no"
    || observation.noNewPrivileges !== "yes"
    || observation.collectMode !== "inactive-or-failed"
    || observation.runtimeMaxUSec !== RELEASE_FULL_MAINTENANCE_SYSTEMD_RUNTIME_MAX
    || observation.timeoutStopUSec !== RELEASE_FULL_MAINTENANCE_SYSTEMD_TIMEOUT_STOP
    || observation.umask !== "0077"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(bootId)
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT_INVALID",
      "maintenance process is outside the exact containment service cgroup",
    );
  }
  const processTokenSha256 = processToken({
    bootId,
    invocationId: observation.invocationId,
    controlGroup: observation.controlGroup,
    processId: input.system.processId,
    entrypointPath: input.entrypointPath,
    lockDevice: input.lock.dev.toString(10),
    lockInode: input.lock.ino.toString(10),
  });
  return Object.freeze({
    systemdUnit: RELEASE_FULL_MAINTENANCE_SYSTEMD_UNIT,
    controlGroup: RELEASE_FULL_MAINTENANCE_SYSTEMD_CONTROL_GROUP,
    bootId,
    invocationId: observation.invocationId,
    processTokenSha256,
  });
}

function assertCanonicalTrustedDirectory(input: {
  system: ReleaseFullMaintenanceProcessLockSystem;
  directory: string;
}): void {
  const metadata = input.system.lstat(input.directory);
  if (
    input.system.realpath(input.directory) !== input.directory
    || metadata.type !== "directory"
    || metadata.uid !== 0
    || metadata.gid !== 0
    || (metadata.mode & 0o022) !== 0
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_ENTRYPOINT_UNSAFE",
      "maintenance release directory is not immutable",
    );
  }
}

function assertCanonicalLockDirectory(
  system: ReleaseFullMaintenanceProcessLockSystem,
): void {
  for (const [directory, exactMode] of [
    ["/run", undefined],
    [RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_DIRECTORY, 0o700],
  ] as const) {
    const metadata = system.lstat(directory);
    if (
      system.realpath(directory) !== directory
      || metadata.type !== "directory"
      || metadata.uid !== 0
      || metadata.gid !== 0
      || (metadata.mode & 0o022) !== 0
      || (exactMode !== undefined && metadata.mode !== exactMode)
    ) {
      fail(
        "RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_UNSAFE",
        "full-maintenance lock directory is replaceable",
      );
    }
  }
}

function assertCanonicalTrustedExecutable(input: {
  system: ReleaseFullMaintenanceProcessLockSystem;
  filePath: string;
}): void {
  const metadata = input.system.lstat(input.filePath);
  if (
    input.system.realpath(input.filePath) !== input.filePath
    || metadata.type !== "file"
    || metadata.uid !== 0
    || metadata.gid !== 0
    || metadata.nlink !== 1
    || metadata.size < 1n
    || (metadata.mode & 0o022) !== 0
    || (metadata.mode & 0o111) === 0
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_EXECUTABLE_UNSAFE",
      "maintenance executable is not a trusted absolute executable",
    );
  }
}

function expectedEntrypointPath(input: {
  system: ReleaseFullMaintenanceProcessLockSystem;
  entrypoint: ReleaseFullMaintenanceLockedEntrypoint;
}): string {
  const procArguments = input.system.readProcCommandLine();
  const processArguments = input.system.processArgv;
  const unsafeEnvironmentKeys = ["LD_LIBRARY_PATH", "LD_PRELOAD", "NODE_OPTIONS"];
  if (
    input.system.processExecutable !== RELEASE_FULL_MAINTENANCE_NODE_EXECUTABLE
    || input.system.processArgv0 !== RELEASE_FULL_MAINTENANCE_NODE_EXECUTABLE
    || input.system.processExecArgv.length !== 0
    || procArguments.length < 2
    || procArguments[0] !== RELEASE_FULL_MAINTENANCE_NODE_EXECUTABLE
    || processArguments.length < 2
    || processArguments[0] !== RELEASE_FULL_MAINTENANCE_NODE_EXECUTABLE
    || procArguments.length !== processArguments.length
    || procArguments.some((value, index) => value !== processArguments[index])
    || input.system.environment.FANJIN_FULL_MAINTENANCE_LAUNCHER_SANITIZED !== "1"
    || unsafeEnvironmentKeys.some((name) => String(input.system.environment[name] || "").trim())
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_ARGV_INVALID",
      "maintenance Node invocation is not the exact sanitized launcher child",
    );
  }
  const expectedExecutableRealpath = input.system.realpath(
    RELEASE_FULL_MAINTENANCE_NODE_EXECUTABLE,
  );
  if (input.system.readProcExecutable() !== expectedExecutableRealpath) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_ARGV_INVALID",
      "maintenance process executable identity differs from its argv",
    );
  }
  const entrypointPath = String(procArguments[1] || "");
  if (
    !path.posix.isAbsolute(entrypointPath)
    || path.posix.normalize(entrypointPath) !== entrypointPath
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_ENTRYPOINT_UNSAFE",
      "maintenance entrypoint path is not canonical",
    );
  }
  const relative = path.posix.relative(
    RELEASE_FULL_MAINTENANCE_RELEASES_DIRECTORY,
    entrypointPath,
  );
  const segments = relative.split("/");
  if (
    segments.length !== 3
    || !RELEASE_VERSION_RE.test(segments[0] || "")
    || segments[1] !== "build"
    || segments[2] !== ENTRYPOINT_BASENAME[input.entrypoint]
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_ENTRYPOINT_UNSAFE",
      "maintenance entrypoint is outside the immutable release tree",
    );
  }
  for (const directory of [
    "/opt",
    "/opt/fanjin-release-controller",
    RELEASE_FULL_MAINTENANCE_RELEASES_DIRECTORY,
    path.posix.join(RELEASE_FULL_MAINTENANCE_RELEASES_DIRECTORY, segments[0]),
    path.posix.dirname(entrypointPath),
  ]) {
    assertCanonicalTrustedDirectory({ system: input.system, directory });
  }
  const metadata = input.system.lstat(entrypointPath);
  if (
    input.system.realpath(entrypointPath) !== entrypointPath
    || metadata.type !== "file"
    || metadata.uid !== 0
    || metadata.gid !== 0
    || metadata.mode !== 0o444
    || metadata.nlink !== 1
    || metadata.size < 1n
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_ENTRYPOINT_UNSAFE",
      "maintenance entrypoint is not an immutable installed file",
    );
  }
  return entrypointPath;
}

function sameLockIdentity(
  left: ReleaseFullMaintenanceProcessFileIdentity,
  right: ReleaseFullMaintenanceProcessFileIdentity,
): boolean {
  return left.type === right.type
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs;
}

function assertKernelLockOwner(input: {
  system: ReleaseFullMaintenanceProcessLockSystem;
  lock: ReleaseFullMaintenanceProcessFileIdentity;
}): number {
  const matchingFileDescriptors: number[] = [];
  for (const fileDescriptor of input.system.listOpenFileDescriptors()) {
    try {
      const opened = input.system.fstat(fileDescriptor);
      if (opened.dev === input.lock.dev && opened.ino === input.lock.ino) {
        matchingFileDescriptors.push(fileDescriptor);
      }
    } catch {
      // /proc/self/fd is a live view; unrelated descriptors may close while
      // it is being inspected. The inherited flock descriptor must remain.
    }
  }
  if (matchingFileDescriptors.length !== 1) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_NOT_HELD",
      "maintenance process does not own exactly one inherited lock descriptor",
    );
  }
  const lockLineRe = /^(?:[1-9][0-9]*):\s+FLOCK\s+ADVISORY\s+WRITE\s+(-?[0-9]+)\s+([0-9a-f]+):([0-9a-f]+):([0-9]+)\s+0\s+EOF$/iu;
  const ownsKernelLock = input.system.readProcLocks().split(/\r?\n/u).some((line) => {
    const match = lockLineRe.exec(line);
    return match !== null
      && Number(match[1]) === input.system.processId
      && BigInt(`0x${match[2]}`) === input.lock.devMajor
      && BigInt(`0x${match[3]}`) === input.lock.devMinor
      && BigInt(match[4]) === input.lock.ino;
  });
  if (!ownsKernelLock) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_NOT_HELD",
      "maintenance process is not the kernel flock owner",
    );
  }
  return matchingFileDescriptors[0];
}

/**
 * Earliest formal-entrypoint barrier. It trusts neither environment markers
 * nor a long-lived wrapper parent: util-linux flock --no-fork execs Node and
 * leaves the exclusive lock descriptor in this exact process.
 */
function assertReleaseFullMaintenanceProcessLockInternal(input: {
  entrypoint: ReleaseFullMaintenanceLockedEntrypoint;
  system?: ReleaseFullMaintenanceProcessLockSystem;
}): ReleaseFullMaintenanceProcessLockEvidence {
  const system = input.system ?? productionSystem();
  if (system.platform !== "linux") {
    fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_LINUX_REQUIRED",
      "formal full-maintenance execution requires Linux",
    );
  }
  if (system.effectiveUid !== 0) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_ROOT_REQUIRED",
      "formal full-maintenance execution requires root",
    );
  }
  assertCanonicalTrustedExecutable({
    system,
    filePath: RELEASE_FULL_MAINTENANCE_FLOCK_EXECUTABLE,
  });
  assertCanonicalTrustedExecutable({ system, filePath: TRUE_EXECUTABLE });
  assertCanonicalTrustedExecutable({
    system,
    filePath: RELEASE_FULL_MAINTENANCE_NODE_EXECUTABLE,
  });
  assertCanonicalTrustedExecutable({
    system,
    filePath: RELEASE_FULL_MAINTENANCE_SYSTEMCTL_EXECUTABLE,
  });
  const entrypointPath = expectedEntrypointPath({ system, entrypoint: input.entrypoint });
  assertCanonicalLockDirectory(system);
  const before = system.lstat(RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_PATH);
  if (
    system.realpath(RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_PATH)
      !== RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_PATH
    || before.type !== "file"
    || before.uid !== 0
    || before.gid !== 0
    || before.mode !== 0o600
    || before.nlink !== 1
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_UNSAFE",
      "full-maintenance lock file is not root:root 0600 single-link regular file",
    );
  }
  const inheritedLockFileDescriptor = assertKernelLockOwner({ system, lock: before });
  const probe = system.probeExclusiveLock(RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_PATH);
  if (probe === "available") {
    fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_NOT_HELD",
      "an independent exclusive lock probe unexpectedly succeeded",
    );
  }
  if (probe !== "contended") {
    fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_PROBE_FAILED",
      "independent exclusive lock probe could not prove contention",
    );
  }
  const after = system.lstat(RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_PATH);
  const opened = system.fstat(inheritedLockFileDescriptor);
  if (!sameLockIdentity(before, after) || !sameLockIdentity(before, opened)) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_CHANGED",
      "full-maintenance lock identity changed during verification",
    );
  }
  const processBoundary = assertSystemdProcessBoundary({
    system,
    entrypointPath,
    lock: before,
  });
  return Object.freeze({
    format: "fanjin-release-full-maintenance-process-lock/v2",
    lockPath: RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_PATH,
    entrypoint: input.entrypoint,
    entrypointPath,
    processId: system.processId,
    inheritedLockFileDescriptor,
    lockDevice: before.dev.toString(10),
    lockInode: before.ino.toString(10),
    ...processBoundary,
  });
}

export function assertReleaseFullMaintenanceProcessLock(input: {
  entrypoint: ReleaseFullMaintenanceLockedEntrypoint;
  system?: ReleaseFullMaintenanceProcessLockSystem;
}): ReleaseFullMaintenanceProcessLockEvidence {
  try {
    return assertReleaseFullMaintenanceProcessLockInternal(input);
  } catch (error) {
    if (error instanceof ReleaseFullMaintenanceProcessLockError) throw error;
    return fail(
      "RELEASE_FULL_MAINTENANCE_PROCESS_LOCK_VERIFICATION_FAILED",
      "full-maintenance process lock verification could not complete",
    );
  }
}
