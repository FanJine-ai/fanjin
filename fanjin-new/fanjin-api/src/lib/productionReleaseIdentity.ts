const PLATFORM_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

// Keep this contract aligned with the signed release-artifact builder and
// node agent. A releaseId is an opaque immutable deployment identifier, not
// the product version embedded in the application bundle.
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function isProductionPlatformVersion(value: unknown): value is string {
  return PLATFORM_VERSION_PATTERN.test(String(value ?? ""));
}

export function isProductionReleaseId(value: unknown): value is string {
  return RELEASE_ID_PATTERN.test(String(value ?? ""));
}
