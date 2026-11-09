import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import { inspectCandidateRuntimeReadonlyEnvironmentProfile } from "./candidateRuntimeAttestation";

export class CandidateReadonlyLoopbackEgressFenceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CandidateReadonlyLoopbackEgressFenceError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new CandidateReadonlyLoopbackEgressFenceError(code);
}

function exactLoopbackHost(host: unknown): boolean {
  return String(host || "") === "127.0.0.1";
}

export function assertCandidateReadonlyLoopbackUrl(value: unknown): URL {
  let parsed: URL;
  try {
    parsed = value instanceof URL ? new URL(value.toString()) : new URL(String(value));
  } catch {
    return fail("CANDIDATE_READONLY_EGRESS_TARGET_INVALID");
  }
  if (
    parsed.protocol !== "http:"
    || !exactLoopbackHost(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    fail("CANDIDATE_READONLY_EGRESS_NON_LOOPBACK_BLOCKED");
  }
  return parsed;
}

type EgressFenceState = {
  active: boolean;
  blockedAttempts: number;
  originalFetch: typeof globalThis.fetch;
  originalHttpRequest: typeof http.request;
  originalHttpGet: typeof http.get;
  originalHttpsRequest: typeof https.request;
  originalHttpsGet: typeof https.get;
  originalNetConnect: typeof net.connect;
  originalNetCreateConnection: typeof net.createConnection;
  originalTlsConnect: typeof tls.connect;
  fetchWrapper: typeof globalThis.fetch;
  httpRequestWrapper: typeof http.request;
  httpGetWrapper: typeof http.get;
  httpsRequestWrapper: typeof https.request;
  httpsGetWrapper: typeof https.get;
  netConnectWrapper: typeof net.connect;
  netCreateConnectionWrapper: typeof net.createConnection;
  tlsConnectWrapper: typeof tls.connect;
};

let installedFence: EgressFenceState | null = null;
let macOsOutboundNetworkDeniedAttested = false;

function block(state: EgressFenceState): never {
  state.blockedAttempts += 1;
  return fail("CANDIDATE_READONLY_EGRESS_NON_LOOPBACK_BLOCKED");
}

function httpTargetFromArguments(args: readonly unknown[]): URL | null {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    return assertCandidateReadonlyLoopbackUrl(first);
  }
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const options = first as Record<string, unknown>;
  if (options.socketPath) return null;
  const protocol = String(options.protocol || "http:");
  const hostname = String(options.hostname || options.host || "");
  const port = options.port === undefined ? "" : `:${String(options.port)}`;
  if (!hostname) return null;
  return assertCandidateReadonlyLoopbackUrl(`${protocol}//${hostname}${port}/`);
}

function netHostFromArguments(args: readonly unknown[]): string {
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const options = first as Record<string, unknown>;
    if (options.path || options.socketPath) return "";
    return String(options.host || "");
  }
  if (typeof first === "number") return String(args[1] || "");
  return "";
}

/** Formal child-only process fence. It is installed before application/DB
 * imports. Every common Node outbound transport defaults to deny and only
 * exact HTTP/TCP 127.0.0.1 targets are admitted. */
export function installCandidateReadonlyLoopbackEgressFence(): Readonly<{
  assertCurrent: () => void;
  blockedAttemptCount: () => number;
  dispose: () => void;
}> {
  if (installedFence) fail("CANDIDATE_READONLY_EGRESS_ALREADY_INSTALLED");
  inspectCandidateRuntimeReadonlyEnvironmentProfile(process.env);
  const state = {} as EgressFenceState;
  state.active = true;
  state.blockedAttempts = 0;
  state.originalFetch = globalThis.fetch;
  state.originalHttpRequest = http.request;
  state.originalHttpGet = http.get;
  state.originalHttpsRequest = https.request;
  state.originalHttpsGet = https.get;
  state.originalNetConnect = net.connect;
  state.originalNetCreateConnection = net.createConnection;
  state.originalTlsConnect = tls.connect;

  state.fetchWrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      assertCandidateReadonlyLoopbackUrl(
        input instanceof Request ? input.url : input,
      );
    } catch {
      return block(state);
    }
    return state.originalFetch(input, init);
  }) as typeof globalThis.fetch;
  state.httpRequestWrapper = ((...args: unknown[]) => {
    try {
      if (!httpTargetFromArguments(args)) return block(state);
    } catch {
      return block(state);
    }
    return (state.originalHttpRequest as (...values: unknown[]) => unknown)(...args);
  }) as typeof http.request;
  state.httpGetWrapper = ((...args: unknown[]) => {
    try {
      if (!httpTargetFromArguments(args)) return block(state);
    } catch {
      return block(state);
    }
    return (state.originalHttpGet as (...values: unknown[]) => unknown)(...args);
  }) as typeof http.get;
  state.httpsRequestWrapper = ((..._args: unknown[]) => block(state)) as
    typeof https.request;
  state.httpsGetWrapper = ((..._args: unknown[]) => block(state)) as
    typeof https.get;
  state.netConnectWrapper = ((...args: unknown[]) => {
    if (!exactLoopbackHost(netHostFromArguments(args))) return block(state);
    return (state.originalNetConnect as (...values: unknown[]) => unknown)(...args);
  }) as typeof net.connect;
  state.netCreateConnectionWrapper = ((...args: unknown[]) => {
    if (!exactLoopbackHost(netHostFromArguments(args))) return block(state);
    return (state.originalNetCreateConnection as (...values: unknown[]) => unknown)(
      ...args
    );
  }) as typeof net.createConnection;
  state.tlsConnectWrapper = ((...args: unknown[]) => {
    if (!exactLoopbackHost(netHostFromArguments(args))) return block(state);
    return (state.originalTlsConnect as (...values: unknown[]) => unknown)(...args);
  }) as typeof tls.connect;

  globalThis.fetch = state.fetchWrapper;
  http.request = state.httpRequestWrapper;
  http.get = state.httpGetWrapper;
  https.request = state.httpsRequestWrapper;
  https.get = state.httpsGetWrapper;
  net.connect = state.netConnectWrapper;
  net.createConnection = state.netCreateConnectionWrapper;
  tls.connect = state.tlsConnectWrapper;
  installedFence = state;

  const assertCurrent = (): void => {
    inspectCandidateRuntimeReadonlyEnvironmentProfile(process.env);
    if (
      !state.active
      || installedFence !== state
      || state.blockedAttempts !== 0
      || globalThis.fetch !== state.fetchWrapper
      || http.request !== state.httpRequestWrapper
      || http.get !== state.httpGetWrapper
      || https.request !== state.httpsRequestWrapper
      || https.get !== state.httpsGetWrapper
      || net.connect !== state.netConnectWrapper
      || net.createConnection !== state.netCreateConnectionWrapper
      || tls.connect !== state.tlsConnectWrapper
    ) {
      fail("CANDIDATE_READONLY_EGRESS_FENCE_CHANGED");
    }
  };
  const dispose = (): void => {
    if (installedFence !== state) return;
    globalThis.fetch = state.originalFetch;
    http.request = state.originalHttpRequest;
    http.get = state.originalHttpGet;
    https.request = state.originalHttpsRequest;
    https.get = state.originalHttpsGet;
    net.connect = state.originalNetConnect;
    net.createConnection = state.originalNetCreateConnection;
    tls.connect = state.originalTlsConnect;
    state.active = false;
    installedFence = null;
  };
  return Object.freeze({
    assertCurrent,
    blockedAttemptCount: () => state.blockedAttempts,
    dispose,
  });
}

export function assertCandidateReadonlyLoopbackEgressFenceCurrent(): void {
  if (!installedFence) fail("CANDIDATE_READONLY_EGRESS_NOT_INSTALLED");
  inspectCandidateRuntimeReadonlyEnvironmentProfile(process.env);
  if (
    installedFence.blockedAttempts !== 0
    || !installedFence.active
    || globalThis.fetch !== installedFence.fetchWrapper
    || http.request !== installedFence.httpRequestWrapper
    || http.get !== installedFence.httpGetWrapper
    || https.request !== installedFence.httpsRequestWrapper
    || https.get !== installedFence.httpsGetWrapper
    || net.connect !== installedFence.netConnectWrapper
    || net.createConnection !== installedFence.netCreateConnectionWrapper
    || tls.connect !== installedFence.tlsConnectWrapper
  ) {
    fail("CANDIDATE_READONLY_EGRESS_FENCE_CHANGED");
  }
}

/** The formal child is launched by macOS sandbox-exec with
 * `(deny network-outbound)`. This live negative probe must run before the
 * JavaScript transport wrappers are installed; EPERM/EACCES is the kernel
 * evidence that the process cannot open any outbound socket, including to a
 * local proxy. */
export async function proveCandidateMacOsOutboundNetworkDenied(): Promise<void> {
  if (process.platform !== "darwin" || macOsOutboundNetworkDeniedAttested) {
    if (!macOsOutboundNetworkDeniedAttested) {
      fail("CANDIDATE_READONLY_OS_NETWORK_SANDBOX_UNAVAILABLE");
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    // RFC 5737 TEST-NET-1: never targets a real provider or Internet service.
    const socket = net.connect({ host: "192.0.2.1", port: 443 });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CandidateReadonlyLoopbackEgressFenceError(
        "CANDIDATE_READONLY_OS_NETWORK_SANDBOX_NOT_ENFORCED",
      ));
    }, 2_000);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new CandidateReadonlyLoopbackEgressFenceError(
        "CANDIDATE_READONLY_OS_NETWORK_SANDBOX_NOT_ENFORCED",
      ));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "EPERM" || error.code === "EACCES") resolve();
      else reject(new CandidateReadonlyLoopbackEgressFenceError(
        "CANDIDATE_READONLY_OS_NETWORK_SANDBOX_NOT_ENFORCED",
      ));
    });
  });
  macOsOutboundNetworkDeniedAttested = true;
}

export function assertCandidateReadonlyFormalEgressSafetyCurrent(): void {
  if (!macOsOutboundNetworkDeniedAttested) {
    fail("CANDIDATE_READONLY_OS_NETWORK_SANDBOX_NOT_ATTESTED");
  }
  assertCandidateReadonlyLoopbackEgressFenceCurrent();
}
