import { parseVolcengineVideoAuditResult } from "./volcengineImageXReview";
import crypto from "node:crypto";
import fs from "node:fs";

import {
  consumeFormalCandidateCredentialCapabilityFromFixedFd,
  FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD,
  type FormalCandidateCredentialCapability,
  type FormalCandidateCredentialExpectation,
  type FormalCandidateCredentialRequest,
} from "./formalCandidateCredentialCapability";
import {
  fetchProviderSubmissionWithFreshConnection,
} from "./providerSubmissionTransport";
import {
  parseProviderChannelImageXReviewCredential,
  PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_VERSION,
} from "./providerChannelCredentials";
import {
  FORMAL_CANDIDATE_PORTRAIT_IMAGEX_REVIEW_MODEL,
  PORTRAIT_IMAGEX_REVIEW_RUNTIME_CAPABILITY,
} from "./portraitRuntimeCapability";
import {
  type VolcengineImageAuditResult,
  type VolcengineImageFaceResult,
  VolcengineImageXReviewError,
  type VolcengineVideoAuditPollResult,
  type VolcengineVideoAuditSubmission,
} from "./volcengineImageXReview";
import {
  signVolcengineV4Get,
  signVolcengineV4JsonPost,
} from "./volcengineV4";
import { secretPurposeHmac } from "./secretEnvelope";

export const FORMAL_CANDIDATE_VIDEO_DISPATCH_LEASE_TTL_MS =
  45 * 60 * 1000;
const FORMAL_CANDIDATE_VIDEO_DISPATCH_MAX_POLLS = 256;
export const FORMAL_CANDIDATE_IMAGEX_REVIEW_LEASE_TTL_MS =
  20 * 60 * 1000;
export const FORMAL_CANDIDATE_IMAGEX_REVIEW_MAX_POLLS = 120;
const SAFE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;

const IMAGEX_REVIEW_HOST = "imagex.volcengineapi.com";
const IMAGEX_REVIEW_PATHNAME = "/";
const IMAGEX_REVIEW_REGION = "cn-north-1";
const IMAGEX_REVIEW_SERVICE = "imagex";
const IMAGEX_REVIEW_TASK_REGION = "cn";
const IMAGEX_REVIEW_VERSION = "2023-05-01";
const IMAGEX_REVIEW_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const IMAGEX_REVIEW_MAX_REQUEST_TIMEOUT_MS = 120_000;
const IMAGEX_REVIEW_CREDENTIAL_BINDING_PURPOSE =
  "provider-channel-imagex-review-binding/v1";
const SAFE_IMAGEX_DATA_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_IMAGEX_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const IMAGEX_VIDEO_AUDIT_DIMENSIONS = Object.freeze([
  "video_porn",
  "video_sensitive1",
  "video_sensitive2",
  "video_forbidden",
  "video_uncomfortable",
] as const);
const IMAGEX_IMAGE_AUDIT_DIMENSIONS = Object.freeze([
  "porn",
  "sensitive1",
  "sensitive2",
  "forbidden",
  "uncomfortable",
  "qrcode",
  "badpicture",
  "sexy",
  "underage",
] as const);

export type FormalCandidateVideoDispatchResult = Readonly<{
  response: Response;
  payload: Record<string, unknown>;
}>;

export type FormalCandidateVideoDispatchLease = Readonly<{
  operationId: string;
  request: FormalCandidateCredentialRequest;
  submitJson: (
    body: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<FormalCandidateVideoDispatchResult>;
  bindProviderTaskId: (providerTaskId: string) => void;
  pollJson: (timeoutMs: number) => Promise<FormalCandidateVideoDispatchResult>;
  cancelJson: (timeoutMs: number) => Promise<FormalCandidateVideoDispatchResult>;
  dispose: () => void;
}>;

export type FormalCandidateImageXReviewLeaseInput = Readonly<{
  request: FormalCandidateCredentialRequest;
  operationId: string;
  dataId: string;
  credentialGeneration: number;
  expectedCredentialBinding: string;
  sourceUrlHash?: string;
  /** Durable recovery may resume an already-created provider task. */
  taskId?: string | null;
  /** The only accepted initial marker is the sealed marker persisted for taskId. */
  marker?: string | null;
  /** Recovery supplies submittedAt + 20m; omission uses acquisition + 20m. */
  expiresAtMs?: number;
}>;

export type FormalCandidateImageXImageOperationInput = Readonly<{
  request: FormalCandidateCredentialRequest;
  operationId: string;
  imageUri: string;
  credentialGeneration: number;
  expectedCredentialBinding: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type FormalCandidateImageXImageAuditInput =
  FormalCandidateImageXImageOperationInput & Readonly<{ dataId: string }>;

export type FormalCandidateImageXReviewLease = Readonly<{
  operationId: string;
  request: FormalCandidateCredentialRequest;
  dataId: string;
  credentialGeneration: number;
  expiresAtMs: number;
  createVideoAuditTask: (input: Readonly<{
    videoUri: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }>) => Promise<VolcengineVideoAuditSubmission>;
  /** Marker is deliberately not an argument: the lease advances only from the
   * marker returned by its immediately preceding, exactly-bound response. */
  getVideoAuditResult: (input?: Readonly<{
    timeoutMs?: number;
    signal?: AbortSignal;
  }>) => Promise<VolcengineVideoAuditPollResult>;
  dispose: () => void;
}>;

const runtimePlatform = process.platform;
const runtimeGetuid = typeof process.getuid === "function"
  ? process.getuid.bind(process)
  : null;
const runtimeGetgid = typeof process.getgid === "function"
  ? process.getgid.bind(process)
  : null;

export class FormalCandidateCredentialRuntimeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "FormalCandidateCredentialRuntimeError";
  }
}

function fail(code: string): never {
  throw new FormalCandidateCredentialRuntimeError(code);
}

let expectation: FormalCandidateCredentialExpectation | null = null;
let capability: FormalCandidateCredentialCapability | null = null;
let descriptorClosed = false;
let disposed = false;
let formalRuntimeLatched = process.env.FANJIN_FORMAL_CANDIDATE_RUNTIME === "1";
const videoDispatchLeases = new Map<
  string,
  FormalCandidateVideoDispatchLease
>();

type FormalCandidateImageXReviewLeaseState = Readonly<{
  lease: FormalCandidateImageXReviewLease;
  expectedCredentialBinding: string;
  taskId: () => string | null;
  marker: () => string | null;
  sourceUrlHash: () => string;
}>;

const imageXReviewLeases = new Map<
  string,
  FormalCandidateImageXReviewLeaseState
>();

type FormalCandidateImageXOneShotState = Readonly<{
  binding: string;
  promise: Promise<VolcengineImageFaceResult | VolcengineImageAuditResult>;
  dispose: () => void;
}>;

const imageXOneShotOperations = new Map<string, FormalCandidateImageXOneShotState>();

function formalRuntimeDeclared(): boolean {
  if (process.env.FANJIN_FORMAL_CANDIDATE_RUNTIME === "1") {
    formalRuntimeLatched = true;
  }
  return formalRuntimeLatched;
}

/** Called exactly once by the signed FD4 bootstrap before the API listens. */
export function initializeFormalCandidateCredentialRuntime(
  input: FormalCandidateCredentialExpectation,
): void {
  if (arguments.length !== 1 || expectation || disposed) {
    return fail("FORMAL_CANDIDATE_CREDENTIAL_RUNTIME_INITIALIZATION_INVALID");
  }
  if (
    !formalRuntimeDeclared()
    || runtimePlatform !== "linux"
    || runtimeGetuid === null
    || runtimeGetgid === null
    || runtimeGetuid() <= 0
    || runtimeGetgid() <= 0
    || runtimeGetuid() !== input.runtimeUid
    || runtimeGetgid() !== input.runtimeGid
  ) return fail("FORMAL_CANDIDATE_CREDENTIAL_RUNTIME_IDENTITY_INVALID");
  formalRuntimeLatched = true;
  expectation = Object.freeze({
    sessionBinding: input.sessionBinding,
    candidateBinding: input.candidateBinding,
    runtimeUid: input.runtimeUid,
    runtimeGid: input.runtimeGid,
    runtimeCapabilities: Object.freeze([...input.runtimeCapabilities]),
  });
}

/**
 * Read-only readiness seam. It reflects only the root-owned FD4 expectation
 * initialized before listen; it neither reads nor consumes FD6.
 */
export function isFormalCandidateRuntimeCapabilityDeclared(
  capabilityName: string,
): boolean {
  return Boolean(
    formalRuntimeDeclared()
    && expectation
    && !disposed
    && expectation.runtimeCapabilities.includes(capabilityName),
  );
}

/**
 * The first real dispatch performs the only blocking FD6 read. API bootstrap
 * never touches FD6, so readiness is independent from root envelope creation.
 */
export function withFormalCandidateCredentialForDispatch<T>(
  request: FormalCandidateCredentialRequest,
  use: (credential: string) => T,
): T {
  if (!formalRuntimeDeclared() || !expectation || disposed) {
    return fail("FORMAL_CANDIDATE_CREDENTIAL_RUNTIME_UNAVAILABLE");
  }
  if (!capability) {
    capability = consumeFormalCandidateCredentialCapabilityFromFixedFd(
      expectation,
    );
    descriptorClosed = true;
  }
  return capability.withCredential(request, use);
}

function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.text().then((text) => {
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { raw: parsed };
    } catch {
      return { raw: text };
    }
  });
}

function exactCredentialRequestMatches(
  left: FormalCandidateCredentialRequest,
  right: FormalCandidateCredentialRequest,
): boolean {
  return left.channelId === right.channelId
    && left.provider === right.provider
    && left.endpointType === right.endpointType
    && left.model === right.model;
}

function exactVideoTaskCollectionUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_URL_INVALID");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
    || !parsed.hostname
    || !/\/api\/v3\/contents\/generations\/tasks\/?$/u.test(parsed.pathname)
  ) return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_URL_INVALID");
  return parsed.toString().replace(/\/$/u, "");
}

function checkedTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30 * 60 * 1000) {
    return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_TIMEOUT_INVALID");
  }
  return value;
}

function checkedProviderTaskId(value: string): string {
  const normalized = String(value || "").trim();
  if (
    !normalized
    || normalized.length > 512
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_TASK_ID_INVALID");
  return normalized;
}

type ImageXDispatchState =
  | "not_dispatched"
  | "response_received"
  | "outcome_unknown";

type ImageXLeaseCredentialBuffers = Readonly<{
  serviceId: Buffer;
  accessKeyId: Buffer;
  secretAccessKey: Buffer;
  sessionToken: Buffer | null;
}>;

function imageXFailure(input: {
  code: string;
  dispatchState?: ImageXDispatchState;
  httpStatus?: number;
}): VolcengineImageXReviewError {
  return new VolcengineImageXReviewError({
    code: input.code,
    dispatchState: input.dispatchState,
    httpStatus: input.httpStatus,
    // This message is deliberately stable and contains no upstream payload,
    // ServiceId, task id, marker, request id or credential material.
    message: "ImageX 安全预检请求失败",
  });
}

function imageXPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkedImageXDataId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!SAFE_IMAGEX_DATA_ID.test(normalized)) {
    return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_DATA_ID_INVALID");
  }
  return normalized;
}

function checkedImageXTaskId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!SAFE_IMAGEX_TASK_ID.test(normalized)) {
    throw imageXFailure({
      code: "VOLC_IMAGEX_TASK_ID_INVALID",
      dispatchState: "response_received",
    });
  }
  return normalized;
}

function checkedImageXMarker(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_MARKER_INVALID");
  return value;
}

function checkedImageXVideoUrl(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (
    !normalized
    || normalized.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_URL_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_URL_INVALID");
  }
  if (
    parsed.protocol !== "https:"
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.hash
  ) return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_URL_INVALID");
  return parsed.toString();
}

function checkedImageXTimeoutMs(value: unknown): number {
  const timeoutMs = value === undefined ? 10_000 : Number(value);
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > IMAGEX_REVIEW_MAX_REQUEST_TIMEOUT_MS
  ) return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_TIMEOUT_INVALID");
  return timeoutMs;
}

function checkedImageXCredentialGeneration(value: unknown): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_GENERATION_INVALID");
  }
  return generation;
}

function checkedImageXReviewRequest(
  request: FormalCandidateCredentialRequest,
): void {
  if (
    request.provider !== "volcano"
    || request.endpointType !== "video_generation"
    || request.model !== FORMAL_CANDIDATE_PORTRAIT_IMAGEX_REVIEW_MODEL
    || !SAFE_OPERATION_ID.test(request.channelId)
  ) return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_SCOPE_MISMATCH");
  if (!isFormalCandidateRuntimeCapabilityDeclared(
    PORTRAIT_IMAGEX_REVIEW_RUNTIME_CAPABILITY,
  )) return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_CAPABILITY_UNATTESTED");
}

function imageXLeaseExpiry(acquiredAtMs: number, requested: unknown): number {
  if (!Number.isSafeInteger(acquiredAtMs)) {
    return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_CLOCK_INVALID");
  }
  if (requested === undefined) {
    return acquiredAtMs + FORMAL_CANDIDATE_IMAGEX_REVIEW_LEASE_TTL_MS;
  }
  const expiresAtMs = Number(requested);
  if (
    !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= acquiredAtMs
    || expiresAtMs - acquiredAtMs
      > FORMAL_CANDIDATE_IMAGEX_REVIEW_LEASE_TTL_MS
  ) return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_EXPIRY_INVALID");
  return expiresAtMs;
}

function imageXCredentialBuffers(serialized: string): ImageXLeaseCredentialBuffers {
  const credential = parseProviderChannelImageXReviewCredential(serialized);
  if (!credential) {
    return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_CREDENTIAL_INVALID");
  }
  const output = {
    serviceId: Buffer.from(credential.serviceId, "utf8"),
    accessKeyId: Buffer.from(credential.accessKeyId, "utf8"),
    secretAccessKey: Buffer.from(credential.secretAccessKey, "utf8"),
    sessionToken: credential.sessionToken === undefined
      ? null
      : Buffer.from(credential.sessionToken, "utf8"),
  };
  if (
    output.serviceId.byteLength < 1
    || output.accessKeyId.byteLength < 1
    || output.secretAccessKey.byteLength < 1
  ) {
    output.serviceId.fill(0);
    output.accessKeyId.fill(0);
    output.secretAccessKey.fill(0);
    output.sessionToken?.fill(0);
    return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_CREDENTIAL_INVALID");
  }
  return output;
}

function disposeImageXCredentialBuffers(
  credential: ImageXLeaseCredentialBuffers,
): void {
  credential.serviceId.fill(0);
  credential.accessKeyId.fill(0);
  credential.secretAccessKey.fill(0);
  credential.sessionToken?.fill(0);
}

function checkedImageXCredentialBinding(value: unknown): string {
  const binding = String(value ?? "").trim();
  if (!/^hmac-sha256:[a-f0-9]{64}$/u.test(binding)) {
    return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_BINDING_INVALID");
  }
  return binding;
}

function assertImageXCredentialBinding(input: Readonly<{
  credential: ImageXLeaseCredentialBuffers;
  channelId: string;
  generation: number;
  expectedBinding: string;
}>): void {
  let accessKeyId = "";
  let serviceId = "";
  let calculated = "";
  try {
    accessKeyId = input.credential.accessKeyId.toString("utf8");
    serviceId = input.credential.serviceId.toString("utf8");
    calculated = secretPurposeHmac(JSON.stringify({
      accessKeyId,
      channelId: input.channelId,
      generation: input.generation,
      serviceId,
      version: PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_VERSION,
    }), IMAGEX_REVIEW_CREDENTIAL_BINDING_PURPOSE);
    const expectedBytes = Buffer.from(input.expectedBinding, "utf8");
    const calculatedBytes = Buffer.from(calculated, "utf8");
    try {
      if (
        expectedBytes.byteLength !== calculatedBytes.byteLength
        || !crypto.timingSafeEqual(expectedBytes, calculatedBytes)
      ) return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_BINDING_MISMATCH");
    } finally {
      expectedBytes.fill(0);
      calculatedBytes.fill(0);
    }
  } catch (caught) {
    if (caught instanceof FormalCandidateCredentialRuntimeError) throw caught;
    return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_BINDING_INVALID");
  } finally {
    accessKeyId = "";
    serviceId = "";
    calculated = "";
  }
}

async function boundedImageXResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > IMAGEX_REVIEW_MAX_RESPONSE_BYTES
    ) throw imageXFailure({
      code: "VOLC_IMAGEX_RESPONSE_TOO_LARGE",
      dispatchState: "response_received",
      httpStatus: response.status,
    });
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > IMAGEX_REVIEW_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw imageXFailure({
          code: "VOLC_IMAGEX_RESPONSE_TOO_LARGE",
          dispatchState: "response_received",
          httpStatus: response.status,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    throw imageXFailure({
      code: "VOLC_IMAGEX_RESPONSE_INVALID",
      dispatchState: "response_received",
      httpStatus: response.status,
    });
  }
}

async function dispatchFormalImageXReviewRequest(input: Readonly<{
  credential: ImageXLeaseCredentialBuffers;
  action:
    | "GetImageDetectResult"
    | "SingleImageAudit"
    | "CreateVideoAuditTask"
    | "GetVideoAuditResult";
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  query?: Readonly<Record<string, string>>;
  mutation: boolean;
  signal?: AbortSignal;
  timeoutMs: number;
  assertActive: () => void;
}>): Promise<Record<string, unknown>> {
  input.assertActive();
  if (input.signal?.aborted) {
    throw imageXFailure({ code: "VOLC_IMAGEX_ABORTED" });
  }
  const body = input.method === "POST" ? JSON.stringify(input.body ?? {}) : "";
  const query = Object.freeze({
    Action: input.action,
    Version: IMAGEX_REVIEW_VERSION,
    ...(input.query ?? {}),
  });
  const signed = (() => {
    let accessKeyId = "";
    let secretAccessKey = "";
    let sessionToken = "";
    let serviceId = "";
    try {
      accessKeyId = input.credential.accessKeyId.toString("utf8");
      secretAccessKey = input.credential.secretAccessKey.toString("utf8");
      sessionToken = input.credential.sessionToken?.toString("utf8") ?? "";
      serviceId = input.credential.serviceId.toString("utf8");
      // ServiceId may occur only in the exact API-prescribed body/query. It is
      // never returned from this function or included in an error.
      if (input.action === "CreateVideoAuditTask") {
        if (input.body?.ServiceId !== serviceId || input.query?.ServiceId) {
          return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_SERVICE_BINDING_INVALID");
        }
      } else if (
        ["GetImageDetectResult", "SingleImageAudit"].includes(input.action)
      ) {
        if (input.query?.ServiceId !== serviceId || input.body?.ServiceId) {
          return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_SERVICE_BINDING_INVALID");
        }
      } else if (input.body || input.query?.ServiceId) {
        return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_SERVICE_BINDING_INVALID");
      }
      const signInput = {
        accessKeyId,
        at: new Date(Date.now()),
        host: IMAGEX_REVIEW_HOST,
        pathname: IMAGEX_REVIEW_PATHNAME,
        query,
        region: IMAGEX_REVIEW_REGION,
        secretAccessKey,
        service: IMAGEX_REVIEW_SERVICE,
        ...(sessionToken ? { sessionToken } : {}),
      };
      return input.method === "POST"
        ? signVolcengineV4JsonPost({ ...signInput, body })
        : signVolcengineV4Get(signInput);
    } finally {
      // No credential-derived JavaScript string crosses the first await.
      accessKeyId = "";
      secretAccessKey = "";
      sessionToken = "";
      serviceId = "";
    }
  })();
  const url = `https://${IMAGEX_REVIEW_HOST}${IMAGEX_REVIEW_PATHNAME}?${signed.canonicalQuery}`;
  const controller = new AbortController();
  let timedOut = false;
  let dispatched = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    input.assertActive();
    dispatched = true;
    const response = await fetch(url, {
      ...(input.method === "POST" ? { body } : {}),
      cache: "no-store",
      credentials: "omit",
      headers: signed.headers,
      method: input.method,
      redirect: "error",
      signal: controller.signal,
    });
    input.assertActive();
    const text = await boundedImageXResponseText(response);
    input.assertActive();
    if (!response.ok) {
      throw imageXFailure({
        code: `VOLC_IMAGEX_HTTP_${response.status}`,
        dispatchState: input.mutation ? "outcome_unknown" : "response_received",
        httpStatus: response.status,
      });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw imageXFailure({
        code: "VOLC_IMAGEX_RESPONSE_INVALID",
        dispatchState: input.mutation ? "outcome_unknown" : "response_received",
        httpStatus: response.status,
      });
    }
    if (!imageXPlainObject(payload)) {
      throw imageXFailure({
        code: "VOLC_IMAGEX_RESPONSE_INVALID",
        dispatchState: input.mutation ? "outcome_unknown" : "response_received",
        httpStatus: response.status,
      });
    }
    const metadata = payload.ResponseMetadata;
    if (imageXPlainObject(metadata) && imageXPlainObject(metadata.Error)) {
      throw imageXFailure({
        code: "VOLC_IMAGEX_UPSTREAM_REJECTED",
        dispatchState: input.mutation ? "outcome_unknown" : "response_received",
        httpStatus: response.status,
      });
    }
    if (!imageXPlainObject(payload.Result)) {
      throw imageXFailure({
        code: "VOLC_IMAGEX_RESPONSE_INVALID",
        dispatchState: input.mutation ? "outcome_unknown" : "response_received",
        httpStatus: response.status,
      });
    }
    return payload.Result;
  } catch (caught) {
    if (caught instanceof FormalCandidateCredentialRuntimeError) throw caught;
    if (caught instanceof VolcengineImageXReviewError) {
      if (input.mutation && caught.dispatchState === "response_received") {
        throw imageXFailure({
          code: caught.code,
          dispatchState: "outcome_unknown",
          httpStatus: caught.httpStatus,
        });
      }
      throw caught;
    }
    const outcomeUnknown = input.mutation && dispatched;
    if (timedOut) {
      throw imageXFailure({
        code: "VOLC_IMAGEX_TIMEOUT",
        dispatchState: outcomeUnknown ? "outcome_unknown" : "not_dispatched",
      });
    }
    if (input.signal?.aborted) {
      throw imageXFailure({
        code: "VOLC_IMAGEX_ABORTED",
        dispatchState: outcomeUnknown ? "outcome_unknown" : "not_dispatched",
      });
    }
    throw imageXFailure({
      code: "VOLC_IMAGEX_TRANSPORT_FAILED",
      dispatchState: outcomeUnknown
        ? "outcome_unknown"
        : dispatched ? "response_received" : "not_dispatched",
    });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}

function imageXOneShotBinding(input: Readonly<{
  kind: "face-detect" | "image-audit";
  request: FormalCandidateCredentialRequest;
  operationId: string;
  imageUri: string;
  dataId: string | null;
  credentialGeneration: number;
  expectedCredentialBinding: string;
}>): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    credentialGeneration: input.credentialGeneration,
    dataId: input.dataId,
    expectedCredentialBinding: input.expectedCredentialBinding,
    imageUri: input.imageUri,
    kind: input.kind,
    operationId: input.operationId,
    request: input.request,
  }), "utf8").digest("hex");
}

function startFormalCandidateImageXOneShot(input: Readonly<{
  kind: "face-detect" | "image-audit";
  request: FormalCandidateCredentialRequest;
  operationId: string;
  imageUri: string;
  dataId: string | null;
  credentialGeneration: number;
  expectedCredentialBinding: string;
  timeoutMs: number;
  signal?: AbortSignal;
}>): Promise<VolcengineImageFaceResult | VolcengineImageAuditResult> {
  const binding = imageXOneShotBinding(input);
  const existing = imageXOneShotOperations.get(input.operationId);
  if (existing) {
    if (existing.binding !== binding) {
      return Promise.reject(new FormalCandidateCredentialRuntimeError(
        "FORMAL_CANDIDATE_IMAGEX_REVIEW_BINDING_MISMATCH",
      ));
    }
    return existing.promise;
  }
  const holder = withFormalCandidateCredentialForDispatch(
    input.request,
    (serializedCredential) => {
      const credential = imageXCredentialBuffers(serializedCredential);
      try {
        assertImageXCredentialBinding({
          credential,
          channelId: input.request.channelId,
          generation: input.credentialGeneration,
          expectedBinding: input.expectedCredentialBinding,
        });
      } catch (caught) {
        disposeImageXCredentialBuffers(credential);
        throw caught;
      }
      let operationDisposed = false;
      const controller = new AbortController();
      const abort = () => controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) controller.abort();
      let serviceId = "";
      let promise: Promise<VolcengineImageFaceResult | VolcengineImageAuditResult>;
      try {
        serviceId = credential.serviceId.toString("utf8");
        if (input.kind === "face-detect") {
          promise = dispatchFormalImageXReviewRequest({
            credential,
            action: "GetImageDetectResult",
            method: "POST",
            mutation: false,
            body: {
              ImageUri: input.imageUri,
              DetectType: "face",
              FaceDetectThresh: 0.52,
            },
            query: { ServiceId: serviceId },
            signal: controller.signal,
            timeoutMs: input.timeoutMs,
            assertActive: () => {
              if (operationDisposed || disposed) {
                return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_OPERATION_DISPOSED");
              }
            },
          }).then((result) => {
            if (
              result.DetectType !== "face"
              || !Array.isArray(result.Faces)
              || result.Faces.length > 10_000
              || result.Faces.some((face) => !imageXPlainObject(face))
            ) throw imageXFailure({
              code: "VOLC_IMAGEX_RESPONSE_INVALID",
              dispatchState: "response_received",
            });
            return Object.freeze({
              classification: result.Faces.length === 0
                ? "none" as const
                : result.Faces.length === 1
                  ? "single" as const
                  : "multiple" as const,
              faceCount: result.Faces.length,
            });
          });
        } else {
          promise = dispatchFormalImageXReviewRequest({
            credential,
            action: "SingleImageAudit",
            method: "POST",
            mutation: false,
            body: {
              AuditAbility: 1,
              AuditDimensions: IMAGEX_IMAGE_AUDIT_DIMENSIONS,
              Async: 0,
              DataId: input.dataId,
              ImageUri: input.imageUri,
            },
            query: { ServiceId: serviceId },
            signal: controller.signal,
            timeoutMs: input.timeoutMs,
            assertActive: () => {
              if (operationDisposed || disposed) {
                return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_OPERATION_DISPOSED");
              }
            },
          }).then((result) => {
            if (
              result.DataId !== input.dataId
              || result.ImageUri !== input.imageUri
              || !["normal", "problem"].includes(String(result.ImageType ?? ""))
              || !["", "block", "review"].includes(String(result.Advice ?? ""))
            ) throw imageXFailure({
              code: "VOLC_IMAGEX_RESPONSE_INVALID",
              dispatchState: "response_received",
            });
            const imageType = result.ImageType as "normal" | "problem";
            const advice = result.Advice === "block" || result.Advice === "review"
              ? result.Advice
              : null;
            return Object.freeze({
              imageType,
              advice,
              decision: imageType === "normal" && advice === null
                ? "allow" as const
                : "deny" as const,
            });
          });
        }
      } finally {
        serviceId = "";
      }
      const dispose = () => {
        if (operationDisposed) return;
        operationDisposed = true;
        controller.abort();
        input.signal?.removeEventListener("abort", abort);
        disposeImageXCredentialBuffers(credential);
      };
      promise = promise.finally(dispose);
      return Object.freeze({ promise, dispose });
    },
  );
  const state: FormalCandidateImageXOneShotState = Object.freeze({
    binding,
    promise: holder.promise,
    dispose: holder.dispose,
  });
  imageXOneShotOperations.set(input.operationId, state);
  return state.promise;
}

export function runFormalCandidateImageXFaceDetection(
  rawInput: FormalCandidateImageXImageOperationInput,
): Promise<VolcengineImageFaceResult> {
  if (!formalRuntimeDeclared() || !expectation || disposed) {
    return Promise.reject(new FormalCandidateCredentialRuntimeError(
      "FORMAL_CANDIDATE_CREDENTIAL_RUNTIME_UNAVAILABLE",
    ));
  }
  if (
    !rawInput
    || typeof rawInput !== "object"
    || !rawInput.request
    || !SAFE_OPERATION_ID.test(String(rawInput.operationId ?? ""))
  ) return Promise.reject(new FormalCandidateCredentialRuntimeError(
    "FORMAL_CANDIDATE_IMAGEX_REVIEW_OPERATION_INVALID",
  ));
  try {
    checkedImageXReviewRequest(rawInput.request);
    const imageUri = checkedImageXVideoUrl(rawInput.imageUri);
    const credentialGeneration = checkedImageXCredentialGeneration(
      rawInput.credentialGeneration,
    );
    const expectedCredentialBinding = checkedImageXCredentialBinding(
      rawInput.expectedCredentialBinding,
    );
    return startFormalCandidateImageXOneShot({
      kind: "face-detect",
      request: rawInput.request,
      operationId: rawInput.operationId,
      imageUri,
      dataId: null,
      credentialGeneration,
      expectedCredentialBinding,
      timeoutMs: checkedImageXTimeoutMs(rawInput.timeoutMs),
      signal: rawInput.signal,
    }) as Promise<VolcengineImageFaceResult>;
  } catch (caught) {
    return Promise.reject(caught);
  }
}

export function runFormalCandidateImageXImageAudit(
  rawInput: FormalCandidateImageXImageAuditInput,
): Promise<VolcengineImageAuditResult> {
  if (!formalRuntimeDeclared() || !expectation || disposed) {
    return Promise.reject(new FormalCandidateCredentialRuntimeError(
      "FORMAL_CANDIDATE_CREDENTIAL_RUNTIME_UNAVAILABLE",
    ));
  }
  if (
    !rawInput
    || typeof rawInput !== "object"
    || !rawInput.request
    || !SAFE_OPERATION_ID.test(String(rawInput.operationId ?? ""))
  ) return Promise.reject(new FormalCandidateCredentialRuntimeError(
    "FORMAL_CANDIDATE_IMAGEX_REVIEW_OPERATION_INVALID",
  ));
  try {
    checkedImageXReviewRequest(rawInput.request);
    const imageUri = checkedImageXVideoUrl(rawInput.imageUri);
    const credentialGeneration = checkedImageXCredentialGeneration(
      rawInput.credentialGeneration,
    );
    const expectedCredentialBinding = checkedImageXCredentialBinding(
      rawInput.expectedCredentialBinding,
    );
    return startFormalCandidateImageXOneShot({
      kind: "image-audit",
      request: rawInput.request,
      operationId: rawInput.operationId,
      imageUri,
      dataId: checkedImageXDataId(rawInput.dataId),
      credentialGeneration,
      expectedCredentialBinding,
      timeoutMs: checkedImageXTimeoutMs(rawInput.timeoutMs),
      signal: rawInput.signal,
    }) as Promise<VolcengineImageAuditResult>;
  } catch (caught) {
    return Promise.reject(caught);
  }
}

/**
 * Acquires one capability use for one logical video operation.  The returned
 * object is scope- and URL-bound and performs HTTP itself, so application code
 * never receives or caches the provider credential.  Capability TTL gates
 * acquisition; a task acquired in time may finish inside this separately
 * bounded 45-minute protocol lease.
 */
export function acquireFormalCandidateVideoDispatchLease(
  request: FormalCandidateCredentialRequest,
  operationId: string,
  taskCollectionUrl: string,
): FormalCandidateVideoDispatchLease {
  if (!formalRuntimeDeclared() || !expectation || disposed) {
    return fail("FORMAL_CANDIDATE_CREDENTIAL_RUNTIME_UNAVAILABLE");
  }
  if (!SAFE_OPERATION_ID.test(operationId)) {
    return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_OPERATION_INVALID");
  }
  const existing = videoDispatchLeases.get(operationId);
  if (existing) {
    if (!exactCredentialRequestMatches(existing.request, request)) {
      return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_SCOPE_MISMATCH");
    }
    return existing;
  }
  const collectionUrl = exactVideoTaskCollectionUrl(taskCollectionUrl);
  const acquiredAtMs = Date.now();
  const lease = withFormalCandidateCredentialForDispatch(
    request,
    (credential) => {
      const secret = Buffer.from(credential, "utf8");
      let providerTaskId: string | null = null;
      let submitStarted = false;
      let cancelStarted = false;
      let pollCount = 0;
      let leaseDisposed = false;
      const timer = setTimeout(() => {
        output.dispose();
      }, FORMAL_CANDIDATE_VIDEO_DISPATCH_LEASE_TTL_MS);
      timer.unref?.();
      const assertActive = (): void => {
        if (
          leaseDisposed
          || Date.now() < acquiredAtMs
          || Date.now() - acquiredAtMs
            >= FORMAL_CANDIDATE_VIDEO_DISPATCH_LEASE_TTL_MS
        ) {
          output.dispose();
          return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_LEASE_EXPIRED");
        }
      };
      const authorizationHeaders = (): Record<string, string> => {
        assertActive();
        let value = secret.toString("utf8");
        try {
          return {
            "Content-Type": "application/json",
            Authorization: `Bearer ${value}`,
          };
        } finally {
          value = "";
        }
      };
      const boundTaskUrl = (): string => {
        assertActive();
        if (!providerTaskId) {
          return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_TASK_UNBOUND");
        }
        return `${collectionUrl}/${encodeURIComponent(providerTaskId)}`;
      };
      const output: FormalCandidateVideoDispatchLease = Object.freeze({
        operationId,
        request: Object.freeze({ ...request }),
        submitJson(body, timeoutMs) {
          assertActive();
          if (
            submitStarted
            || !body
            || typeof body !== "object"
            || Array.isArray(body)
          ) return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_SUBMIT_INVALID");
          submitStarted = true;
          return fetchProviderSubmissionWithFreshConnection({
            url: collectionUrl,
            init: {
              method: "POST",
              headers: authorizationHeaders(),
              body: JSON.stringify(body),
            },
            timeoutMs: checkedTimeoutMs(timeoutMs),
            consume: readJsonResponse,
          }).then(({ response, value }) => ({ response, payload: value }));
        },
        bindProviderTaskId(value) {
          assertActive();
          const normalized = checkedProviderTaskId(value);
          if (providerTaskId && providerTaskId !== normalized) {
            return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_TASK_REBIND_DENIED");
          }
          providerTaskId = normalized;
        },
        pollJson(timeoutMs) {
          assertActive();
          if (pollCount >= FORMAL_CANDIDATE_VIDEO_DISPATCH_MAX_POLLS) {
            return Promise.reject(new FormalCandidateCredentialRuntimeError(
              "FORMAL_CANDIDATE_VIDEO_DISPATCH_POLL_LIMIT_EXCEEDED",
            ));
          }
          pollCount += 1;
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            checkedTimeoutMs(timeoutMs),
          );
          return fetch(boundTaskUrl(), {
            method: "GET",
            headers: authorizationHeaders(),
            signal: controller.signal,
          }).then(async (response) => ({
            response,
            payload: await readJsonResponse(response),
          })).finally(() => clearTimeout(timer));
        },
        cancelJson(timeoutMs) {
          assertActive();
          if (cancelStarted) {
            return Promise.reject(new FormalCandidateCredentialRuntimeError(
              "FORMAL_CANDIDATE_VIDEO_DISPATCH_CANCEL_REPLAY_DENIED",
            ));
          }
          cancelStarted = true;
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            checkedTimeoutMs(timeoutMs),
          );
          return fetch(boundTaskUrl(), {
            method: "DELETE",
            headers: authorizationHeaders(),
            signal: controller.signal,
          }).then(async (response) => ({
            response,
            payload: await readJsonResponse(response),
          })).finally(() => clearTimeout(timer));
        },
        dispose() {
          if (leaseDisposed) return;
          leaseDisposed = true;
          clearTimeout(timer);
          secret.fill(0);
          providerTaskId = null;
          videoDispatchLeases.delete(operationId);
        },
      });
      return output;
    },
  );
  videoDispatchLeases.set(operationId, lease);
  return lease;
}

export function getFormalCandidateVideoDispatchLease(
  request: FormalCandidateCredentialRequest,
  operationId: string,
): FormalCandidateVideoDispatchLease {
  const existing = videoDispatchLeases.get(operationId);
  if (!existing) {
    return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_LEASE_MISSING");
  }
  if (!exactCredentialRequestMatches(existing.request, request)) {
    return fail("FORMAL_CANDIDATE_VIDEO_DISPATCH_SCOPE_MISMATCH");
  }
  return existing;
}

export function disposeFormalCandidateVideoDispatchLease(
  operationId: string,
): void {
  videoDispatchLeases.get(operationId)?.dispose();
}

/**
 * Acquires one FD6 use for one exact ImageX video-review job. The serialized
 * AK/SK credential is converted to zeroizable buffers inside this synchronous
 * callback and never returned to the caller. The lease itself owns the fixed
 * ImageX endpoint, V4 signing, the single mutation, task binding, pagination
 * marker and bounded polling protocol.
 */
export function acquireFormalCandidateImageXReviewLease(
  rawInput: FormalCandidateImageXReviewLeaseInput,
): FormalCandidateImageXReviewLease {
  if (!formalRuntimeDeclared() || !expectation || disposed) {
    return fail("FORMAL_CANDIDATE_CREDENTIAL_RUNTIME_UNAVAILABLE");
  }
  if (
    !rawInput
    || typeof rawInput !== "object"
    || !rawInput.request
    || typeof rawInput.request !== "object"
    || !SAFE_OPERATION_ID.test(String(rawInput.operationId ?? ""))
  ) return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_OPERATION_INVALID");
  checkedImageXReviewRequest(rawInput.request);
  const operationId = rawInput.operationId;
  const dataId = checkedImageXDataId(rawInput.dataId);
  const credentialGeneration = checkedImageXCredentialGeneration(
    rawInput.credentialGeneration,
  );
  const expectedCredentialBinding = checkedImageXCredentialBinding(
    rawInput.expectedCredentialBinding,
  );
  const initialTaskId = rawInput.taskId == null
    ? null
    : (() => {
        const value = String(rawInput.taskId).trim();
        if (!SAFE_IMAGEX_TASK_ID.test(value)) {
          return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_TASK_ID_INVALID");
        }
        return value;
      })();
  const initialMarker = checkedImageXMarker(rawInput.marker);
  if (initialMarker && !initialTaskId) {
    return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_MARKER_WITHOUT_TASK");
  }
  const existing = imageXReviewLeases.get(operationId);
  if (existing) {
    if (
      !exactCredentialRequestMatches(existing.lease.request, rawInput.request)
      || existing.lease.dataId !== dataId
      || existing.lease.credentialGeneration !== credentialGeneration
      || existing.expectedCredentialBinding !== expectedCredentialBinding
      || (initialTaskId !== null && existing.taskId() !== initialTaskId)
      || (rawInput.sourceUrlHash !== undefined && existing.sourceUrlHash() !== rawInput.sourceUrlHash)
      || (rawInput.marker !== undefined && existing.marker() !== initialMarker)
      || (
        rawInput.expiresAtMs !== undefined
        && (
          !Number.isSafeInteger(Number(rawInput.expiresAtMs))
          // The first acquisition happens immediately before the provider
          // POST; the durable submittedAt deadline is recorded only after the
          // POST returns and can therefore be slightly later. Reusing the
          // already-shorter in-memory deadline is safe, while any attempt to
          // shorten or rewrite it fails closed.
          || Number(rawInput.expiresAtMs) < existing.lease.expiresAtMs
        )
      )
    ) return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_BINDING_MISMATCH");
    return existing.lease;
  }

  const acquiredAtMs = Date.now();
  const expiresAtMs = imageXLeaseExpiry(acquiredAtMs, rawInput.expiresAtMs);
  let taskAccessor: () => string | null = () => null;
  let markerAccessor: () => string | null = () => null;
  let sourceHashAccessor: () => string = () => "";
  const lease = withFormalCandidateCredentialForDispatch(
    rawInput.request,
    (serializedCredential) => {
      const credential = imageXCredentialBuffers(serializedCredential);
      try {
        assertImageXCredentialBinding({
          credential,
          channelId: rawInput.request.channelId,
          generation: credentialGeneration,
          expectedBinding: expectedCredentialBinding,
        });
      } catch (caught) {
        disposeImageXCredentialBuffers(credential);
        throw caught;
      }
      let sourceUrlHash = rawInput.sourceUrlHash || "";
      sourceHashAccessor = () => sourceUrlHash;
      let providerTaskId = initialTaskId;
      let currentMarker = initialMarker || null;
      let createStarted = initialTaskId !== null;
      let pollCount = 0;
      let leaseDisposed = false;
      taskAccessor = () => providerTaskId;
      markerAccessor = () => currentMarker;

      const assertActive = (): void => {
        const now = Date.now();
        if (
          leaseDisposed
          || disposed
          || !Number.isSafeInteger(now)
          || now < acquiredAtMs
          || now >= expiresAtMs
        ) {
          output.dispose();
          return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_LEASE_EXPIRED");
        }
      };
      const timer = setTimeout(() => {
        output.dispose();
      }, expiresAtMs - acquiredAtMs);
      timer.unref?.();

      const output: FormalCandidateImageXReviewLease = Object.freeze({
        operationId,
        request: Object.freeze({ ...rawInput.request }),
        dataId,
        credentialGeneration,
        expiresAtMs,
        async createVideoAuditTask(input) {
          assertActive();
          if (createStarted || providerTaskId !== null) {
            return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_CREATE_REPLAY_DENIED");
          }
          createStarted = true;
          const videoUri = checkedImageXVideoUrl(input?.videoUri);
          sourceUrlHash = crypto.createHash("sha256").update(videoUri).digest("hex");
          const timeoutMs = checkedImageXTimeoutMs(input?.timeoutMs);
          const body = (() => {
            let serviceId = "";
            try {
              serviceId = credential.serviceId.toString("utf8");
              return {
                AuditAbility: 1,
                AuditDimensions: IMAGEX_VIDEO_AUDIT_DIMENSIONS,
                EnableCallback: false,
                EnableFreeze: false,
                ImageInfos: [{ DataId: dataId, ImageUri: videoUri }],
                Interval: 1,
                Region: IMAGEX_REVIEW_TASK_REGION,
                ServiceId: serviceId,
                TaskType: "audit_video",
                Type: "Url",
              };
            } finally {
              // The credential-derived ServiceId string is cleared before
              // the first asynchronous boundary. Only the exact request body
              // retains the value required by ImageX.
              serviceId = "";
            }
          })();
          const result = await dispatchFormalImageXReviewRequest({
            credential,
            action: "CreateVideoAuditTask",
            method: "POST",
            mutation: true,
            body,
            signal: input?.signal,
            timeoutMs,
            assertActive,
          });
          try {
            providerTaskId = checkedImageXTaskId(result.TaskId);
          } catch (caught) {
            if (caught instanceof VolcengineImageXReviewError) {
              throw imageXFailure({
                code: caught.code,
                dispatchState: "outcome_unknown",
                httpStatus: caught.httpStatus,
              });
            }
            throw caught;
          }
          currentMarker = null;
          return Object.freeze({ dataId, taskId: providerTaskId });
        },
        async getVideoAuditResult(input = {}) {
          assertActive();
          if (!providerTaskId) {
            return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_TASK_UNBOUND");
          }
          if (pollCount >= FORMAL_CANDIDATE_IMAGEX_REVIEW_MAX_POLLS) {
            output.dispose();
            return fail("FORMAL_CANDIDATE_IMAGEX_REVIEW_POLL_LIMIT_EXCEEDED");
          }
          pollCount += 1;
          const result = await dispatchFormalImageXReviewRequest({
            credential,
            action: "GetVideoAuditResult",
            method: "GET",
            mutation: false,
            query: {
              Limit: "100",
              TaskId: providerTaskId,
              Type: "Url",
              ...(currentMarker ? { Marker: currentMarker } : {}),
            },
            signal: input.signal,
            timeoutMs: checkedImageXTimeoutMs(input.timeoutMs),
            assertActive,
          });
          const parsed = parseVolcengineVideoAuditResult({
            sourceUrlHash,
            result,
            dataId,
            taskId: providerTaskId,
          });
          // Only the exact response to the currently bound task may advance
          // pagination. Callers cannot inject or skip a marker.
          currentMarker = parsed.marker;
          if (parsed.status === "complete" && !parsed.haveMore) {
            output.dispose();
          }
          return parsed;
        },
        dispose() {
          if (leaseDisposed) return;
          leaseDisposed = true;
          clearTimeout(timer);
          disposeImageXCredentialBuffers(credential);
          providerTaskId = null;
          currentMarker = null;
          const registered = imageXReviewLeases.get(operationId);
          if (registered?.lease === output) imageXReviewLeases.delete(operationId);
        },
      });
      return output;
    },
  );
  imageXReviewLeases.set(operationId, {
    sourceUrlHash: sourceHashAccessor,
    lease,
    expectedCredentialBinding,
    taskId: taskAccessor,
    marker: markerAccessor,
  });
  return lease;
}

export function disposeFormalCandidateImageXReviewLease(
  operationId: string,
): void {
  imageXReviewLeases.get(operationId)?.lease.dispose();
}

export function disposeFormalCandidateImageXImageOperation(
  operationId: string,
): void {
  imageXOneShotOperations.get(operationId)?.dispose();
  imageXOneShotOperations.delete(operationId);
}

/** Stop/failed-start cleanup. Closing an unread FD6 also unblocks the root writer. */
export function disposeFormalCandidateCredentialRuntime(): void {
  if (disposed) return;
  disposed = true;
  for (const state of imageXOneShotOperations.values()) state.dispose();
  imageXOneShotOperations.clear();
  for (const state of [...imageXReviewLeases.values()]) state.lease.dispose();
  imageXReviewLeases.clear();
  for (const lease of [...videoDispatchLeases.values()]) lease.dispose();
  videoDispatchLeases.clear();
  capability?.dispose();
  capability = null;
  expectation = null;
  if (!descriptorClosed) {
    try { fs.closeSync(FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD); } catch { /* closed */ }
    descriptorClosed = true;
  }
}

export function isFormalCandidateCredentialRuntimeDeclared(): boolean {
  return formalRuntimeDeclared();
}
