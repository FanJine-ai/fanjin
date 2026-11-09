import { isProductionRuntime } from "@/lib/legacyAsyncRelaySafety";
import { isPreviewProviderDispatchDisabled } from "@/lib/relayChannelCredential";

type RealtimeEnvironment = Record<string, string | undefined>;

const REQUIRED_PRODUCTION_VARIABLES = [
  "FANJIN_REALTIME_ALLOWED_PROVIDERS",
  "FANJIN_REALTIME_ALLOWED_MODELS",
  "FANJIN_REALTIME_ALLOWED_ORIGINS",
  "FANJIN_REALTIME_CREDENTIAL_SOURCE",
  "FANJIN_REALTIME_CONNECT_TIMEOUT_MS",
  "FANJIN_REALTIME_IDLE_TIMEOUT_MS",
  "FANJIN_REALTIME_MAX_SESSION_MS",
  "FANJIN_REALTIME_MAX_OUTPUT_TOKENS",
  "FANJIN_REALTIME_REQUIRE_USAGE",
  "FANJIN_REALTIME_REQUIRE_BILLING",
  "FANJIN_REALTIME_ABORT_ON_DISCONNECT",
] as const;

export const REALTIME_RELAY_UNAVAILABLE_MESSAGE = "REALTIME_NOT_AVAILABLE";

export interface RealtimeRelayConfiguration {
  enabled: boolean;
  allowedProviders: string[];
  allowedModels: string[];
  allowedOrigins: string[];
  credentialSource: "channel";
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxSessionMs: number;
  maxOutputTokens: number;
  requireUsage: true;
  requireBilling: true;
  abortOnDisconnect: true;
}

export interface RealtimeRelayInspection {
  status: "disabled" | "incomplete" | "configured" | "development";
  ready: boolean;
  enabled: boolean;
  missingVariables: string[];
  invalidVariables: string[];
  allowedProviders: string[];
  allowedModels: string[];
  allowedOrigins: string[];
  externalValidationRequired: boolean;
}

export class RealtimeRelaySafetyError extends Error {
  readonly code: string;
  readonly closeCode: number;

  constructor(code: string, closeCode = 1008) {
    super(code);
    this.name = "RealtimeRelaySafetyError";
    this.code = code;
    this.closeCode = closeCode;
  }
}

function value(environment: RealtimeEnvironment, name: string): string {
  return String(environment[name] || "").trim();
}

function csv(environment: RealtimeEnvironment, name: string): string[] {
  return [...new Set(value(environment, name).split(",").map((item) => item.trim()).filter(Boolean))];
}

function boundedInteger(
  environment: RealtimeEnvironment,
  name: string,
  minimum: number,
  maximum: number,
): number | null {
  const parsed = Number(value(environment, name));
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function validOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function inspectRealtimeRelayConfiguration(
  environment: RealtimeEnvironment = process.env,
  nodeEnv = environment.NODE_ENV,
): RealtimeRelayInspection {
  if (isPreviewProviderDispatchDisabled(environment)) {
    return {
      status: "disabled",
      ready: true,
      enabled: false,
      missingVariables: [],
      invalidVariables: [],
      allowedProviders: [],
      allowedModels: [],
      allowedOrigins: [],
      externalValidationRequired: false,
    };
  }
  if (!isProductionRuntime(nodeEnv)) {
    return {
      status: "development",
      ready: true,
      enabled: true,
      missingVariables: [],
      invalidVariables: [],
      allowedProviders: csv(environment, "FANJIN_REALTIME_ALLOWED_PROVIDERS"),
      allowedModels: csv(environment, "FANJIN_REALTIME_ALLOWED_MODELS"),
      allowedOrigins: csv(environment, "FANJIN_REALTIME_ALLOWED_ORIGINS"),
      externalValidationRequired: false,
    };
  }

  const enabled = value(environment, "FANJIN_REALTIME_ENABLED") === "1";
  if (!enabled) {
    return {
      status: "disabled",
      ready: true,
      enabled: false,
      missingVariables: [],
      invalidVariables: [],
      allowedProviders: [],
      allowedModels: [],
      allowedOrigins: [],
      externalValidationRequired: false,
    };
  }

  const missingVariables = REQUIRED_PRODUCTION_VARIABLES.filter((name) => !value(environment, name));
  const invalidVariables: string[] = [];
  const allowedProviders = csv(environment, "FANJIN_REALTIME_ALLOWED_PROVIDERS").map((item) => item.toLowerCase());
  const allowedModels = csv(environment, "FANJIN_REALTIME_ALLOWED_MODELS");
  const allowedOrigins = csv(environment, "FANJIN_REALTIME_ALLOWED_ORIGINS");
  if (allowedProviders.some((provider) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider))) {
    invalidVariables.push("FANJIN_REALTIME_ALLOWED_PROVIDERS");
  }
  if (allowedModels.some((model) => model.length > 160 || /[\s?#]/.test(model))) {
    invalidVariables.push("FANJIN_REALTIME_ALLOWED_MODELS");
  }
  if (allowedOrigins.some((origin) => !validOrigin(origin))) {
    invalidVariables.push("FANJIN_REALTIME_ALLOWED_ORIGINS");
  }
  if (value(environment, "FANJIN_REALTIME_CREDENTIAL_SOURCE") !== "channel") {
    invalidVariables.push("FANJIN_REALTIME_CREDENTIAL_SOURCE");
  }
  const numericRules = [
    ["FANJIN_REALTIME_CONNECT_TIMEOUT_MS", 1_000, 30_000],
    ["FANJIN_REALTIME_IDLE_TIMEOUT_MS", 5_000, 300_000],
    ["FANJIN_REALTIME_MAX_SESSION_MS", 10_000, 3_600_000],
    ["FANJIN_REALTIME_MAX_OUTPUT_TOKENS", 1, 1_000_000],
  ] as const;
  for (const [name, minimum, maximum] of numericRules) {
    if (value(environment, name) && boundedInteger(environment, name, minimum, maximum) === null) {
      invalidVariables.push(name);
    }
  }
  for (const name of [
    "FANJIN_REALTIME_REQUIRE_USAGE",
    "FANJIN_REALTIME_REQUIRE_BILLING",
    "FANJIN_REALTIME_ABORT_ON_DISCONNECT",
  ]) {
    if (value(environment, name) && value(environment, name) !== "1") invalidVariables.push(name);
  }

  return {
    status: missingVariables.length || invalidVariables.length ? "incomplete" : "configured",
    ready: missingVariables.length === 0 && invalidVariables.length === 0,
    enabled,
    missingVariables: [...new Set(missingVariables)],
    invalidVariables: [...new Set(invalidVariables)],
    allowedProviders,
    allowedModels,
    allowedOrigins,
    externalValidationRequired: missingVariables.length === 0 && invalidVariables.length === 0,
  };
}

export function resolveRealtimeRelayConfiguration(
  environment: RealtimeEnvironment = process.env,
  nodeEnv = environment.NODE_ENV,
): RealtimeRelayConfiguration {
  const inspection = inspectRealtimeRelayConfiguration(environment, nodeEnv);
  if (isPreviewProviderDispatchDisabled(environment) || (isProductionRuntime(nodeEnv) && !inspection.enabled)) {
    throw new RealtimeRelaySafetyError("REALTIME_DISABLED", 1013);
  }
  if (!inspection.ready) throw new RealtimeRelaySafetyError("REALTIME_CONFIGURATION_INVALID", 1013);
  return {
    enabled: true,
    allowedProviders: inspection.allowedProviders,
    allowedModels: inspection.allowedModels,
    allowedOrigins: inspection.allowedOrigins,
    credentialSource: "channel",
    connectTimeoutMs: boundedInteger(environment, "FANJIN_REALTIME_CONNECT_TIMEOUT_MS", 1_000, 30_000) || 10_000,
    idleTimeoutMs: boundedInteger(environment, "FANJIN_REALTIME_IDLE_TIMEOUT_MS", 5_000, 300_000) || 60_000,
    maxSessionMs: boundedInteger(environment, "FANJIN_REALTIME_MAX_SESSION_MS", 10_000, 3_600_000) || 300_000,
    maxOutputTokens: boundedInteger(environment, "FANJIN_REALTIME_MAX_OUTPUT_TOKENS", 1, 1_000_000) || 4_096,
    requireUsage: true,
    requireBilling: true,
    abortOnDisconnect: true,
  };
}

export function assertRealtimeRequestAllowed(input: {
  model: string;
  origin?: string | null;
  provider?: string | null;
  environment?: RealtimeEnvironment;
  nodeEnv?: string;
}): RealtimeRelayConfiguration {
  const environment = input.environment || process.env;
  const nodeEnv = input.nodeEnv ?? environment.NODE_ENV;
  const configuration = resolveRealtimeRelayConfiguration(environment, nodeEnv);
  if (!isProductionRuntime(nodeEnv)) return configuration;
  if (!configuration.allowedModels.includes(input.model)) {
    throw new RealtimeRelaySafetyError("REALTIME_MODEL_NOT_ALLOWED");
  }
  if (!input.origin) throw new RealtimeRelaySafetyError("REALTIME_ORIGIN_REQUIRED");
  if (!configuration.allowedOrigins.includes(input.origin)) {
    throw new RealtimeRelaySafetyError("REALTIME_ORIGIN_NOT_ALLOWED");
  }
  if (input.provider && !configuration.allowedProviders.includes(input.provider.toLowerCase())) {
    throw new RealtimeRelaySafetyError("REALTIME_PROVIDER_NOT_ALLOWED");
  }
  return configuration;
}

export function realtimeRelayAvailable(
  nodeEnv = process.env.NODE_ENV,
  environment: RealtimeEnvironment = process.env,
): boolean {
  if (isPreviewProviderDispatchDisabled(environment)) return false;
  if (!isProductionRuntime(nodeEnv)) return true;
  const inspection = inspectRealtimeRelayConfiguration(environment, nodeEnv);
  return inspection.enabled && inspection.ready;
}
