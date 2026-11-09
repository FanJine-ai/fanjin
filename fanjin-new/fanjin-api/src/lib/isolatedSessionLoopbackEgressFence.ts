import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import {
  inspectIsolatedSessionEvidenceRuntimeEnvironment,
  isIsolatedSessionEvidenceMode,
} from "@/lib/isolatedSessionEvidenceRuntime";

export class IsolatedSessionLoopbackEgressFenceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "IsolatedSessionLoopbackEgressFenceError";
  }
}
function fail(code: string): never {
  throw new IsolatedSessionLoopbackEgressFenceError(code);
}

function exactLoopbackHost(value: unknown): boolean {
  return String(value || "") === "127.0.0.1";
}

export function assertIsolatedSessionLoopbackUrl(value: unknown): URL {
  let parsed: URL;
  try {
    parsed = value instanceof URL ? new URL(value.toString()) : new URL(String(value));
  } catch {
    return fail("ISOLATED_SESSION_EGRESS_TARGET_INVALID");
  }
  if (
    parsed.protocol !== "http:"
    || !exactLoopbackHost(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.hash
  ) return fail("ISOLATED_SESSION_EGRESS_NON_LOOPBACK_BLOCKED");
  return parsed;
}

type FenceState = {
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

let installedFence: FenceState | null = null;

function block(state: FenceState): never {
  state.blockedAttempts += 1;
  return fail("ISOLATED_SESSION_EGRESS_NON_LOOPBACK_BLOCKED");
}

function httpTarget(args: readonly unknown[]): URL | null {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    return assertIsolatedSessionLoopbackUrl(first);
  }
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const options = first as Record<string, unknown>;
  if (options.socketPath) return null;
  const protocol = String(options.protocol || "http:");
  const hostname = String(options.hostname || options.host || "");
  const port = options.port === undefined ? "" : `:${String(options.port)}`;
  if (!hostname) return null;
  return assertIsolatedSessionLoopbackUrl(`${protocol}//${hostname}${port}/`);
}

function netHost(args: readonly unknown[]): string {
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const options = first as Record<string, unknown>;
    if (options.path || options.socketPath) return "";
    return String(options.host || "");
  }
  if (typeof first === "number") return String(args[1] || "");
  return "";
}

/**
 * Local, non-formal process fence for isolated-session evidence.  It must be
 * installed before application/provider imports.  Only exact HTTP/TCP
 * 127.0.0.1 targets are admitted; provider HTTPS and all non-loopback sockets
 * are rejected even if a credential accidentally appears later.
 */
export function installIsolatedSessionLoopbackEgressFence(): Readonly<{
  assertCurrent: () => void;
  blockedAttemptCount: () => number;
  dispose: () => void;
}> {
  if (installedFence) return fail("ISOLATED_SESSION_EGRESS_ALREADY_INSTALLED");
  if (!isIsolatedSessionEvidenceMode()) {
    return fail("ISOLATED_SESSION_EGRESS_MODE_NOT_ENABLED");
  }
  inspectIsolatedSessionEvidenceRuntimeEnvironment(process.env);
  const state = {} as FenceState;
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
      assertIsolatedSessionLoopbackUrl(
        input instanceof Request ? input.url : input,
      );
    } catch {
      return block(state);
    }
    return state.originalFetch(input, init);
  }) as typeof globalThis.fetch;
  state.httpRequestWrapper = ((...args: unknown[]) => {
    try {
      if (!httpTarget(args)) return block(state);
    } catch {
      return block(state);
    }
    return (state.originalHttpRequest as (...values: unknown[]) => unknown)(...args);
  }) as typeof http.request;
  state.httpGetWrapper = ((...args: unknown[]) => {
    try {
      if (!httpTarget(args)) return block(state);
    } catch {
      return block(state);
    }
    return (state.originalHttpGet as (...values: unknown[]) => unknown)(...args);
  }) as typeof http.get;
  state.httpsRequestWrapper = ((..._args: unknown[]) => block(state)) as typeof https.request;
  state.httpsGetWrapper = ((..._args: unknown[]) => block(state)) as typeof https.get;
  state.netConnectWrapper = ((...args: unknown[]) => {
    if (!exactLoopbackHost(netHost(args))) return block(state);
    return (state.originalNetConnect as (...values: unknown[]) => unknown)(...args);
  }) as typeof net.connect;
  state.netCreateConnectionWrapper = ((...args: unknown[]) => {
    if (!exactLoopbackHost(netHost(args))) return block(state);
    return (state.originalNetCreateConnection as (...values: unknown[]) => unknown)(...args);
  }) as typeof net.createConnection;
  state.tlsConnectWrapper = ((...args: unknown[]) => {
    if (!exactLoopbackHost(netHost(args))) return block(state);
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
    inspectIsolatedSessionEvidenceRuntimeEnvironment(process.env);
    if (
      installedFence !== state
      || !state.active
      || state.blockedAttempts !== 0
      || globalThis.fetch !== state.fetchWrapper
      || http.request !== state.httpRequestWrapper
      || http.get !== state.httpGetWrapper
      || https.request !== state.httpsRequestWrapper
      || https.get !== state.httpsGetWrapper
      || net.connect !== state.netConnectWrapper
      || net.createConnection !== state.netCreateConnectionWrapper
      || tls.connect !== state.tlsConnectWrapper
    ) return fail("ISOLATED_SESSION_EGRESS_FENCE_CHANGED");
  };
  return Object.freeze({
    assertCurrent,
    blockedAttemptCount: () => state.blockedAttempts,
    dispose: () => {
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
    },
  });
}
