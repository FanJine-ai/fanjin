/** Public identity only. No secrets, key references, signatures or native MACs. */
export function productionRuntimeConfigIdentity(environment: NodeJS.ProcessEnv = process.env): {
  schema: "fanjin-runtime-config-identity/v1";
  configSha: string;
  configRevision: number;
  targetId: string;
  environment: "test" | "production";
} | null {
  const configSha = environment.FANJIN_RUNTIME_CONFIG_SHA256;
  const configRevision = Number(environment.FANJIN_RUNTIME_CONFIG_REVISION);
  const targetId = environment.FANJIN_RELEASE_TARGET_ID;
  const releaseEnvironment = environment.FANJIN_RELEASE_ENVIRONMENT;
  if (!configSha || !/^sha256:[a-f0-9]{64}$/.test(configSha)
    || !Number.isSafeInteger(configRevision) || configRevision < 1
    || !targetId || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(targetId)
    || (releaseEnvironment !== "test" && releaseEnvironment !== "production")) return null;
  return { schema: "fanjin-runtime-config-identity/v1", configSha, configRevision, targetId, environment: releaseEnvironment };
}
