import fs from "node:fs";

import { candidateExactAuthorizationCanonicalJson } from "./candidateExactAuthorizationCanonical";

export const FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FORMAT =
  "fanjin-formal-candidate-credential-capability/v1" as const;
export const FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_PURPOSE =
  "provider-upstream-dispatch" as const;
export const FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD = 6 as const;
export const FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_TTL_MS = 60_000;

const MAGIC = Buffer.from("FJCRD001", "ascii");
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 48 * 1024;
const MAX_GRANTS = 64;
const MAX_CREDENTIAL_BYTES = 1024;
const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const BINDING = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u;
const RUNTIME_CAPABILITY = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_RUNTIME_CAPABILITIES = 64;
const ENDPOINT_TYPES = new Set([
  "audio_generation",
  "embedding",
  "image_generation",
  "multimodal_embedding",
  "rerank",
  "text",
  "video_generation",
  "video_upscale",
]);
const consumedNonces = new Set<string>();
const runtimePlatform = process.platform;
const runtimeGetuid = typeof process.getuid === "function"
  ? process.getuid.bind(process)
  : null;
const runtimeGetgid = typeof process.getgid === "function"
  ? process.getgid.bind(process)
  : null;
const runtimeNow = Date.now.bind(Date);

export class FormalCandidateCredentialCapabilityError extends Error {
  constructor(
    public readonly code: string,
    public readonly causes: readonly unknown[] = [],
  ) {
    super(code);
    this.name = "FormalCandidateCredentialCapabilityError";
  }
}

function fail(code: string): never {
  throw new FormalCandidateCredentialCapabilityError(code);
}

type CredentialGrantHeader = Readonly<{
  channelId: string;
  provider: string;
  endpointTypes: readonly string[];
  models: readonly string[];
  maximumUses: number;
  credentialByteLength: number;
}>;

type CredentialEnvelopeHeader = Readonly<{
  format: typeof FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FORMAT;
  purpose: typeof FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_PURPOSE;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  sessionBinding: string;
  candidateBinding: string;
  runtimeUid: number;
  runtimeGid: number;
  runtimeCapabilities: readonly string[];
  grants: readonly CredentialGrantHeader[];
}>;

export type FormalCandidateCredentialGrantInput = Readonly<{
  channelId: string;
  provider: string;
  endpointTypes: readonly string[];
  models: readonly string[];
  maximumUses: number;
  credential: string;
}>;

export type FormalCandidateCredentialEnvelopeInput = Readonly<{
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  sessionBinding: string;
  candidateBinding: string;
  runtimeUid: number;
  runtimeGid: number;
  runtimeCapabilities: readonly string[];
  grants: readonly FormalCandidateCredentialGrantInput[];
}>;

export type FormalCandidateCredentialExpectation = Readonly<{
  sessionBinding: string;
  candidateBinding: string;
  runtimeUid: number;
  runtimeGid: number;
  runtimeCapabilities: readonly string[];
}>;

export type FormalCandidateCredentialRequest = Readonly<{
  channelId: string;
  provider: string;
  endpointType: string;
  model: string;
}>;

export type FormalCandidateCredentialCapability = Readonly<{
  format: typeof FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FORMAT;
  withCredential: <T>(
    request: FormalCandidateCredentialRequest,
    use: (credential: string) => T,
  ) => T;
  dispose: () => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === "string" && expected.includes(key))
    && expected.every((key) => keys.includes(key))
    && keys.every((key) => {
      const descriptor = descriptors[String(key)];
      return Boolean(descriptor && "value" in descriptor && descriptor.enumerable);
    });
}

function parseExpectation(value: unknown): FormalCandidateCredentialExpectation {
  if (!isRecord(value) || !exactKeys(value, [
    "candidateBinding", "runtimeCapabilities", "runtimeGid", "runtimeUid",
    "sessionBinding",
  ])) return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_EXPECTATION_INVALID");
  if (
    typeof value.sessionBinding !== "string"
    || !BINDING.test(value.sessionBinding)
    || typeof value.candidateBinding !== "string"
    || !BINDING.test(value.candidateBinding)
    || !Number.isSafeInteger(value.runtimeUid)
    || Number(value.runtimeUid) <= 0
    || !Number.isSafeInteger(value.runtimeGid)
    || Number(value.runtimeGid) <= 0
  ) return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_EXPECTATION_INVALID");
  const runtimeCapabilities = exactRuntimeCapabilities(
    value.runtimeCapabilities,
    "FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_EXPECTATION_INVALID",
  );
  return Object.freeze({
    sessionBinding: value.sessionBinding,
    candidateBinding: value.candidateBinding,
    runtimeUid: Number(value.runtimeUid),
    runtimeGid: Number(value.runtimeGid),
    runtimeCapabilities: Object.freeze(runtimeCapabilities),
  });
}

function exactRuntimeCapabilities(value: unknown, code: string): string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_RUNTIME_CAPABILITIES
    || value.some((entry) => typeof entry !== "string" || !RUNTIME_CAPABILITY.test(entry))
    || new Set(value).size !== value.length
  ) return fail(code);
  const sorted = [...value].sort((left, right) => left.localeCompare(right, "en"));
  if (sorted.some((entry, index) => entry !== value[index])) return fail(code);
  return sorted;
}

function exactStringArray(value: unknown, allowed?: ReadonlySet<string>): string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.some((entry) => typeof entry !== "string" || !SAFE_ID.test(entry))
    || new Set(value).size !== value.length
    || value.some((entry) => allowed && !allowed.has(entry))
  ) fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_SCOPE_INVALID");
  const sorted = [...value].sort((left, right) => left.localeCompare(right, "en"));
  if (sorted.some((entry, index) => entry !== value[index])) {
    return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_SCOPE_INVALID");
  }
  return sorted;
}

function parseGrantHeader(value: unknown): CredentialGrantHeader {
  if (!isRecord(value) || !exactKeys(value, [
    "channelId",
    "credentialByteLength",
    "endpointTypes",
    "maximumUses",
    "models",
    "provider",
  ])) fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_GRANT_INVALID");
  if (
    typeof value.channelId !== "string"
    || !SAFE_ID.test(value.channelId)
    || typeof value.provider !== "string"
    || !SAFE_ID.test(value.provider)
    || !Number.isSafeInteger(value.maximumUses)
    || Number(value.maximumUses) < 1
    || Number(value.maximumUses) > 10_000
    || !Number.isSafeInteger(value.credentialByteLength)
    || Number(value.credentialByteLength) < 8
    || Number(value.credentialByteLength) > MAX_CREDENTIAL_BYTES
  ) fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_GRANT_INVALID");
  const endpointTypes = exactStringArray(value.endpointTypes, ENDPOINT_TYPES);
  const models = exactStringArray(value.models);
  if (endpointTypes.length !== 1 || models.length !== 1) {
    return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_SCOPE_INVALID");
  }
  return Object.freeze({
    channelId: value.channelId,
    provider: value.provider,
    endpointTypes: Object.freeze(endpointTypes),
    models: Object.freeze(models),
    maximumUses: Number(value.maximumUses),
    credentialByteLength: Number(value.credentialByteLength),
  });
}

function parseHeader(value: unknown): CredentialEnvelopeHeader {
  if (!isRecord(value) || !exactKeys(value, [
    "candidateBinding",
    "expiresAtMs",
    "format",
    "grants",
    "issuedAtMs",
    "nonce",
    "purpose",
    "runtimeCapabilities",
    "runtimeGid",
    "runtimeUid",
    "sessionBinding",
  ])) fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_HEADER_INVALID");
  if (
    value.format !== FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FORMAT
    || value.purpose !== FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_PURPOSE
    || typeof value.nonce !== "string"
    || !NONCE.test(value.nonce)
    || typeof value.sessionBinding !== "string"
    || !BINDING.test(value.sessionBinding)
    || typeof value.candidateBinding !== "string"
    || !BINDING.test(value.candidateBinding)
    || !Number.isSafeInteger(value.issuedAtMs)
    || !Number.isSafeInteger(value.expiresAtMs)
    || Number(value.expiresAtMs) <= Number(value.issuedAtMs)
    || Number(value.expiresAtMs) - Number(value.issuedAtMs)
      > FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_TTL_MS
    || !Number.isSafeInteger(value.runtimeUid)
    || Number(value.runtimeUid) <= 0
    || !Number.isSafeInteger(value.runtimeGid)
    || Number(value.runtimeGid) <= 0
    || !Array.isArray(value.grants)
    || value.grants.length < 1
    || value.grants.length > MAX_GRANTS
  ) fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_HEADER_INVALID");
  const grants = value.grants.map(parseGrantHeader);
  const runtimeCapabilities = exactRuntimeCapabilities(
    value.runtimeCapabilities,
    "FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_HEADER_INVALID",
  );
  const scopeKeys = grants.map((grant) => [
    grant.provider,
    grant.channelId,
    grant.endpointTypes[0],
    grant.models[0],
  ].join("\0"));
  if (new Set(scopeKeys).size !== scopeKeys.length) {
    return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_SCOPE_INVALID");
  }
  return Object.freeze({
    format: FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FORMAT,
    purpose: FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_PURPOSE,
    nonce: value.nonce,
    issuedAtMs: Number(value.issuedAtMs),
    expiresAtMs: Number(value.expiresAtMs),
    sessionBinding: value.sessionBinding,
    candidateBinding: value.candidateBinding,
    runtimeUid: Number(value.runtimeUid),
    runtimeGid: Number(value.runtimeGid),
    runtimeCapabilities: Object.freeze(runtimeCapabilities),
    grants: Object.freeze(grants),
  });
}

function assertCredentialString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (
    value !== value.trim()
    || bytes.byteLength < 8
    || bytes.byteLength > MAX_CREDENTIAL_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    bytes.fill(0);
    return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_CREDENTIAL_INVALID");
  }
  return bytes;
}

function assertCredentialBytes(bytes: Buffer): void {
  const value = bytes.toString("utf8");
  const roundTrip = Buffer.from(value, "utf8");
  try {
    if (
      !roundTrip.equals(bytes)
      || value !== value.trim()
      || bytes.byteLength < 8
      || bytes.byteLength > MAX_CREDENTIAL_BYTES
      || /[\u0000-\u001f\u007f]/u.test(value)
    ) return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_CREDENTIAL_INVALID");
  } finally {
    roundTrip.fill(0);
  }
}

export function encodeFormalCandidateCredentialEnvelope(
  input: FormalCandidateCredentialEnvelopeInput,
): Buffer {
  const credentialBuffers: Buffer[] = [];
  try {
    const rawHeader = {
      format: FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FORMAT,
      purpose: FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_PURPOSE,
      nonce: input.nonce,
      issuedAtMs: input.issuedAtMs,
      expiresAtMs: input.expiresAtMs,
      sessionBinding: input.sessionBinding,
      candidateBinding: input.candidateBinding,
      runtimeUid: input.runtimeUid,
      runtimeGid: input.runtimeGid,
      runtimeCapabilities: input.runtimeCapabilities,
      grants: input.grants.map((grant) => {
        const credential = assertCredentialString(grant.credential);
        credentialBuffers.push(credential);
        return {
          channelId: grant.channelId,
          provider: grant.provider,
          endpointTypes: grant.endpointTypes,
          models: grant.models,
          maximumUses: grant.maximumUses,
          credentialByteLength: credential.byteLength,
        };
      }),
    };
    const header = parseHeader(rawHeader);
    const headerBytes = Buffer.from(
      candidateExactAuthorizationCanonicalJson(header),
      "utf8",
    );
    if (headerBytes.byteLength > MAX_HEADER_BYTES) {
      return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_TOO_LARGE");
    }
    const total = MAGIC.byteLength + 4 + headerBytes.byteLength
      + credentialBuffers.reduce((sum, value) => sum + value.byteLength, 0);
    if (total > MAX_ENVELOPE_BYTES) {
      return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_TOO_LARGE");
    }
    const output = Buffer.allocUnsafe(total);
    let offset = 0;
    MAGIC.copy(output, offset);
    offset += MAGIC.byteLength;
    output.writeUInt32BE(headerBytes.byteLength, offset);
    offset += 4;
    headerBytes.copy(output, offset);
    offset += headerBytes.byteLength;
    for (const credential of credentialBuffers) {
      credential.copy(output, offset);
      offset += credential.byteLength;
    }
    headerBytes.fill(0);
    return output;
  } finally {
    for (const credential of credentialBuffers) credential.fill(0);
  }
}

function consumeEnvelopeBytes(
  source: Buffer,
  rawExpected: FormalCandidateCredentialExpectation,
  nowMs: number,
): FormalCandidateCredentialCapability {
  let expected: FormalCandidateCredentialExpectation;
  try {
    expected = parseExpectation(rawExpected);
  } catch (error) {
    source.fill(0);
    throw error;
  }
  if (source.byteLength < MAGIC.byteLength + 4 || source.byteLength > MAX_ENVELOPE_BYTES) {
    source.fill(0);
    return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_SIZE_INVALID");
  }
  let headerBytes: Buffer | null = null;
  const secrets: Buffer[] = [];
  try {
    if (!source.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_MAGIC_INVALID");
    }
    const headerLength = source.readUInt32BE(MAGIC.byteLength);
    const headerStart = MAGIC.byteLength + 4;
    const headerEnd = headerStart + headerLength;
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || headerEnd > source.byteLength) {
      return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_SIZE_INVALID");
    }
    headerBytes = Buffer.from(source.subarray(headerStart, headerEnd));
    let parsed: unknown;
    try {
      parsed = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_HEADER_INVALID");
    }
    const header = parseHeader(parsed);
    if (candidateExactAuthorizationCanonicalJson(header) !== headerBytes.toString("utf8")) {
      return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_HEADER_INVALID");
    }
    if (
      !Number.isSafeInteger(nowMs)
      || nowMs < header.issuedAtMs
      || nowMs >= header.expiresAtMs
    ) return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_TIME_INVALID");
    if (
      header.purpose !== FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_PURPOSE
      || header.sessionBinding !== expected.sessionBinding
      || header.candidateBinding !== expected.candidateBinding
      || header.runtimeUid !== expected.runtimeUid
      || header.runtimeGid !== expected.runtimeGid
      || candidateExactAuthorizationCanonicalJson(header.runtimeCapabilities)
        !== candidateExactAuthorizationCanonicalJson(expected.runtimeCapabilities)
    ) return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_BINDING_MISMATCH");
    if (consumedNonces.has(header.nonce)) {
      return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_REPLAY_REJECTED");
    }
    if (consumedNonces.size >= 1024) {
      return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_REPLAY_CAPACITY_EXCEEDED");
    }
    let offset = headerEnd;
    for (const grant of header.grants) {
      const end = offset + grant.credentialByteLength;
      if (end > source.byteLength) {
        return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_SIZE_INVALID");
      }
      const secret = Buffer.from(source.subarray(offset, end));
      try {
        assertCredentialBytes(secret);
      } catch (error) {
        secret.fill(0);
        throw error;
      }
      secrets.push(secret);
      offset = end;
    }
    if (offset !== source.byteLength) {
      return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_TRAILING_BYTES");
    }
    consumedNonces.add(header.nonce);
    const remainingUses = header.grants.map((grant) => grant.maximumUses);
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      for (const secret of secrets) secret.fill(0);
      remainingUses.fill(0);
    };
    return Object.freeze({
      format: FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FORMAT,
      withCredential<T>(
        request: FormalCandidateCredentialRequest,
        use: (credential: string) => T,
      ): T {
        if (disposed) return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_DISPOSED");
        const currentTimeMs = runtimeNow();
        if (
          !Number.isSafeInteger(currentTimeMs)
          || currentTimeMs < header.issuedAtMs
          || currentTimeMs >= header.expiresAtMs
        ) {
          dispose();
          return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_TIME_INVALID");
        }
        if (!isRecord(request) || !exactKeys(request, [
          "channelId", "endpointType", "model", "provider",
        ])
          || typeof request.channelId !== "string"
          || !SAFE_ID.test(request.channelId)
          || typeof request.provider !== "string"
          || !SAFE_ID.test(request.provider)
          || typeof request.endpointType !== "string"
          || !ENDPOINT_TYPES.has(request.endpointType)
          || typeof request.model !== "string"
          || !SAFE_ID.test(request.model)
          || typeof use !== "function") {
          return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_REQUEST_INVALID");
        }
        const index = header.grants.findIndex((grant) => (
          grant.channelId === request.channelId
          && grant.provider === request.provider
          && grant.endpointTypes[0] === request.endpointType
          && grant.models[0] === request.model
        ));
        if (index < 0 || remainingUses[index] <= 0) {
          return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_SCOPE_DENIED");
        }
        remainingUses[index] -= 1;
        // JavaScript strings cannot be reliably zeroized.  The only supported
        // exposure is this synchronous callback; callers must not retain the
        // argument.  Thenables are rejected so the credential cannot cross an
        // async boundary through this API (a malicious callback can still copy
        // its argument, so the signed runtime remains part of the trust base).
        let credential = secrets[index].toString("utf8");
        try {
          const result = use(credential);
          let then: unknown;
          try {
            then = result !== null
              && (typeof result === "object" || typeof result === "function")
              ? (result as { then?: unknown }).then
              : undefined;
          } catch {
            return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_ASYNC_FORBIDDEN");
          }
          if (typeof then === "function") {
            return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_ASYNC_FORBIDDEN");
          }
          return result;
        } finally {
          credential = "";
        }
      },
      dispose,
    });
  } catch (error) {
    for (const secret of secrets) secret.fill(0);
    throw error;
  } finally {
    headerBytes?.fill(0);
    source.fill(0);
  }
}

type CredentialFdOperations = Readonly<{
  fstatSync: (fd: number) => fs.Stats;
  readSync: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  closeSync: (fd: number) => void;
  onCapability?: (capability: FormalCandidateCredentialCapability) => void;
}>;

const REAL_FD_OPERATIONS: CredentialFdOperations = Object.freeze({
  fstatSync: (fd) => fs.fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) =>
    fs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
});

function readAllFromFd(fd: number, operations: CredentialFdOperations): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.alloc(4096);
      const count = operations.readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) {
        chunk.fill(0);
        break;
      }
      total += count;
      if (total > MAX_ENVELOPE_BYTES) {
        chunk.fill(0);
        return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_TOO_LARGE");
      }
      chunks.push(chunk.subarray(0, count));
      if (count < chunk.byteLength) chunk.subarray(count).fill(0);
    }
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function consumeFromFd(
  fd: number,
  expected: FormalCandidateCredentialExpectation,
  nowMs: number,
  ownerUid: number,
  operations: CredentialFdOperations = REAL_FD_OPERATIONS,
): FormalCandidateCredentialCapability {
  if (!Number.isSafeInteger(fd) || fd < 3) {
    return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD_INVALID");
  }
  let output: FormalCandidateCredentialCapability | null = null;
  let failure: unknown = null;
  try {
    let metadata: fs.Stats;
    try {
      metadata = operations.fstatSync(fd);
    } catch {
      return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD_STAT_FAILED");
    }
    if (
      // Node may implement an anonymous stdio channel as a pipe or socketpair.
      (!metadata.isFIFO() && !metadata.isSocket())
      || metadata.uid !== ownerUid
      // Anonymous pipes report nlink=0 on Darwin and commonly nlink=1 on Linux.
      || (metadata.nlink !== 0 && metadata.nlink !== 1)
    ) return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD_UNTRUSTED");
    try {
      output = consumeEnvelopeBytes(readAllFromFd(fd, operations), expected, nowMs);
      operations.onCapability?.(output);
    } catch (error) {
      failure = error instanceof FormalCandidateCredentialCapabilityError
        ? error
        : new FormalCandidateCredentialCapabilityError(
          "FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD_READ_FAILED",
        );
    }
  } catch (error) {
    failure = error;
  }
  try {
    operations.closeSync(fd);
  } catch (error) {
    failure = new FormalCandidateCredentialCapabilityError(
      "FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD_CLOSE_FAILED",
      failure === null ? [error] : [failure, error],
    );
  }
  if (failure) {
    if (output) {
      try {
        output.dispose();
      } catch (disposeError) {
        failure = new FormalCandidateCredentialCapabilityError(
          "FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD_FAILURE_CLEANUP_FAILED",
          [failure, disposeError],
        );
      }
      output = null;
    }
    throw failure;
  }
  if (!output) return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD_READ_FAILED");
  return output;
}

export function consumeFormalCandidateCredentialCapabilityFromFixedFd(
  expected: FormalCandidateCredentialExpectation,
): FormalCandidateCredentialCapability {
  if (arguments.length !== 1) {
    return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_ARGUMENTS_INVALID");
  }
  const normalized = parseExpectation(expected);
  if (runtimePlatform !== "linux") {
    return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_LINUX_REQUIRED");
  }
  if (
    runtimeGetuid === null
    || runtimeGetgid === null
    || runtimeGetuid() !== normalized.runtimeUid
    || runtimeGetgid() !== normalized.runtimeGid
  ) return fail("FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_RUNTIME_IDENTITY_MISMATCH");
  return consumeFromFd(
    FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD,
    normalized,
    runtimeNow(),
    0,
  );
}

/** Current-uid fixture contract; never imported by a production entrypoint. */
export function consumeFormalCandidateCredentialCapabilityFromFixedFdForCurrentUidFixture(
  expected: FormalCandidateCredentialExpectation,
  nowMs = Date.now(),
): FormalCandidateCredentialCapability {
  // The fixture contract validates anonymous-channel semantics only.  The
  // production export above independently pins the descriptor owner to root.
  const uid = fs.fstatSync(FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD).uid;
  return consumeFromFd(
    FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD,
    expected,
    nowMs,
    uid,
  );
}

/** Byte-only fixture parser; production wiring must use the fixed-FD export. */
export function consumeFormalCandidateCredentialCapabilityBytesForFixture(
  bytes: Buffer,
  expected: FormalCandidateCredentialExpectation,
  nowMs: number,
): FormalCandidateCredentialCapability {
  return consumeEnvelopeBytes(bytes, expected, nowMs);
}

/** Operation-injected close-once contract used only by zero-secret fixtures. */
export function consumeFormalCandidateCredentialCapabilityFdOperationsForFixture(
  fd: number,
  expected: FormalCandidateCredentialExpectation,
  nowMs: number,
  ownerUid: number,
  operations: CredentialFdOperations,
): FormalCandidateCredentialCapability {
  return consumeFromFd(fd, expected, nowMs, ownerUid, operations);
}
