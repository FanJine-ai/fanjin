import type { Knex } from "knex";

import { db } from "@/utils/db";
import {
  loadTenantRuntimeSnapshot,
  resetTenantRuntimeSnapshotCache,
} from "@/lib/tenantDirectory";
import {
  recoverTenantDomainOperations,
  tenantIngressCloudEnabled,
  TenantDomainOrchestrationError,
  type TenantDomainCertificateRef,
  type TenantDomainIngressBindingRefs,
  type TenantDomainOrchestrator,
} from "@/lib/tenantDomainOrchestration";
import type { TenantDomainRecord } from "@/lib/tenantDomain";
import {
  Service,
  VolcengineOpenApiError,
  resolveVolcengineAlbRegionalHost,
  type VolcengineOpenApiFetch,
} from "@/release-controller/volcengineOpenApi";

const INGRESS_CLUSTER_TABLE = "o_ingress_cluster";
const INGRESS_BINDING_TABLE = "o_tenant_ingress_binding";
const CERTIFICATE_TABLE = "o_tenant_certificate";
const ALB_API_VERSION = "2020-04-01";
const DEFAULT_API_TIMEOUT_MS = 10_000;
const DEFAULT_READBACK_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
const MANAGED_RULE_PREFIX = "fanjin-tenant-domain-";

type JsonObject = Record<string, any>;

type IngressClusterRow = {
  id: string;
  provider: string;
  region: string;
  loadBalancerId: string | null;
  httpsListenerId: string | null;
  defaultServerGroupId: string | null;
  status: string;
  credentialRef: string | null;
};

export type TenantDomainProductionOrchestratorOptions = {
  env?: NodeJS.ProcessEnv;
  openApiFetch?: VolcengineOpenApiFetch;
  publicFetch?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
};

function fail(code: string, message: string, status = 503): never {
  throw new TenantDomainOrchestrationError(message, status, code);
}

function nonEmpty(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function positiveInteger(value: unknown, fallback: number, maximum = 120_000): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function unwrap(response: unknown): JsonObject {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    fail("ALB_RESPONSE_INVALID", "ALB OpenAPI 返回了无效响应", 502);
  }
  const outer = response as JsonObject;
  const result = outer.Result;
  return result && typeof result === "object" && !Array.isArray(result)
    ? result as JsonObject
    : outer;
}

function cloudId(value: unknown, label: string): string {
  const normalized = nonEmpty(value);
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/.test(normalized)) {
    fail("ALB_RESPONSE_INVALID", `ALB ${label} 无效`, 502);
  }
  return normalized;
}

function managedRuleName(domain: TenantDomainRecord): string {
  return `${MANAGED_RULE_PREFIX}${domain.id}`;
}

function exactHostname(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\.$/u, "");
}

function listenerExtensions(payload: JsonObject): JsonObject[] {
  const raw = payload.DomainExtensions;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    fail("ALB_RESPONSE_INVALID", "ALB 监听器域名扩展清单无效", 502);
  }
  return raw as JsonObject[];
}

function rules(payload: JsonObject): JsonObject[] {
  const raw = payload.Rules ?? payload.RuleSet;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    fail("ALB_RESPONSE_INVALID", "ALB Host 规则清单无效", 502);
  }
  return raw as JsonObject[];
}

function ruleHosts(rule: JsonObject): string[] {
  const hosts: string[] = [];
  if (typeof rule.Domain === "string") hosts.push(exactHostname(rule.Domain));
  const conditions = Array.isArray(rule.RuleConditions) ? rule.RuleConditions : [];
  for (const condition of conditions) {
    if (!condition || typeof condition !== "object") continue;
    const candidate = condition as JsonObject;
    if (String(candidate.Type || "").toLowerCase() !== "host") continue;
    const values = candidate.HostConfig?.Values;
    if (Array.isArray(values)) hosts.push(...values.map(exactHostname));
  }
  return [...new Set(hosts.filter(Boolean))];
}

function ruleServerGroupIds(rule: JsonObject): string[] {
  const groups: string[] = [];
  if (nonEmpty(rule.ServerGroupId)) groups.push(String(rule.ServerGroupId));
  const actions = Array.isArray(rule.RuleActions) ? rule.RuleActions : [];
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    const tuples = (action as JsonObject).ForwardGroupConfig?.ServerGroupTuples;
    if (!Array.isArray(tuples)) continue;
    for (const tuple of tuples) {
      const group = nonEmpty(tuple?.ServerGroupId);
      if (group) groups.push(group);
    }
  }
  return [...new Set(groups)];
}

function isManagedRule(rule: JsonObject, domain: TenantDomainRecord, knownRuleId?: string | null): boolean {
  const ruleId = nonEmpty(rule.RuleId);
  if (knownRuleId && ruleId === knownRuleId) return true;
  const marker = managedRuleName(domain);
  return nonEmpty(rule.RuleName) === marker || nonEmpty(rule.Description) === marker;
}

function desiredRule(domain: TenantDomainRecord, serverGroupId: string, ruleId?: string): JsonObject {
  const rule: JsonObject = {
    Description: managedRuleName(domain), Domain: domain.hostname, Url: "/", ServerGroupId: serverGroupId,
  };
  if (ruleId) rule.RuleId = ruleId;
  return rule;
}

/** ALB RPC uses one-based dotted query parameters, including nested lists. */
export function tenantAlbQuery(input: JsonObject): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  function visit(value: unknown, key: string) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${key}.${i + 1}`)); return; }
    if (typeof value === "object") { Object.entries(value).forEach(([k, v]) => visit(v, key ? `${key}.${k}` : k)); return; }
    if (!["string", "number", "boolean"].includes(typeof value)) fail("ALB_REQUEST_INVALID", "ALB 参数无效");
    out[key] = value as string | number | boolean;
  }
  visit(input, ""); return out;
}

function extensionRequest(entry: JsonObject): JsonObject {
  const output: JsonObject = {
    Domain: exactHostname(entry.Domain),
    CertificateSource: "cert_center",
    CertCenterCertificateId: cloudId(entry.CertCenterCertificateId, "证书 ID"),
  };
  if (nonEmpty(entry.DomainExtensionId)) {
    output.DomainExtensionId = cloudId(entry.DomainExtensionId, "域名扩展 ID");
  }
  return output;
}

function translateProviderError(error: unknown): never {
  if (error instanceof TenantDomainOrchestrationError) throw error;
  if (error instanceof VolcengineOpenApiError) {
    fail(
      `ALB_API_${error.code}`,
      `ALB OpenAPI 调用失败（${error.code}）`,
      error.httpStatus && error.httpStatus < 500 ? 409 : 502,
    );
  }
  fail("ALB_ORCHESTRATION_FAILED", "ALB 域名编排失败", 502);
}

export class VolcengineTenantDomainOrchestrator implements TenantDomainOrchestrator {
  private readonly env: NodeJS.ProcessEnv;
  private readonly openApiFetch?: VolcengineOpenApiFetch;
  private readonly publicFetch: typeof fetch;
  private readonly now?: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: TenantDomainProductionOrchestratorOptions = {}) {
    this.env = options.env ?? process.env;
    this.openApiFetch = options.openApiFetch;
    this.publicFetch = options.publicFetch ?? fetch;
    this.now = options.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private credentials(cluster: IngressClusterRow): {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  } {
    const prefix = nonEmpty(cluster.credentialRef);
    if (prefix && !/^[A-Z][A-Z0-9_]{2,127}$/.test(prefix)) {
      fail("ALB_CREDENTIAL_REF_INVALID", "入口集群 credentialRef 格式无效");
    }
    const accessKeyId = nonEmpty(prefix
      ? this.env[`${prefix}_ACCESS_KEY_ID`]
      : this.env.FANJIN_TENANT_INGRESS_VOLC_ACCESS_KEY_ID);
    const secretAccessKey = nonEmpty(prefix
      ? this.env[`${prefix}_SECRET_ACCESS_KEY`]
      : this.env.FANJIN_TENANT_INGRESS_VOLC_SECRET_ACCESS_KEY);
    const sessionToken = nonEmpty(prefix
      ? this.env[`${prefix}_SESSION_TOKEN`]
      : this.env.FANJIN_TENANT_INGRESS_VOLC_SESSION_TOKEN);
    if (!accessKeyId || !secretAccessKey) {
      fail("ALB_CREDENTIALS_MISSING", "入口集群 ALB 专用 IAM 凭据未配置");
    }
    return { accessKeyId, secretAccessKey, sessionToken: sessionToken ?? undefined };
  }

  private validateCluster(row: any): IngressClusterRow {
    if (!row) fail("DOMAIN_INGRESS_CLUSTER_MISSING", "入口集群不存在");
    const cluster: IngressClusterRow = {
      id: String(row.id),
      provider: String(row.provider || ""),
      region: String(row.region || ""),
      loadBalancerId: nonEmpty(row.loadBalancerId),
      httpsListenerId: nonEmpty(row.httpsListenerId),
      defaultServerGroupId: nonEmpty(row.defaultServerGroupId),
      status: String(row.status || ""),
      credentialRef: nonEmpty(row.credentialRef),
    };
    if (cluster.provider !== "volcengine_alb") {
      fail("ALB_PROVIDER_UNSUPPORTED", "入口集群不是火山引擎 ALB");
    }
    if (!["active", "ready"].includes(cluster.status)) {
      fail("ALB_CLUSTER_NOT_READY", "入口集群尚未就绪", 409);
    }
    if (!cluster.loadBalancerId || !cluster.httpsListenerId || !cluster.defaultServerGroupId) {
      fail("ALB_CLUSTER_CONFIG_INCOMPLETE", "入口集群缺少 ALB、HTTPS 监听器或服务器组配置");
    }
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(cluster.region)) {
      fail("ALB_CLUSTER_CONFIG_INVALID", "入口集群 region 无效");
    }
    return cluster;
  }

  private service(cluster: IngressClusterRow): Service {
    const credentials = this.credentials(cluster);
    return new Service({
      accessKeyId: credentials.accessKeyId,
      secretKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      region: cluster.region,
      host: resolveVolcengineAlbRegionalHost(cluster.region, nonEmpty(this.env.FANJIN_TENANT_INGRESS_ALB_API_HOST) ?? undefined),
      serviceName: "alb",
      protocol: "https:",
      defaultVersion: ALB_API_VERSION,
      fetch: this.openApiFetch,
      now: this.now,
    });
  }

  private async call(
    service: Service,
    action: string,
    request: JsonObject,
  ): Promise<JsonObject> {
    try {
      const api = service.createAPI<Record<string, unknown>, unknown>(action, {
        Version: ALB_API_VERSION,
        method: "GET",
      });
      const response = await api(tenantAlbQuery(request), {
        timeout: positiveInteger(this.env.FANJIN_TENANT_INGRESS_ALB_API_TIMEOUT_MS, DEFAULT_API_TIMEOUT_MS),
      });
      return unwrap(response);
    } catch (error) {
      return translateProviderError(error);
    }
  }

  private async describeListener(service: Service, cluster: IngressClusterRow): Promise<JsonObject> {
    const listener = await this.call(service, "DescribeListenerAttributes", {
      ListenerId: cluster.httpsListenerId,
    });
    if (
      nonEmpty(listener.ListenerId) !== cluster.httpsListenerId
      || (nonEmpty(listener.LoadBalancerId) && nonEmpty(listener.LoadBalancerId) !== cluster.loadBalancerId)
    ) {
      fail("ALB_TOPOLOGY_MISMATCH", "ALB HTTPS 监听器回读与入口集群不一致", 409);
    }
    return listener;
  }

  private async describeRules(service: Service, cluster: IngressClusterRow): Promise<JsonObject[]> {
    return rules(await this.call(service, "DescribeRules", {
      ListenerId: cluster.httpsListenerId,
      PageNumber: 1,
      PageSize: 100,
    }));
  }

  private async clusterForDomain(database: Knex | Knex.Transaction, domainId: string): Promise<IngressClusterRow> {
    const binding = await (database as any)(INGRESS_BINDING_TABLE).where({ domainId }).first();
    let cluster: any = null;
    if (binding?.ingressClusterId) {
      cluster = await (database as any)(INGRESS_CLUSTER_TABLE).where({ id: binding.ingressClusterId }).first();
    }
    if (!cluster) {
      cluster = await (database as any)(INGRESS_CLUSTER_TABLE)
        .whereNot({ status: "retired" })
        .orderBy("createdAt", "asc")
        .first();
    }
    return this.validateCluster(cluster);
  }

  private async observed(
    service: Service,
    cluster: IngressClusterRow,
    domain: TenantDomainRecord,
  ): Promise<{ extension: JsonObject | null; rule: JsonObject | null }> {
    const [listener, allRules] = await Promise.all([
      this.describeListener(service, cluster),
      this.describeRules(service, cluster),
    ]);
    const extensions = listenerExtensions(listener)
      .filter((entry) => exactHostname(entry.Domain) === domain.hostname);
    const hostRules = allRules.filter((entry) => ruleHosts(entry).includes(domain.hostname));
    if (extensions.length > 1 || hostRules.length > 1) {
      fail("ALB_DOMAIN_BINDING_AMBIGUOUS", "ALB 中存在重复域名扩展或 Host 规则", 409);
    }
    return { extension: extensions[0] ?? null, rule: hostRules[0] ?? null };
  }

  async bindDomain(input: {
    domain: TenantDomainRecord;
    certificate: TenantDomainCertificateRef | null;
    ingressClusterId: string | null;
  }): Promise<TenantDomainIngressBindingRefs> {
    if (!input.ingressClusterId) fail("DOMAIN_INGRESS_CLUSTER_MISSING", "未指定入口集群");
    if (!input.certificate?.providerCertificateId || input.certificate.provider !== "volcengine_certificate_center") {
      fail("ALB_CERTIFICATE_REF_INVALID", "域名必须绑定火山引擎证书中心的有效证书", 409);
    }
    const certificate = input.certificate;
    try {
      return await db.transaction(async (trx) => {
        const row = await trx(INGRESS_CLUSTER_TABLE).where({ id: input.ingressClusterId }).forUpdate().first();
        const cluster = this.validateCluster(row);
        const service = this.service(cluster);
        const listener = await this.describeListener(service, cluster);
        const extensions = listenerExtensions(listener);
        const matches = extensions.filter((entry) => exactHostname(entry.Domain) === input.domain.hostname);
        if (matches.length > 1) fail("ALB_DOMAIN_EXTENSION_DUPLICATE", "ALB 中存在重复 SNI 域名扩展", 409);
        const desiredExtension: JsonObject = {
          ...(matches[0]?.DomainExtensionId ? { DomainExtensionId: matches[0].DomainExtensionId } : {}),
          Domain: input.domain.hostname,
          CertificateSource: "cert_center",
          CertCenterCertificateId: certificate.providerCertificateId,
        };
        const extensionChanged = !matches[0]
          || nonEmpty(matches[0].CertCenterCertificateId) !== certificate.providerCertificateId
          || nonEmpty(matches[0].CertificateSource) !== "cert_center";
        if (extensionChanged) {
          const operation = { ...extensionRequest(desiredExtension), Action: matches[0] ? "modify" : "create" };
          await this.call(service, "ModifyListenerAttributes", {
            ListenerId: cluster.httpsListenerId,
            DomainExtensions: [operation],
          });
        }

        const allRules = await this.describeRules(service, cluster);
        const hostRules = allRules.filter((entry) => ruleHosts(entry).includes(input.domain.hostname));
        if (hostRules.length > 1) fail("ALB_HOST_RULE_DUPLICATE", "ALB 中存在重复 Host 规则", 409);
        const existingBinding = await trx(INGRESS_BINDING_TABLE).where({ domainId: input.domain.id }).first();
        const knownRuleId = nonEmpty(existingBinding?.providerRuleId);
        let ruleId: string | null = null;
        if (hostRules[0]) {
          if (!isManagedRule(hostRules[0], input.domain, knownRuleId)) {
            fail("ALB_HOST_RULE_CONFLICT", "域名已被非 Fanjin 管理的 ALB Host 规则占用", 409);
          }
          ruleId = cloudId(hostRules[0].RuleId, "Host 规则 ID");
          if (!ruleServerGroupIds(hostRules[0]).includes(cluster.defaultServerGroupId!)) {
            await this.call(service, "ModifyRules", {
              ListenerId: cluster.httpsListenerId,
              Rules: [desiredRule(input.domain, cluster.defaultServerGroupId!, ruleId)],
            });
          }
        } else {
          const createResponse = await this.call(service, "CreateRules", {
            ListenerId: cluster.httpsListenerId,
            Rules: [desiredRule(input.domain, cluster.defaultServerGroupId!)],
          });
          const ids = createResponse.RuleIds;
          if (Array.isArray(ids) && ids.length > 0) ruleId = cloudId(ids[0], "Host 规则 ID");
          else if (nonEmpty(createResponse.RuleId)) ruleId = cloudId(createResponse.RuleId, "Host 规则 ID");
        }
        return {
          providerDomainExtensionId: nonEmpty(matches[0]?.DomainExtensionId),
          providerRuleId: ruleId,
          serverGroupId: cluster.defaultServerGroupId,
        };
      });
    } catch (error) {
      return translateProviderError(error);
    }
  }

  async readObservedBinding(input: {
    domain: TenantDomainRecord;
    binding: TenantDomainIngressBindingRefs;
  }): Promise<{ state: "bound" | "unbound" | "pending"; binding: TenantDomainIngressBindingRefs | null }> {
    try {
      const cluster = await this.clusterForDomain(db, input.domain.id);
      const service = this.service(cluster);
      const cert = input.domain.certificateId
        ? await db(CERTIFICATE_TABLE).where({ id: input.domain.certificateId }).first()
        : null;
      const expectedCertificateId = nonEmpty(cert?.providerCertificateId);
      const bindIntent = Boolean(
        input.binding.providerDomainExtensionId
        || input.binding.providerRuleId
        || input.binding.serverGroupId,
      );
      const deadline = Date.now() + positiveInteger(
        this.env.FANJIN_TENANT_INGRESS_READBACK_TIMEOUT_MS,
        DEFAULT_READBACK_TIMEOUT_MS,
      );
      while (true) {
        const observed = await this.observed(service, cluster, input.domain);
        if (!observed.extension && !observed.rule && !bindIntent) {
          return { state: "unbound", binding: null };
        }
        if (observed.extension && observed.rule) {
          if (!isManagedRule(observed.rule, input.domain, input.binding.providerRuleId)) {
            fail("ALB_HOST_RULE_CONFLICT", "域名 Host 规则不属于 Fanjin", 409);
          }
          const groups = ruleServerGroupIds(observed.rule);
          if (
            expectedCertificateId
            && nonEmpty(observed.extension.CertCenterCertificateId) === expectedCertificateId
            && groups.includes(cluster.defaultServerGroupId!)
          ) {
            return {
              state: "bound",
              binding: {
                providerDomainExtensionId: cloudId(observed.extension.DomainExtensionId, "域名扩展 ID"),
                providerRuleId: cloudId(observed.rule.RuleId, "Host 规则 ID"),
                serverGroupId: cluster.defaultServerGroupId,
              },
            };
          }
        }
        if (Date.now() >= deadline) return { state: "pending", binding: null };
        await this.sleep(positiveInteger(
          this.env.FANJIN_TENANT_INGRESS_READBACK_POLL_INTERVAL_MS,
          DEFAULT_POLL_INTERVAL_MS,
          5_000,
        ));
      }
    } catch (error) {
      return translateProviderError(error);
    }
  }

  async publishRuntimeSnapshot(input: {
    domain: TenantDomainRecord;
    desiredRevision: number;
  }): Promise<{ revision: string }> {
    resetTenantRuntimeSnapshotCache();
    const snapshot = await loadTenantRuntimeSnapshot();
    const tenant = snapshot.tenants.find((entry) => entry.id === input.domain.tenantId);
    if (!tenant?.hosts.includes(input.domain.hostname)) {
      fail("DOMAIN_SNAPSHOT_NOT_PUBLISHED", "运行时快照尚未包含待发布域名", 502);
    }
    if (!snapshot.revision.includes(`${input.domain.id}:${input.desiredRevision}`)) {
      fail("DOMAIN_SNAPSHOT_REVISION_MISMATCH", "运行时快照 revision 未包含目标域名版本", 502);
    }
    return { revision: snapshot.revision };
  }

  private async publicProbe(pathname: string, domain: TenantDomainRecord): Promise<{ ok: boolean; failure?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), positiveInteger(
      this.env.FANJIN_TENANT_INGRESS_PUBLIC_REQUEST_TIMEOUT_MS,
      DEFAULT_API_TIMEOUT_MS,
    ));
    timeout.unref?.();
    try {
      const response = await this.publicFetch(`https://${domain.hostname}${pathname}`, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, failure: `${pathname}:http_${response.status}` };
      if (pathname === "/api/runtime/tenant") {
        const tenantHeader = response.headers.get("x-fanjin-commercial-tenant");
        const revision = response.headers.get("x-fanjin-tenant-snapshot-revision");
        if (tenantHeader !== domain.tenantId) return { ok: false, failure: "tenant_identity_mismatch" };
        if (!revision || !revision.includes(`${domain.id}:${domain.desiredRevision}`)) {
          return { ok: false, failure: "snapshot_revision_mismatch" };
        }
        const payload = await response.json().catch(() => null) as any;
        if (String(payload?.data?.id || "") !== domain.tenantId) {
          return { ok: false, failure: "tenant_payload_mismatch" };
        }
      }
      return { ok: true };
    } catch {
      return { ok: false, failure: `${pathname}:request_failed` };
    } finally {
      clearTimeout(timeout);
    }
  }

  async runRequiredSmoke(input: {
    domain: TenantDomainRecord;
    expectedTenantId: string;
  }): Promise<{ ok: boolean; failures: string[] }> {
    if (input.expectedTenantId !== input.domain.tenantId) {
      return { ok: false, failures: ["expected_tenant_mismatch"] };
    }
    const timeoutMs = positiveInteger(
      this.env.FANJIN_TENANT_INGRESS_READBACK_TIMEOUT_MS,
      DEFAULT_READBACK_TIMEOUT_MS,
    );
    const intervalMs = positiveInteger(
      this.env.FANJIN_TENANT_INGRESS_READBACK_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      5_000,
    );
    const startedAt = Date.now();
    let failures: string[] = [];
    do {
      const [runtime, ready] = await Promise.all([
        this.publicProbe("/api/runtime/tenant", input.domain),
        this.publicProbe("/api/ready", input.domain),
      ]);
      failures = [runtime.failure, ready.failure].filter(Boolean) as string[];
      if (runtime.ok && ready.ok) return { ok: true, failures: [] };
      if (Date.now() - startedAt >= timeoutMs) break;
      await this.sleep(intervalMs);
    } while (true);
    return { ok: false, failures: [...new Set(failures)] };
  }

  async unbindDomain(input: { domain: TenantDomainRecord }): Promise<void> {
    try {
      await db.transaction(async (trx) => {
        const binding = await trx(INGRESS_BINDING_TABLE).where({ domainId: input.domain.id }).first();
        const cluster = await this.clusterForDomain(trx, input.domain.id);
        await trx(INGRESS_CLUSTER_TABLE).where({ id: cluster.id }).forUpdate().first();
        const service = this.service(cluster);
        const observed = await this.observed(service, cluster, input.domain);
        if (observed.rule) {
          if (!isManagedRule(observed.rule, input.domain, nonEmpty(binding?.providerRuleId))) {
            fail("ALB_HOST_RULE_CONFLICT", "拒绝删除非 Fanjin 管理的 Host 规则", 409);
          }
          await this.call(service, "DeleteRules", {
            ListenerId: cluster.httpsListenerId,
            RuleIds: [cloudId(observed.rule.RuleId, "Host 规则 ID")],
          });
        }
        if (observed.extension) {
          const extensionId = cloudId(observed.extension.DomainExtensionId, "域名扩展 ID");
          await this.call(service, "ModifyListenerAttributes", {
            ListenerId: cluster.httpsListenerId,
            DomainExtensions: [{ DomainExtensionId: extensionId, Action: "delete" }],
          });
        }
        const deadline = Date.now() + positiveInteger(
          this.env.FANJIN_TENANT_INGRESS_READBACK_TIMEOUT_MS,
          DEFAULT_READBACK_TIMEOUT_MS,
        );
        while (true) {
          const after = await this.observed(service, cluster, input.domain);
          if (!after.extension && !after.rule) break;
          if (Date.now() >= deadline) {
            fail("ALB_UNBIND_NOT_OBSERVED", "ALB 域名解绑回读未收敛", 502);
          }
          await this.sleep(positiveInteger(
            this.env.FANJIN_TENANT_INGRESS_READBACK_POLL_INTERVAL_MS,
            DEFAULT_POLL_INTERVAL_MS,
            5_000,
          ));
        }
      });
    } catch (error) {
      return translateProviderError(error);
    }
  }
}

let singleton: TenantDomainOrchestrator | null = null;

export function productionTenantDomainOrchestrator(
  options?: TenantDomainProductionOrchestratorOptions,
): TenantDomainOrchestrator {
  if (options) return new VolcengineTenantDomainOrchestrator(options);
  singleton ??= new VolcengineTenantDomainOrchestrator();
  return singleton;
}

export function resetProductionTenantDomainOrchestratorForTests(): void {
  singleton = null;
}

let recoveryTimer: NodeJS.Timeout | null = null;
let recoveryRunning = false;

export async function startTenantDomainOperationRecoveryWorker(): Promise<void> {
  if (!tenantIngressCloudEnabled() || recoveryTimer) return;
  const run = async () => {
    if (recoveryRunning) return;
    recoveryRunning = true;
    try {
      await recoverTenantDomainOperations({
        orchestrator: productionTenantDomainOrchestrator(),
        limit: positiveInteger(process.env.FANJIN_TENANT_DOMAIN_RECOVERY_BATCH_SIZE, 10, 50),
      });
    } finally {
      recoveryRunning = false;
    }
  };
  await run();
  recoveryTimer = setInterval(
    () => void run().catch(() => undefined),
    positiveInteger(process.env.FANJIN_TENANT_DOMAIN_RECOVERY_INTERVAL_MS, DEFAULT_RECOVERY_INTERVAL_MS, 3_600_000),
  );
  recoveryTimer.unref?.();
}

export async function stopTenantDomainOperationRecoveryWorker(): Promise<void> {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
  while (recoveryRunning) await new Promise((resolve) => setTimeout(resolve, 25));
}
