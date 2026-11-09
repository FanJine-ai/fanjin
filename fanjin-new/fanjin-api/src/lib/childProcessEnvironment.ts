/**
 * Returns a copy of the current environment that is safe to pass to media
 * tooling. Provider credentials are injected into the API process at runtime
 * for the isolated real-candidate harness; ffmpeg/ffprobe must never inherit
 * them (or unrelated application credentials) by default.
 *
 * PATH, HOME, temporary-directory and locale variables are deliberately
 * retained so executable discovery and native media tooling keep working.
 */

const ALWAYS_REMOVE = new Set([
  "FANJIN_PROVIDER_NEWAPI_SINE_API_KEY",
  "VOLCANO_ARK_API_KEY",
  "DATABASE_URL",
  "FANJIN_RELEASE_DATABASE_URL",
  "REDIS_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "SSH_AUTH_SOCK",
]);

const ALWAYS_RETAIN = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
]);

const SENSITIVE_NAME_SEGMENT =
  /(?:^|_)(?:API_KEY|ACCESS_KEY(?:_ID)?|SECRET(?:_ACCESS)?_KEY|PRIVATE_KEY|ENCRYPTION_KEY|SIGNING_KEY|CREDENTIALS?|TOKEN|PASSWORD|PASSWD|AUTH(?:ORIZATION)?|COOKIE|SESSION)(?:_|$)/i;

function isSensitiveChildEnvironmentName(name: string): boolean {
  const normalized = name.trim().toUpperCase();
  if (!normalized) return true;
  if (ALWAYS_RETAIN.has(normalized)) return false;
  if (ALWAYS_REMOVE.has(normalized)) return true;
  if (SENSITIVE_NAME_SEGMENT.test(normalized)) return true;
  return /(?:^|_)(?:DATABASE|REDIS)_URL$/i.test(normalized);
}

export function sanitizeChildProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isSensitiveChildEnvironmentName(name)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}
