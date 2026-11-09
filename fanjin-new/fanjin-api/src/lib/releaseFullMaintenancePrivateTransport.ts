import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export const RELEASE_FULL_MAINTENANCE_PRIVATE_TRANSPORT_FORMAT =
  "fanjin-release-full-maintenance-private-transport/ssh-loopback-v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_NODE_PROOF_FORMAT =
  "fanjin-release-full-maintenance-private-node-proof/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SAFE_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/u;
const MAX_SSH_OUTPUT_BYTES = 128 * 1024;
const REMOTE_LOOPBACK_PORT = 10_588;

export class ReleaseFullMaintenancePrivateTransportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseFullMaintenancePrivateTransportError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseFullMaintenancePrivateTransportError(code, message);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  )).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function exactAbsoluteFile(input: {
  filePath: unknown;
  label: string;
  expectedUid?: number;
  allowedModes: readonly number[];
}): string {
  if (
    typeof input.filePath !== "string"
    || !path.isAbsolute(input.filePath)
    || path.normalize(input.filePath) !== input.filePath
    || input.filePath === path.parse(input.filePath).root
    || /[\0\r\n]/u.test(input.filePath)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_INVALID", `${input.label} path is invalid`);
  let resolved: string;
  try {
    resolved = realpathSync(input.filePath);
  } catch {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_UNAVAILABLE", `${input.label} is unavailable`);
  }
  if (resolved !== input.filePath) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_INVALID", `${input.label} must not traverse a symlink`);
  }
  const stat = lstatSync(resolved);
  const mode = stat.mode & 0o777;
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || !input.allowedModes.includes(mode)
    || (input.expectedUid !== undefined && stat.uid !== input.expectedUid)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_INVALID", `${input.label} ownership or mode is unsafe`);
  return resolved;
}

export type ReleaseFullMaintenancePrivateTransportConfig = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_TRANSPORT_FORMAT;
  sshBinary: "/usr/bin/ssh";
  nodeAgentIdentityFile: string;
  tunnelIdentityFile: string;
  knownHostsFile: string;
  nodeAgentUser: "fanjin-release";
  tunnelUser: "fanjin-private-validation";
  port: 22;
  connectTimeoutSeconds: number;
  startupTimeoutMs: number;
}>;

export type ReleaseFullMaintenancePrivateTransportNode = Readonly<{
  nodeId: string;
  privateHost: string;
  activationBindingSha256: string;
}>;

export type ReleaseFullMaintenancePrivateTransportTarget = Readonly<{
  deploymentId: string;
  releaseId: string;
  artifactSha256: string;
  sourceCommit: string;
  schemaVersion: 48;
  imageDigest: string;
}>;

export type ReleaseFullMaintenancePrivateNodeProof = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_NODE_PROOF_FORMAT;
  deploymentId: string;
  nodeId: string;
  hostnameSha256: string;
  sshHostKeySha256: string;
  activationBindingSha256: string;
  releaseId: string;
  artifactSha256: string;
  sourceCommit: string;
  schemaVersion: 48;
  imageDigest: string;
  runtimeIdentityKind: "node-agent-current+readiness+ssh-host-key";
  runtimeIdentitySha256: string;
}>;

export interface ReleaseFullMaintenancePrivateNodeTunnel {
  readonly nodeId: string;
  readonly loopbackOrigin: string;
  readonly proof: ReleaseFullMaintenancePrivateNodeProof;
  close(): Promise<void>;
}

export interface ReleaseFullMaintenancePrivateTransport {
  open(input: {
    nodes: readonly ReleaseFullMaintenancePrivateTransportNode[];
    target: ReleaseFullMaintenancePrivateTransportTarget;
    signal: AbortSignal;
  }): Promise<readonly ReleaseFullMaintenancePrivateNodeTunnel[]>;
  close(): Promise<void>;
}

export function assertDistinctReleaseFullMaintenancePrivateNodeProofs(
  proofs: readonly ReleaseFullMaintenancePrivateNodeProof[],
): void {
  if (!Array.isArray(proofs) || proofs.length < 1) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID", "private node proof inventory is empty");
  }
  const hostKeys = proofs.map((proof) => proof.sshHostKeySha256);
  const hostnames = proofs.map((proof) => proof.hostnameSha256);
  const runtimeIdentities = proofs.map((proof) => proof.runtimeIdentitySha256);
  if (
    new Set(hostKeys).size !== proofs.length
    || new Set(hostnames).size !== proofs.length
    || new Set(runtimeIdentities).size !== proofs.length
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID",
    "two private addresses resolve to the same proven node identity",
  );
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ReleaseFullMaintenancePrivateTransportDependencies = Readonly<{
  spawnProcess?: SpawnProcess;
  reserveLoopbackPort?: () => Promise<number>;
  waitForLoopbackPort?: (port: number, child: ChildProcess, timeoutMs: number, signal: AbortSignal) => Promise<void>;
}>;

export function assertReleaseFullMaintenancePrivateTransportConfig(input: {
  value: unknown;
  expectedUid?: number;
}): ReleaseFullMaintenancePrivateTransportConfig {
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_INVALID", "transport config is missing");
  }
  const value = input.value as Record<string, unknown>;
  const expectedKeys = [
    "connectTimeoutSeconds",
    "format",
    "knownHostsFile",
    "nodeAgentIdentityFile",
    "nodeAgentUser",
    "port",
    "sshBinary",
    "startupTimeoutMs",
    "tunnelIdentityFile",
    "tunnelUser",
  ].sort();
  if (Object.keys(value).sort().join(",") !== expectedKeys.join(",")) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_INVALID", "transport config has unexpected fields");
  }
  if (
    value.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_TRANSPORT_FORMAT
    || value.sshBinary !== "/usr/bin/ssh"
    || value.nodeAgentUser !== "fanjin-release"
    || value.tunnelUser !== "fanjin-private-validation"
    || value.port !== 22
    || !Number.isSafeInteger(value.connectTimeoutSeconds)
    || Number(value.connectTimeoutSeconds) < 1
    || Number(value.connectTimeoutSeconds) > 30
    || !Number.isSafeInteger(value.startupTimeoutMs)
    || Number(value.startupTimeoutMs) < 1_000
    || Number(value.startupTimeoutMs) > 60_000
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_INVALID", "transport policy is invalid");
  exactAbsoluteFile({
    filePath: value.sshBinary,
    label: "ssh binary",
    allowedModes: [0o755, 0o555],
  });
  const nodeAgentIdentityFile = exactAbsoluteFile({
    filePath: value.nodeAgentIdentityFile,
    label: "node-agent identity",
    expectedUid: input.expectedUid,
    allowedModes: [0o600, 0o400],
  });
  const tunnelIdentityFile = exactAbsoluteFile({
    filePath: value.tunnelIdentityFile,
    label: "validation tunnel identity",
    expectedUid: input.expectedUid,
    allowedModes: [0o600, 0o400],
  });
  if (nodeAgentIdentityFile === tunnelIdentityFile) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_INVALID",
      "validation tunnel must use a distinct forwarding-only identity",
    );
  }
  const knownHostsFile = exactAbsoluteFile({
    filePath: value.knownHostsFile,
    label: "known_hosts",
    expectedUid: input.expectedUid,
    allowedModes: [0o600, 0o400],
  });
  return Object.freeze({
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_TRANSPORT_FORMAT,
    sshBinary: "/usr/bin/ssh",
    nodeAgentIdentityFile,
    tunnelIdentityFile,
    knownHostsFile,
    nodeAgentUser: "fanjin-release",
    tunnelUser: "fanjin-private-validation",
    port: 22,
    connectTimeoutSeconds: Number(value.connectTimeoutSeconds),
    startupTimeoutMs: Number(value.startupTimeoutMs),
  });
}

function hostKeySha256(knownHostsFile: string, host: string, port: number): string {
  const candidates = new Set([host, `[${host}]:${port}`]);
  const matches: Buffer[] = [];
  for (const raw of readFileSync(knownHostsFile, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/u);
    if (fields.length !== 3 || fields[0].startsWith("|") || fields[0].startsWith("@")) continue;
    if (!fields[0].split(",").some((candidate) => candidates.has(candidate))) continue;
    if (!["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "ssh-rsa"].includes(fields[1])) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_HOST_IDENTITY_INVALID", "known_hosts key type is unsupported");
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(fields[2], "base64");
    } catch {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_HOST_IDENTITY_INVALID", "known_hosts key is invalid");
    }
    if (decoded.length < 32 || decoded.toString("base64").replace(/=+$/u, "") !== fields[2].replace(/=+$/u, "")) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_HOST_IDENTITY_INVALID", "known_hosts key encoding is invalid");
    }
    matches.push(decoded);
  }
  const unique = [...new Set(matches.map((key) => createHash("sha256").update(key).digest("hex")))];
  if (unique.length !== 1) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_HOST_IDENTITY_INVALID", "private host must have one exact known_hosts identity");
  }
  return unique[0];
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  return Object.freeze({
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TZ: "UTC",
  });
}

function commonSshArguments(input: {
  config: ReleaseFullMaintenancePrivateTransportConfig;
  identityFile: string;
}): string[] {
  return [
    "-F", "/dev/null",
    "-T",
    "-p", String(input.config.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${input.config.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "IdentitiesOnly=yes",
    "-i", input.identityFile,
    "-o", `ConnectTimeout=${input.config.connectTimeoutSeconds}`,
    "-o", "ConnectionAttempts=1",
    "-o", "LogLevel=ERROR",
    "-o", "ForwardAgent=no",
    "-o", "RequestTTY=no",
    "-o", "ControlMaster=no",
    "-o", "ProxyCommand=none",
    "-o", "ProxyJump=none",
    "-o", "CanonicalizeHostname=no",
  ];
}

function collectBoundedProcess(input: {
  child: ChildProcess;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{ exitCode: number; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      input.child.kill("SIGKILL");
      finish(() => reject(new ReleaseFullMaintenancePrivateTransportError(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIMED_OUT",
        "node-agent identity proof was aborted",
      )));
    };
    const timer = setTimeout(() => {
      input.child.kill("SIGKILL");
      finish(() => reject(new ReleaseFullMaintenancePrivateTransportError(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_UNAVAILABLE",
        "node-agent identity proof timed out",
      )));
    }, input.timeoutMs);
    timer.unref?.();
    input.child.stdout?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_SSH_OUTPUT_BYTES) abort();
      else stdout.push(bytes);
    });
    input.child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_SSH_OUTPUT_BYTES) abort();
    });
    input.child.once("error", () => finish(() => reject(new ReleaseFullMaintenancePrivateTransportError(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_UNAVAILABLE",
      "SSH identity process failed",
    ))));
    input.child.once("close", (code) => finish(() => resolve({
      exitCode: Number.isInteger(code) ? Number(code) : -1,
      stdout: Buffer.concat(stdout),
    })));
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
  });
}

function exactNodeAgentProof(input: {
  raw: Buffer;
  node: ReleaseFullMaintenancePrivateTransportNode;
  target: ReleaseFullMaintenancePrivateTransportTarget;
  sshHostKeySha256: string;
}): ReleaseFullMaintenancePrivateNodeProof {
  const text = input.raw.toString("utf8").trim();
  if (!text || /[\r\n\uFFFD]/u.test(text)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID", "node-agent proof is not one canonical JSON line");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID", "node-agent proof is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID", "node-agent proof is invalid");
  }
  const envelope = parsed as Record<string, unknown>;
  const current = envelope.current as Record<string, unknown> | null;
  const readiness = envelope.readiness as Record<string, unknown> | null;
  const hostname = typeof envelope.hostname === "string" ? envelope.hostname.trim() : "";
  if (
    envelope.ok !== true
    || envelope.agentSchemaVersion !== 1
    || envelope.action !== "status"
    || envelope.nodeId !== input.node.nodeId
    || !hostname
    || hostname.length > 255
    || /[\0\r\n]/u.test(hostname)
    || !current
    || current.releaseId !== input.target.releaseId
    || current.artifactSha256 !== input.target.artifactSha256
    || current.sourceCommit !== input.target.sourceCommit
    || current.schemaVersion !== 48
    || current.deploymentMode !== "container-image"
    || current.imageDigest !== input.target.imageDigest
    || !readiness
    || readiness.ready !== true
    || readiness.matchesArtifact !== true
    || readiness.releaseIdentityMatchesManifest !== true
    || readiness.artifactSha256 !== input.target.artifactSha256
    || readiness.sourceCommit !== input.target.sourceCommit
    || readiness.schemaVersion !== 48
    || readiness.deploymentMode !== "container-image"
    || readiness.imageDigest !== input.target.imageDigest
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID", "node-agent proof differs from the exact activated target");
  const commitment = {
    deploymentId: input.target.deploymentId,
    nodeId: input.node.nodeId,
    hostnameSha256: digest({ hostname }),
    sshHostKeySha256: input.sshHostKeySha256,
    activationBindingSha256: input.node.activationBindingSha256,
    releaseId: input.target.releaseId,
    artifactSha256: input.target.artifactSha256,
    sourceCommit: input.target.sourceCommit,
    schemaVersion: 48 as const,
    imageDigest: input.target.imageDigest,
    current,
    readiness,
  };
  return Object.freeze({
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_NODE_PROOF_FORMAT,
    deploymentId: input.target.deploymentId,
    nodeId: input.node.nodeId,
    hostnameSha256: commitment.hostnameSha256,
    sshHostKeySha256: input.sshHostKeySha256,
    activationBindingSha256: input.node.activationBindingSha256,
    releaseId: input.target.releaseId,
    artifactSha256: input.target.artifactSha256,
    sourceCommit: input.target.sourceCommit,
    schemaVersion: 48,
    imageDigest: input.target.imageDigest,
    runtimeIdentityKind: "node-agent-current+readiness+ssh-host-key",
    runtimeIdentitySha256: digest(commitment),
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForLoopbackPort(
  port: number,
  child: ChildProcess,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIMED_OUT", "validation tunnel startup was aborted");
    if (child.exitCode !== null) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_UNAVAILABLE", "validation tunnel exited before readiness");
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(250, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_UNAVAILABLE", "validation tunnel did not become ready");
}

async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    timer.unref?.();
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export function createReleaseFullMaintenancePrivateTransport(input: {
  config: ReleaseFullMaintenancePrivateTransportConfig;
  dependencies?: ReleaseFullMaintenancePrivateTransportDependencies;
}): ReleaseFullMaintenancePrivateTransport {
  const spawnProcess = input.dependencies?.spawnProcess ?? ((command, args, options) => (
    spawn(command, [...args], options)
  ));
  const reservePort = input.dependencies?.reserveLoopbackPort ?? reserveLoopbackPort;
  const waitPort = input.dependencies?.waitForLoopbackPort ?? waitForLoopbackPort;
  const opened: ReleaseFullMaintenancePrivateNodeTunnel[] = [];
  const openOne = async (
    node: ReleaseFullMaintenancePrivateTransportNode,
    target: ReleaseFullMaintenancePrivateTransportTarget,
    signal: AbortSignal,
  ): Promise<ReleaseFullMaintenancePrivateNodeTunnel> => {
    if (
      !SAFE_NODE_ID.test(node.nodeId)
      || !SHA256.test(node.activationBindingSha256)
      || net.isIP(node.privateHost) !== 4
      || !node.privateHost.startsWith("10.0.")
      || !SAFE_USER.test(input.config.nodeAgentUser)
      || !SAFE_USER.test(input.config.tunnelUser)
      || !SHA256.test(target.artifactSha256)
      || !IMAGE_DIGEST.test(target.imageDigest)
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_INVALID", "private transport node or target is invalid");
    const sshHostKeySha256 = hostKeySha256(input.config.knownHostsFile, node.privateHost, input.config.port);
    const agentArgs = [
      ...commonSshArguments({ config: input.config, identityFile: input.config.nodeAgentIdentityFile }),
      "-o", "ClearAllForwardings=yes",
      "--", `${input.config.nodeAgentUser}@${node.privateHost}`, `status ${node.nodeId}`,
    ];
    const agentChild = spawnProcess(input.config.sshBinary, agentArgs, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: minimalEnvironment(),
    });
    const result = await collectBoundedProcess({
      child: agentChild,
      signal,
      timeoutMs: input.config.startupTimeoutMs,
    });
    if (result.exitCode !== 0) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID", "node-agent status failed");
    }
    const proof = exactNodeAgentProof({ raw: result.stdout, node, target, sshHostKeySha256 });
    const localPort = await reservePort();
    if (!Number.isInteger(localPort) || localPort < 1_024 || localPort > 65_535) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_UNAVAILABLE", "reserved loopback port is invalid");
    }
    const tunnelArgs = [
      ...commonSshArguments({ config: input.config, identityFile: input.config.tunnelIdentityFile }),
      "-o", "ClearAllForwardings=no",
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "PermitLocalCommand=no",
      "-L", `127.0.0.1:${localPort}:127.0.0.1:${REMOTE_LOOPBACK_PORT}`,
      "--", `${input.config.tunnelUser}@${node.privateHost}`,
    ];
    const tunnelChild = spawnProcess(input.config.sshBinary, tunnelArgs, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: minimalEnvironment(),
    });
    const abort = () => { void closeChild(tunnelChild); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await waitPort(localPort, tunnelChild, input.config.startupTimeoutMs, signal);
    } catch (error) {
      signal.removeEventListener("abort", abort);
      await closeChild(tunnelChild);
      throw error;
    }
    let closed = false;
    const tunnel: ReleaseFullMaintenancePrivateNodeTunnel = Object.freeze({
      nodeId: node.nodeId,
      loopbackOrigin: `http://127.0.0.1:${localPort}`,
      proof,
      close: async () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", abort);
        await closeChild(tunnelChild);
      },
    });
    opened.push(tunnel);
    return tunnel;
  };
  return {
    open: async ({ nodes, target, signal }) => {
      if (
        !Array.isArray(nodes)
        || nodes.length < 1
        || new Set(nodes.map(({ nodeId }) => nodeId)).size !== nodes.length
        || new Set(nodes.map(({ privateHost }) => privateHost)).size !== nodes.length
      ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TRANSPORT_INVALID", "private node inventory is invalid");
      const tunnels: ReleaseFullMaintenancePrivateNodeTunnel[] = [];
      try {
        for (const node of nodes) tunnels.push(await openOne(node, target, signal));
      } catch (error) {
        await Promise.allSettled(tunnels.map((tunnel) => tunnel.close()));
        throw error;
      }
      try {
        assertDistinctReleaseFullMaintenancePrivateNodeProofs(tunnels.map(({ proof }) => proof));
      } catch (error) {
        await Promise.allSettled(tunnels.map((tunnel) => tunnel.close()));
        throw error;
      }
      return Object.freeze([...tunnels]);
    },
    close: async () => {
      await Promise.allSettled(opened.splice(0).map((tunnel) => tunnel.close()));
    },
  };
}
