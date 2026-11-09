import { ReleaseDeploymentError } from "@/lib/releaseDeploymentError";

export const LEGACY_RELEASE_DEPLOYMENT_WRITES_ENV =
  "FANJIN_LEGACY_RELEASE_DEPLOYMENT_WRITES_ENABLED" as const;

export function legacyReleaseDeploymentWritesEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = String(environment[LEGACY_RELEASE_DEPLOYMENT_WRITES_ENV] ?? "")
    .trim()
    .toLowerCase();
  if (value === "true") return true;
  if (value === "" || value === "false") return false;
  throw new ReleaseDeploymentError(
    `${LEGACY_RELEASE_DEPLOYMENT_WRITES_ENV} 必须为 true 或 false`,
    500,
    "LEGACY_RELEASE_DEPLOYMENT_CONFIG_INVALID",
  );
}

export function assertLegacyReleaseDeploymentWritesEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (legacyReleaseDeploymentWritesEnabled(environment)) return;
  throw new ReleaseDeploymentError(
    "旧滚动发布器已进入只读模式，请从统一发布器创建新的生产执行",
    410,
    "LEGACY_RELEASE_DEPLOYMENT_WRITES_DISABLED",
    { replacement: "/fjadmin/releases#release-control" },
  );
}
