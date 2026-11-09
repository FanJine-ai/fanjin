import crypto from "node:crypto";
import { AuthError } from "@/lib/authErrors";

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
};

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey);
    });
  });
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64");
}

export function isPasswordHash(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(`${SCRYPT_PREFIX}$`);
}

export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new AuthError("密码不能为空");
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_PARAMS);
  return [SCRYPT_PREFIX, SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, toBase64Url(salt), toBase64Url(key)].join("$");
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    // Compare equal-length buffers so length differences do not short-circuit early.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export async function verifyPassword(password: string, storedPassword: string | null | undefined): Promise<boolean> {
  if (!storedPassword) return false;
  if (!isPasswordHash(storedPassword)) {
    // Legacy plaintext rows only. Login upgrades them to scrypt on success.
    return timingSafeStringEqual(password, storedPassword);
  }

  const parts = storedPassword.split("$");
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return false;
  const [, n, r, p, saltValue, keyValue] = parts;
  const expectedKey = fromBase64Url(keyValue);
  const actualKey = await scrypt(password, fromBase64Url(saltValue), expectedKey.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 32 * 1024 * 1024,
  });

  if (actualKey.length !== expectedKey.length) return false;
  return crypto.timingSafeEqual(actualKey, expectedKey);
}
