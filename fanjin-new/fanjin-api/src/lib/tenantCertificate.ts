import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

import { db } from "@/utils/db";
import { normalizeTenantHostname } from "@/lib/tenantDomain";

export const TENANT_CERTIFICATE_TABLE = "o_tenant_certificate";

export type CertificateSource = "managed" | "imported" | "cert_center_reference";

export type CertificateStatus =
  | "pending"
  | "issued"
  | "active"
  | "expiring"
  | "expired"
  | "revoked"
  | "failed";

export type TenantCertificateRecord = {
  id: string;
  tenantId: string;
  source: CertificateSource;
  provider: string | null;
  providerCertificateId: string | null;
  commonName: string | null;
  sans: string[];
  fingerprintSha256: string | null;
  keyAlgorithm: string | null;
  keySize: number | null;
  issuer: string | null;
  serialNumber: string | null;
  notBefore: number | null;
  notAfter: number | null;
  status: CertificateStatus;
  renewalMode: string;
  replacesCertificateId: string | null;
  lastCheckedAt: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export class TenantCertificateError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "TENANT_CERTIFICATE_ERROR") {
    super(message);
    this.name = "TenantCertificateError";
    this.status = status;
    this.code = code;
  }
}

type CertDb = Knex | Knex.Transaction;

// ---------------------------------------------------------------------------
// 证书校验（node:crypto X509Certificate；无第三方依赖）
// ---------------------------------------------------------------------------

export type CertificateValidationFailureCode =
  | "CERT_PARSE_FAILED"
  | "KEY_PARSE_FAILED"
  | "KEY_MISMATCH"
  | "KEY_TOO_WEAK"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "EXPIRING_TOO_SOON"
  | "SAN_NOT_COVERING"
  | "SIGNATURE_ALGORITHM_WEAK";

export type CertificateValidationResult = {
  valid: boolean;
  failures: CertificateValidationFailureCode[];
  commonName: string | null;
  sans: string[];
  fingerprintSha256: string;
  keyAlgorithm: string;
  keySize: number;
  issuer: string | null;
  serialNumber: string | null;
  notBefore: number;
  notAfter: number;
};

const MIN_REMAINING_DAYS = 30;
const MIN_RSA_BITS = 2048;

/**
 * BYOC 证书校验（设计文档 §10.1.B）：
 * - 证书与私钥可解析且公钥匹配
 * - 签名算法、密钥强度符合基线
 * - 未过期且剩余有效期大于最小窗口
 * - SAN/CN 覆盖目标域名
 * 错误只返回类别，不回显 PEM 内容。
 */
export function validateCertificateForHostnames(input: {
  certificateChain: string;
  privateKey: string;
  hostnames: string[];
  minRemainingDays?: number;
  now?: number;
}): CertificateValidationResult {
  const now = input.now ?? Date.now();
  const minRemainingDays = input.minRemainingDays ?? MIN_REMAINING_DAYS;
  const failures: CertificateValidationFailureCode[] = [];

  let cert: crypto.X509Certificate;
  try {
    cert = new crypto.X509Certificate(input.certificateChain);
  } catch {
    throw new TenantCertificateError("证书链无法解析", 422, "CERT_PARSE_FAILED");
  }

  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(input.privateKey);
  } catch {
    throw new TenantCertificateError("私钥无法解析", 422, "KEY_PARSE_FAILED");
  }

  // 公私钥匹配
  const certPublicKey = cert.publicKey.export({ type: "spki", format: "der" });
  const privateKeyPublic = privateKey
    ? crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" })
    : Buffer.alloc(0);
  if (!certPublicKey.equals(privateKeyPublic)) {
    failures.push("KEY_MISMATCH");
  }

  const keyAlgorithm = String(cert.publicKey.asymmetricKeyType || "unknown");
  const keyDetails = cert.publicKey.asymmetricKeyDetails as Record<string, unknown> | undefined;
  const keySize = Number(keyDetails?.modulusLength ?? keyDetails?.keyLength ?? 0);
  if (keyAlgorithm === "rsa" && keySize > 0 && keySize < MIN_RSA_BITS) {
    failures.push("KEY_TOO_WEAK");
  }

  // 有效期
  const notBefore = new Date(cert.validFromDate).getTime();
  const notAfter = new Date(cert.validTo).getTime();
  if (Number.isFinite(notBefore) && notBefore > now) failures.push("NOT_YET_VALID");
  if (Number.isFinite(notAfter)) {
    if (notAfter <= now) failures.push("EXPIRED");
    else if (notAfter - now < minRemainingDays * 24 * 60 * 60 * 1000) failures.push("EXPIRING_TOO_SOON");
  }

  // 弱签名算法（X509Certificate 类型未声明 sigalg，运行时存在）
  const sigAlg = String((cert as any).sigalg || "").toLowerCase();
  if (/sha1|md5|md4/.test(sigAlg)) failures.push("SIGNATURE_ALGORITHM_WEAK");

  // 域名覆盖
  const commonName = extractCommonName(cert.subject);
  const sans = cert.subjectAltName
    ? cert.subjectAltName.split(",")
      .map((entry) => entry.trim().replace(/^DNS:/i, "").trim())
      .filter(Boolean)
    : [];
  const targetHosts = input.hostnames.map((host) => normalizeTenantHostname(host).hostname);
  const coversAll = targetHosts.every((hostname) =>
    [commonName, ...sans].some((name) => name && hostnameMatches(hostname, name)));
  if (!coversAll) failures.push("SAN_NOT_COVERING");

  return {
    valid: failures.length === 0,
    failures,
    commonName,
    sans,
    fingerprintSha256: cert.fingerprint256.replace(/:/g, "").toLowerCase(),
    keyAlgorithm,
    keySize,
    issuer: cert.issuer || null,
    serialNumber: cert.serialNumber || null,
    notBefore: Number.isFinite(notBefore) ? notBefore : 0,
    notAfter: Number.isFinite(notAfter) ? notAfter : 0,
  };
}

function extractCommonName(subject: string): string | null {
  const match = subject.match(/(?:^|,)CN=([^,]+)/i);
  return match ? match[1].trim() : null;
}

function hostnameMatches(hostname: string, pattern: string): boolean {
  if (pattern === hostname) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 证书中心客户端（可插拔：测试用内存实现；生产用火山引擎实现）
// ---------------------------------------------------------------------------

export type CertCenterImportResult = {
  providerCertificateId: string;
};

export type CertCenterCertificateInfo = {
  providerCertificateId: string;
  status: string;
  notBefore: number | null;
  notAfter: number | null;
  commonName: string | null;
  sans: string[];
};

export interface CertCenterClient {
  readonly providerId: string;
  importCertificate(input: {
    certificateChain: string;
    privateKey: string;
    name: string;
    idempotencyKey: string;
  }): Promise<CertCenterImportResult>;
  describeCertificate(providerCertificateId: string): Promise<CertCenterCertificateInfo | null>;
  deleteCertificate(providerCertificateId: string): Promise<void>;
}

/**
 * 内存证书中心：用于测试与本地开发。
 * 私钥仅在导入瞬间校验后丢弃，绝不持久化。
 */
export class InMemoryCertCenterClient implements CertCenterClient {
  readonly providerId = "memory_cert_center";
  private readonly certificates = new Map<string, { info: CertCenterCertificateInfo; fingerprint: string }>();
  private readonly importedKeys = new Map<string, string>();

  async importCertificate(input: {
    certificateChain: string;
    privateKey: string;
    name: string;
    idempotencyKey: string;
  }): Promise<CertCenterImportResult> {
    const existing = this.importedKeys.get(input.idempotencyKey);
    if (existing) return { providerCertificateId: existing };
    const cert = new crypto.X509Certificate(input.certificateChain);
    const id = `mem-cert-${crypto.randomBytes(8).toString("hex")}`;
    const notBefore = new Date(cert.validFromDate).getTime();
    const notAfter = new Date(cert.validTo).getTime();
    this.certificates.set(id, {
      info: {
        providerCertificateId: id,
        status: "active",
        notBefore: Number.isFinite(notBefore) ? notBefore : null,
        notAfter: Number.isFinite(notAfter) ? notAfter : null,
        commonName: extractCommonName(cert.subject),
        sans: cert.subjectAltName
          ? cert.subjectAltName.split(",")
            .map((entry) => entry.trim().replace(/^DNS:/i, "").trim())
            .filter(Boolean)
          : [],
      },
      fingerprint: cert.fingerprint256,
    });
    this.importedKeys.set(input.idempotencyKey, id);
    // 私钥在受控范围内即刻丢弃，不做任何持久化。
    return { providerCertificateId: id };
  }

  async describeCertificate(providerCertificateId: string): Promise<CertCenterCertificateInfo | null> {
    return this.certificates.get(providerCertificateId)?.info ?? null;
  }

  async deleteCertificate(providerCertificateId: string): Promise<void> {
    this.certificates.delete(providerCertificateId);
  }
}

/**
 * 火山引擎证书中心客户端（POST + V4 签名）。
 * 注意：真实云调用需专用 IAM 凭据；未配置时抛错而不是退化为模拟。
 * 云端连通性验收列为"等待外部验收"项。
 */
export class VolcengineCertCenterClient implements CertCenterClient {
  readonly providerId = "volcengine_certificate_center";

  constructor(private readonly options: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    host?: string;
    fetchFn?: typeof fetch;
  }) {
    if (!options.accessKeyId || !options.secretAccessKey || !options.region) {
      throw new TenantCertificateError(
        "证书中心凭据未配置",
        503,
        "CERT_CENTER_NOT_CONFIGURED",
      );
    }
  }

  async importCertificate(input: {
    certificateChain: string;
    privateKey: string;
    name: string;
    idempotencyKey: string;
  }): Promise<CertCenterImportResult> {
    const body = JSON.stringify({
      Certificate: input.certificateChain,
      PrivateKey: input.privateKey,
      Name: input.name,
      ClientToken: input.idempotencyKey,
    });
    const response = await this.call("ImportCertificate", body);
    const certificateId = String((response as any)?.ResponseMetadata?.CertificateId
      ?? (response as any)?.Result?.CertificateId
      ?? "");
    if (!certificateId) {
      throw new TenantCertificateError("证书中心导入失败", 502, "CERT_CENTER_IMPORT_FAILED");
    }
    return { providerCertificateId: certificateId };
  }

  async describeCertificate(providerCertificateId: string): Promise<CertCenterCertificateInfo | null> {
    const body = JSON.stringify({ CertificateId: providerCertificateId });
    const response = await this.call("DescribeCertificate", body);
    const result = (response as any)?.Result;
    if (!result) return null;
    return {
      providerCertificateId,
      status: String(result.Status || "unknown"),
      notBefore: result.NotBefore ? Number(result.NotBefore) : null,
      notAfter: result.NotAfter ? Number(result.NotAfter) : null,
      commonName: result.CommonName ? String(result.CommonName) : null,
      sans: Array.isArray(result.SAN) ? result.SAN.map(String) : [],
    };
  }

  async deleteCertificate(providerCertificateId: string): Promise<void> {
    await this.call("DeleteCertificate", JSON.stringify({ CertificateId: providerCertificateId }));
  }

  private async call(action: string, body: string): Promise<unknown> {
    const host = this.options.host || `open.volcengineapi.com`;
    const service = "certcenter";
    const region = this.options.region;
    const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = timestamp.slice(0, 8);
    const bodyHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
    const query = `Action=${action}&Version=2021-06-06`;
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-content-sha256:${bodyHash}\nx-date:${timestamp}\n`;
    const signedHeaders = "content-type;host;x-content-sha256;x-date";
    const canonicalRequest = `POST\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;
    const credentialScope = `${date}/${region}/${service}/request`;
    const stringToSign = [
      "HMAC-SHA256",
      timestamp,
      credentialScope,
      crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
    ].join("\n");
    const hmac = (key: crypto.BinaryLike | crypto.KeyObject, value: string) =>
      crypto.createHmac("sha256", key).update(value, "utf8").digest();
    const kDate = hmac(this.options.secretAccessKey, date);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "request");
    const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
    const authorization = `HMAC-SHA256 Credential=${this.options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const fetchFn = this.options.fetchFn ?? fetch;
    const response = await fetchFn(`https://${host}/?${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Date": timestamp,
        "X-Content-Sha256": bodyHash,
        Authorization: authorization,
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new TenantCertificateError(
        `证书中心请求失败（HTTP ${response.status}）`,
        502,
        "CERT_CENTER_REQUEST_FAILED",
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new TenantCertificateError("证书中心响应无效", 502, "CERT_CENTER_RESPONSE_INVALID");
    }
  }
}

let certCenterClient: CertCenterClient | null = null;

/**
 * 证书中心客户端解析（R5 fail-closed）：
 * - 配置了专用 IAM 凭据 → 火山引擎实现（任何环境）。
 * - 缺凭据时：
 *   - production/staging → 抛稳定、脱敏、可审计的配置错误（503），绝不
 *     静默退化为内存实现；
 *   - 域名云编排开关（FANJIN_TENANT_INGRESS_CLOUD_ENABLED=1）开启 → 拒绝
 *     内存实现（云端绑定必须对应真实 provider 证书）；
 *   - 仅 NODE_ENV=test 或显式本地开发开关 FANJIN_CERT_CENTER_ALLOW_MEMORY=1
 *     （且不得与 production/staging 同时成立）时允许内存实现。
 */
export function resolveCertCenterClient(env: NodeJS.ProcessEnv = process.env): CertCenterClient {
  if (certCenterClient) return certCenterClient;
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  const productionLike = nodeEnv === "production" || nodeEnv === "prod" || nodeEnv === "staging";
  const accessKeyId = String(env.FANJIN_CERT_CENTER_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.FANJIN_CERT_CENTER_SECRET_ACCESS_KEY || "").trim();
  const region = String(env.FANJIN_CERT_CENTER_REGION || "cn-beijing").trim();
  if (accessKeyId && secretAccessKey) {
    certCenterClient = new VolcengineCertCenterClient({
      accessKeyId,
      secretAccessKey,
      region,
      host: String(env.FANJIN_CERT_CENTER_HOST || "").trim() || undefined,
    });
    return certCenterClient;
  }
  if (productionLike) {
    throw new TenantCertificateError(
      "证书中心凭据未配置：生产/预发环境禁止降级为内存证书实现",
      503,
      "CERT_CENTER_NOT_CONFIGURED",
    );
  }
  const cloudEnabled = String(env.FANJIN_TENANT_INGRESS_CLOUD_ENABLED || "").trim() === "1";
  if (cloudEnabled) {
    throw new TenantCertificateError(
      "域名云编排已开启：禁止使用内存证书中心实现",
      503,
      "CERT_CENTER_MEMORY_FORBIDDEN_WITH_CLOUD",
    );
  }
  const memoryAllowed = nodeEnv === "test"
    || String(env.FANJIN_CERT_CENTER_ALLOW_MEMORY || "").trim() === "1";
  if (!memoryAllowed) {
    throw new TenantCertificateError(
      "证书中心凭据未配置：内存实现仅限 NODE_ENV=test 或显式 FANJIN_CERT_CENTER_ALLOW_MEMORY=1",
      503,
      "CERT_CENTER_NOT_CONFIGURED",
    );
  }
  certCenterClient = new InMemoryCertCenterClient();
  return certCenterClient;
}

/** 测试辅助：注入客户端。 */
export function setCertCenterClient(client: CertCenterClient | null): void {
  certCenterClient = client;
}

// ---------------------------------------------------------------------------
// 证书记录管理
// ---------------------------------------------------------------------------

function rowToCertificate(row: any): TenantCertificateRecord {
  let sans: string[] = [];
  try {
    const parsed = JSON.parse(String(row.sans || "[]"));
    if (Array.isArray(parsed)) sans = parsed.map(String);
  } catch {
    sans = [];
  }
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    source: String(row.source) as CertificateSource,
    provider: row.provider ? String(row.provider) : null,
    providerCertificateId: row.providerCertificateId ? String(row.providerCertificateId) : null,
    commonName: row.commonName ? String(row.commonName) : null,
    sans,
    fingerprintSha256: row.fingerprintSha256 ? String(row.fingerprintSha256) : null,
    keyAlgorithm: row.keyAlgorithm ? String(row.keyAlgorithm) : null,
    keySize: row.keySize == null ? null : Number(row.keySize),
    issuer: row.issuer ? String(row.issuer) : null,
    serialNumber: row.serialNumber ? String(row.serialNumber) : null,
    notBefore: row.notBefore == null ? null : Number(row.notBefore),
    notAfter: row.notAfter == null ? null : Number(row.notAfter),
    status: String(row.status) as CertificateStatus,
    renewalMode: String(row.renewalMode || "manual"),
    replacesCertificateId: row.replacesCertificateId ? String(row.replacesCertificateId) : null,
    lastCheckedAt: row.lastCheckedAt == null ? null : Number(row.lastCheckedAt),
    failureCode: row.failureCode ? String(row.failureCode) : null,
    failureMessage: row.failureMessage ? String(row.failureMessage) : null,
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

export async function listTenantCertificates(
  database: CertDb = db,
  filters: { tenantId?: string; status?: string } = {},
): Promise<TenantCertificateRecord[]> {
  const query = (database as any)(TENANT_CERTIFICATE_TABLE);
  if (filters.tenantId) query.where({ tenantId: filters.tenantId });
  if (filters.status) query.where({ status: filters.status });
  const rows = await query.orderBy("createdAt", "desc");
  return rows.map(rowToCertificate);
}

export async function tenantCertificateById(database: CertDb, certificateId: string): Promise<TenantCertificateRecord> {
  const row = await (database as any)(TENANT_CERTIFICATE_TABLE).where({ id: String(certificateId || "") }).first();
  if (!row) throw new TenantCertificateError("证书不存在", 404, "CERT_NOT_FOUND");
  return rowToCertificate(row);
}

/**
 * BYOC 导入（设计文档 §10.1.B）：
 * 1. 服务器端完整校验（链、匹配、SAN、有效期、指纹占用）
 * 2. 上传证书中心（私钥只在受控内存中短暂存在，立即上传后丢弃）
 * 3. 只保存元数据；私钥不出现在任何返回值、日志或数据库
 */
export async function importTenantCertificate(input: {
  tenantId: string;
  certificateChain: string;
  privateKey: string;
  hostnames: string[];
  name?: string;
  operatorUserId?: number | null;
  client?: CertCenterClient;
  database?: CertDb;
}): Promise<TenantCertificateRecord> {
  const client = input.client || resolveCertCenterClient();
  const validation = validateCertificateForHostnames({
    certificateChain: input.certificateChain,
    privateKey: input.privateKey,
    hostnames: input.hostnames,
  });
  if (!validation.valid) {
    throw new TenantCertificateError(
      `证书校验未通过：${validation.failures.join(", ")}`,
      422,
      "CERT_VALIDATION_FAILED",
    );
  }
  const tenantId = String(input.tenantId || "").trim().toUpperCase();
  const run = async (client2: CertDb) => {
    // 指纹占用检查：同一指纹不能被无权限租户复用。
    const sameFingerprint = await (client2 as any)(TENANT_CERTIFICATE_TABLE)
      .where({ fingerprintSha256: validation.fingerprintSha256 })
      .first();
    if (sameFingerprint && String(sameFingerprint.tenantId) !== tenantId) {
      throw new TenantCertificateError("证书指纹已被其他租户登记", 409, "CERT_FINGERPRINT_CONFLICT");
    }
    const idempotencyKey = `import:${validation.fingerprintSha256}:${tenantId}`;
    const imported = await client.importCertificate({
      certificateChain: input.certificateChain,
      privateKey: input.privateKey,
      name: input.name || `${tenantId}-${validation.commonName || "certificate"}`,
      idempotencyKey,
    });
    // R5 回读验证：证书中心必须能返回可回读、可验证的 provider 证书元数据，
    // 数据库才允许写 active。回读失败补偿删除云端证书，绝不保存假 ID 或成功状态。
    const described = await client.describeCertificate(imported.providerCertificateId);
    if (
      !described
      || String(described.providerCertificateId || "") !== String(imported.providerCertificateId)
    ) {
      await client.deleteCertificate(imported.providerCertificateId).catch(() => undefined);
      throw new TenantCertificateError(
        "证书中心导入后无法回读验证，已拒绝入库",
        502,
        "CERT_CENTER_READBACK_FAILED",
      );
    }
    const timestamp = Date.now();
    const record = {
      id: uuid(),
      tenantId,
      source: "imported" as const,
      provider: client.providerId,
      providerCertificateId: imported.providerCertificateId,
      commonName: validation.commonName,
      sans: JSON.stringify(validation.sans),
      fingerprintSha256: validation.fingerprintSha256,
      keyAlgorithm: validation.keyAlgorithm,
      keySize: validation.keySize,
      issuer: validation.issuer,
      serialNumber: validation.serialNumber,
      notBefore: validation.notBefore,
      notAfter: validation.notAfter,
      status: "active" as const,
      renewalMode: "manual",
      replacesCertificateId: null,
      lastCheckedAt: timestamp,
      failureCode: null,
      failureMessage: null,
      metadata: "{}",
      createdByUserId: input.operatorUserId ?? null,
      updatedByUserId: input.operatorUserId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await (client2 as any)(TENANT_CERTIFICATE_TABLE).insert(record);
    return rowToCertificate(record);
  };
  if (input.database) return await run(input.database);
  return await db.transaction(async (trx) => run(trx));
}

/**
 * 引用证书中心已有证书（仅平台 Root；租户管理员只能看到被授权证书）。
 */
export async function referenceTenantCertificate(input: {
  tenantId: string;
  providerCertificateId: string;
  operatorUserId?: number | null;
  client?: CertCenterClient;
  database?: CertDb;
}): Promise<TenantCertificateRecord> {
  const client = input.client || resolveCertCenterClient();
  const tenantId = String(input.tenantId || "").trim().toUpperCase();
  const info = await client.describeCertificate(input.providerCertificateId);
  if (!info) {
    throw new TenantCertificateError("证书中心未找到该证书", 404, "CERT_CENTER_NOT_FOUND");
  }
  const run = async (client2: CertDb) => {
    const timestamp = Date.now();
    const record = {
      id: uuid(),
      tenantId,
      source: "cert_center_reference" as const,
      provider: client.providerId,
      providerCertificateId: info.providerCertificateId,
      commonName: info.commonName,
      sans: JSON.stringify(info.sans),
      fingerprintSha256: null,
      keyAlgorithm: null,
      keySize: null,
      issuer: null,
      serialNumber: null,
      notBefore: info.notBefore,
      notAfter: info.notAfter,
      status: "active" as const,
      renewalMode: "external",
      replacesCertificateId: null,
      lastCheckedAt: timestamp,
      failureCode: null,
      failureMessage: null,
      metadata: "{}",
      createdByUserId: input.operatorUserId ?? null,
      updatedByUserId: input.operatorUserId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await (client2 as any)(TENANT_CERTIFICATE_TABLE).insert(record);
    return rowToCertificate(record);
  };
  if (input.database) return await run(input.database);
  return await db.transaction(async (trx) => run(trx));
}

/**
 * 绑定证书到域名（校验覆盖范围后写期望状态）。
 */
export async function bindCertificateToDomain(input: {
  domainId: string;
  certificateId: string;
  operatorUserId?: number | null;
}): Promise<{ domainId: string; certificateId: string; desiredRevision: number }> {
  return await db.transaction(async (trx) => {
    const domainRow = await trx("o_tenant_domain")
      .where({ id: input.domainId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!domainRow) throw new TenantCertificateError("域名不存在", 404, "DOMAIN_NOT_FOUND");
    const certRow = await trx(TENANT_CERTIFICATE_TABLE).where({ id: input.certificateId }).first();
    if (!certRow) throw new TenantCertificateError("证书不存在", 404, "CERT_NOT_FOUND");
    if (String(certRow.tenantId) !== String(domainRow.tenantId)) {
      throw new TenantCertificateError("证书不属于该租户", 403, "CERT_TENANT_MISMATCH");
    }
    const cert = rowToCertificate(certRow);
    const covers = [cert.commonName, ...cert.sans].some((name) =>
      name && hostnameMatches(domainRow.hostname, name));
    if (!covers) {
      throw new TenantCertificateError("证书 SAN 未覆盖该域名", 422, "CERT_SAN_NOT_COVERING");
    }
    if (cert.notAfter != null && cert.notAfter <= Date.now()) {
      throw new TenantCertificateError("证书已过期", 422, "CERT_EXPIRED");
    }
    const timestamp = Date.now();
    const newRevision = Number(domainRow.desiredRevision || 1) + 1;
    await trx("o_tenant_domain")
      .where({ id: domainRow.id, desiredRevision: domainRow.desiredRevision })
      .update({
        certificateId: cert.id,
        desiredRevision: newRevision,
        updatedAt: timestamp,
        updatedByUserId: input.operatorUserId ?? null,
      });
    return {
      domainId: String(domainRow.id),
      certificateId: cert.id,
      desiredRevision: newRevision,
    };
  });
}

/**
 * 证书轮换：新证书绑定域名，旧证书延迟解绑（设计文档 §10.3）。
 * 云端 ALB 切换在 M4 编排器接入；此处完成状态与轮换关系记录。
 */
export async function rotateDomainCertificate(input: {
  domainId: string;
  newCertificateId: string;
  operatorUserId?: number | null;
}): Promise<{
  domainId: string;
  previousCertificateId: string | null;
  newCertificateId: string;
  pendingCloudSteps: string[];
}> {
  const bound = await bindCertificateToDomain({
    domainId: input.domainId,
    certificateId: input.newCertificateId,
    operatorUserId: input.operatorUserId,
  });
  const domain = await db("o_tenant_domain").where({ id: input.domainId }).first();
  const cloudEnabled = String(process.env.FANJIN_TENANT_INGRESS_CLOUD_ENABLED || "") === "1";
  return {
    domainId: bound.domainId,
    previousCertificateId: domain?.certificateId && domain.certificateId !== input.newCertificateId
      ? String(domain.certificateId)
      : null,
    newCertificateId: bound.certificateId,
    pendingCloudSteps: cloudEnabled ? [] : ["switch_alb_certificate", "public_tls_probe", "retire_old_certificate"],
  };
}

/**
 * 到期状态巡检：把到期窗口内的证书标记为 expiring、过期的标记为 expired。
 * 返回更新数量，供告警 Worker 使用。
 */
export async function refreshCertificateExpiryStatuses(database: CertDb = db): Promise<{
  expiring: number;
  expired: number;
}> {
  const now = Date.now();
  const expiringWindow = now + 45 * 24 * 60 * 60 * 1000;
  const expiringCount = await (database as any)(TENANT_CERTIFICATE_TABLE)
    .where("status", "active")
    .whereNotNull("notAfter")
    .where("notAfter", "<=", expiringWindow)
    .where("notAfter", ">", now)
    .update({ status: "expiring", updatedAt: now });
  const expiredCount = await (database as any)(TENANT_CERTIFICATE_TABLE)
    .whereIn("status", ["active", "expiring"])
    .whereNotNull("notAfter")
    .where("notAfter", "<=", now)
    .update({ status: "expired", updatedAt: now });
  return { expiring: Number(expiringCount || 0), expired: Number(expiredCount || 0) };
}
