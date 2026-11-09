import { createHash, createPublicKey, sign, verify } from "node:crypto";

export const FORMAT = "fanjin-community-update/v1";
export const MAX_PACKAGE = 4 * 1024 ** 3;
export const MAX_EXPANDED = 8 * 1024 ** 3;
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
export function ensure(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
export const sha256 = value => createHash("sha256").update(value).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  ensure(value === null || ["string", "boolean", "number"].includes(typeof value), "INVALID_JSON");
  ensure(typeof value !== "number" || Number.isFinite(value), "INVALID_NUMBER");
  return JSON.stringify(value);
}
export const digest = value => sha256(canonical(value));
export function exact(value, keys) {
  ensure(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(","), "INVALID_FIELDS");
}
export function relativeFile(value) {
  ensure(typeof value === "string" && value.length <= 1024 && !value.includes("\\")
    && !/[\x00-\x1f\x7f:]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..")
    && !value.split("/").some(part => part === ".git" || part === ".env" || part.startsWith(".env.") || part === ".fanjin-data"),
  "INVALID_PACKAGE_PATH");
  return value;
}
export function versionParts(value) {
  ensure(typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), "INVALID_VERSION");
  const parts = value.split(".").map(Number);
  ensure(parts.every(Number.isSafeInteger), "INVALID_VERSION");
  return parts;
}
export function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  return Math.sign(x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
}
export function validateManifest(m) {
  exact(m, ["schema", "product", "version", "sourceCommit", "sourceDigest", "channel", "sequence", "platform",
    "createdAt", "expiresAt", "minimumVersion", "minimumUpdaterVersion", "databaseSchema", "notes", "package", "files"]);
  ensure(m.schema === FORMAT && m.product === "fanjin-community", "WRONG_PRODUCT");
  versionParts(m.version); versionParts(m.minimumVersion); versionParts(m.minimumUpdaterVersion);
  ensure(compareVersions(m.minimumVersion, m.version) <= 0, "INVALID_VERSION_RANGE");
  ensure(/^[a-f0-9]{40}$/.test(m.sourceCommit) && /^[a-f0-9]{64}$/.test(m.sourceDigest), "INVALID_SOURCE");
  ensure(["stable", "preview"].includes(m.channel) && PLATFORMS.includes(m.platform), "INVALID_TARGET");
  ensure(Number.isSafeInteger(m.sequence) && m.sequence > 0 && Number.isSafeInteger(m.databaseSchema) && m.databaseSchema >= 0, "INVALID_SEQUENCE");
  const start = Date.parse(m.createdAt), end = Date.parse(m.expiresAt);
  ensure(Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 180 * 86400000, "INVALID_VALIDITY");
  ensure(typeof m.notes === "string" && m.notes.length <= 16000, "INVALID_NOTES");
  exact(m.package, ["sha256", "size"]);
  ensure(/^[a-f0-9]{64}$/.test(m.package.sha256) && Number.isSafeInteger(m.package.size)
    && m.package.size > 0 && m.package.size <= MAX_PACKAGE, "INVALID_PACKAGE");
  ensure(Array.isArray(m.files) && m.files.length > 0 && m.files.length <= 150000, "INVALID_INVENTORY");
  let expanded = 0; const seen = new Set();
  for (const file of m.files) {
    exact(file, ["path", "size", "sha256", "executable"]);
    relativeFile(file.path);
    ensure(!seen.has(file.path.toLowerCase()), "DUPLICATE_PACKAGE_PATH"); seen.add(file.path.toLowerCase());
    ensure(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 512 * 1024 ** 2
      && /^[a-f0-9]{64}$/.test(file.sha256) && typeof file.executable === "boolean", "INVALID_FILE");
    expanded += file.size;
  }
  ensure(expanded <= MAX_EXPANDED && seen.has("app/fanjin-new/fanjin-api/build-public/app.cjs")
    && seen.has("app/fanjin-new/fanjin-v4/dist/index.html"), "INCOMPLETE_RUNTIME");
  return m;
}
export function seal(manifest, keyId, privateKey) {
  validateManifest(manifest);
  ensure(/^[a-zA-Z0-9._-]{1,80}$/.test(keyId), "INVALID_KEY_ID");
  ensure(createPublicKey(privateKey).asymmetricKeyType === "ed25519", "WRONG_KEY_TYPE");
  const payload = { keyId, manifest };
  return { ...payload, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64") };
}
export function verifyEnvelope(envelope, trustedKeys, now = Date.now()) {
  exact(envelope, ["keyId", "manifest", "signature"]);
  const key = trustedKeys.find(key => key.keyId === envelope.keyId);
  ensure(key && typeof envelope.signature === "string" && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature), "UNTRUSTED_SIGNATURE");
  const publicKey = createPublicKey(key.publicKey);
  ensure(publicKey.asymmetricKeyType === "ed25519" && verify(null,
    Buffer.from(canonical({ keyId: envelope.keyId, manifest: envelope.manifest })), publicKey,
    Buffer.from(envelope.signature, "base64")), "UNTRUSTED_SIGNATURE");
  const m = validateManifest(envelope.manifest);
  ensure(Date.parse(m.createdAt) <= now + 300000 && Date.parse(m.expiresAt) > now, "EXPIRED_MANIFEST");
  return m;
}
