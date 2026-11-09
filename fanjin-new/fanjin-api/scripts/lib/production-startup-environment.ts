import { createHash, timingSafeEqual } from "node:crypto";
import type { SubjectRuntimeConfig } from "../../src/lib/releaseProtocol/subjectRuntimeConfig";
import { ProductionStartupError, startupFailure } from "./production-startup-files";

export interface StartupEnvironmentIdentity {
  role: "api" | "worker";
  releaseId: string;
  sourceCommit: string;
  artifactSha256: string;
  schemaVersion: number;
  configSha: string;
  configRevision: number;
  targetId: string;
  environment: "test" | "production";
}

// These are transport/process identity, never operator-controlled application settings.
// Every other value consumed by the application must be in the signed configuration.
function structuralValues(identity: StartupEnvironmentIdentity): Record<string, string> {
  return {
    NODE_ENV: "prod",
    FANJIN_PROCESS_ROLE: identity.role,
    FANJIN_APP_ROOT: "/app",
    FANJIN_DATABASE_CLIENT: "postgres",
    FANJIN_AUTO_MIGRATE: "0",
    FANJIN_DISABLE_LOCAL_ENV: "1",
    FANJIN_DISABLE_LOCAL_KEYCHAIN_SECRETS: "1",
    FANJIN_REQUIRE_PRODUCTION_PRESTART_RECEIPT: "1",
    FANJIN_READINESS_ALLOW_FAIL: "0",
    FANJIN_MIGRATION_REQUIRE_POSTGRES: "1",
    FANJIN_DISABLE_RELAY_WORKER: identity.role === "api" ? "1" : "0",
    FANJIN_EXPECT_EXTERNAL_WORKER: identity.role === "api" ? "1" : "0",
    FANJIN_RELEASE_ID: identity.releaseId,
    FANJIN_SOURCE_COMMIT: identity.sourceCommit,
    FANJIN_ARTIFACT_SHA256: identity.artifactSha256,
    FANJIN_RELEASE_SCHEMA_VERSION: String(identity.schemaVersion),
    FANJIN_RUNTIME_CONFIG_SHA256: identity.configSha,
    FANJIN_RUNTIME_CONFIG_REVISION: String(identity.configRevision),
    FANJIN_RELEASE_TARGET_ID: identity.targetId,
    FANJIN_RELEASE_ENVIRONMENT: identity.environment,
    FANJIN_RELEASE_MANIFEST_FILE: "/opt/fanjin/release/release-manifest.json",
    FANJIN_RELEASE_META_FILE: "/opt/fanjin/release/release-meta.json",
    FANJIN_MODULAR_RUNTIME_PROOF_FILE: "/opt/fanjin/release/modular-runtime-proof.json",
  };
}

const HOST_ENVIRONMENT_NAMES = new Set([
  "PATH", "HOME", "HOSTNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "PWD", "SHLVL", "_",
  "NODE_VERSION", "YARN_VERSION",
]);

/** Validate the actual bytes, not just a claimed configSha environment variable. */
export function verifyProductionStartupEnvironment(
  actual: NodeJS.ProcessEnv,
  config: SubjectRuntimeConfig,
  identity: StartupEnvironmentIdentity,
): void {
  const expected = structuralValues(identity);
  const signedNames = new Set<string>();
  for (const variable of config.runtime.variables) {
    if (Object.hasOwn(expected, variable.name) || HOST_ENVIRONMENT_NAMES.has(variable.name)
      || variable.name === "FANJIN_ENV_FILE" || variable.name === "FANJIN_PRODUCTION_PRESTART_RECEIPT"
      || variable.name.startsWith("FANJIN_BOOTSTRAP_") || variable.name === "NODE_OPTIONS"
      || variable.name === "LD_PRELOAD" || variable.name === "LD_LIBRARY_PATH") {
      startupFailure("CONFIG_RUNTIME_RESERVED_VARIABLE", "startup-config", "Signed configuration contains a reserved process variable");
    }
    expected[variable.name] = variable.value;
    signedNames.add(variable.name);
  }
  for (const secret of config.runtime.secrets) {
    if (Object.hasOwn(expected, secret.name) || HOST_ENVIRONMENT_NAMES.has(secret.name)
      || secret.name.startsWith("FANJIN_BOOTSTRAP_") || ["FANJIN_ENV_FILE", "FANJIN_PRODUCTION_PRESTART_RECEIPT", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"].includes(secret.name)) {
      startupFailure("CONFIG_RUNTIME_RESERVED_VARIABLE", "startup-config", "Signed secret uses a reserved process variable");
    }
    const value = actual[secret.name];
    const observed = createHash("sha256").update(value ?? "", "utf8").digest();
    const wanted = Buffer.from(secret.secretSha256.slice(7), "hex");
    if (value === undefined || observed.length !== wanted.length || !timingSafeEqual(observed, wanted)) {
      throw new ProductionStartupError("CONFIG_RECEIPT_MISMATCH", "startup-config", "Runtime secret does not match its signed version", { variable: secret.name });
    }
    signedNames.add(secret.name);
  }
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) {
      throw new ProductionStartupError("CONFIG_RECEIPT_MISMATCH", "startup-config", "Runtime value does not match its signed configuration", { variable: name });
    }
  }
  for (const [name, value] of Object.entries(actual)) {
    if (value === undefined || HOST_ENVIRONMENT_NAMES.has(name) || Object.hasOwn(expected, name) || signedNames.has(name)) continue;
    throw new ProductionStartupError("CONFIG_UNBOUND_RUNTIME_VARIABLE", "startup-config", "Runtime contains an unsigned application variable", { variable: name });
  }
  if (actual.NODE_TLS_REJECT_UNAUTHORIZED === "0" || actual.FANJIN_ALLOW_DEFAULT_ROOT_PASSWORD === "1") {
    startupFailure("CONFIG_RUNTIME_UNSAFE", "startup-config", "Runtime configuration enables an unsafe production override");
  }
}
