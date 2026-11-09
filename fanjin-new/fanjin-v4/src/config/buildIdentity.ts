export type FrontendBuildEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveFrontendBuildId(
  environment: FrontendBuildEnvironment,
  productVersion: string,
): string {
  const explicit = environment.VITE_BUILD_ID?.trim();
  if (explicit) return explicit;

  const stableVersion = productVersion.trim();
  return stableVersion || "unknown";
}
