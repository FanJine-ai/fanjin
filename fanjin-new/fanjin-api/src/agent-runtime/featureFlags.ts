import type { NextFunction, Request, Response } from "express";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { AGENT_RUNTIME_WORKER_DEFAULTS } from "@/agent-runtime/worker";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";

export const AGENT_RUNTIME_PREVIEW_ENV = "FANJIN_AGENT_RUNTIME_PREVIEW";
export const AGENT_RUNTIME_ENABLED_ENV = "FANJIN_AGENT_RUNTIME_ENABLED";
export const AGENT_RUNTIME_WORKER_ENABLED_ENV = "FANJIN_AGENT_WORKER_ENABLED";
export const AGENT_RUNTIME_MODEL_ENABLED_ENV = "FANJIN_AGENT_MODEL_ENABLED";
export const AGENT_RUNTIME_TOOLS_ENABLED_ENV = "FANJIN_AGENT_TOOLS_ENABLED";
export const AGENT_RUNTIME_DELEGATION_ENABLED_ENV = "FANJIN_AGENT_DELEGATION_ENABLED";
export const AGENT_RUNTIME_DELEGATION_SIGNING_SECRET_ENV = "FANJIN_AGENT_DELEGATION_SIGNING_SECRET";
export const AGENT_RUNTIME_MODEL_ALIAS_ENV = "FANJIN_AGENT_MODEL_ALIAS";
export const AGENT_RUNTIME_PERSISTENCE_ONLY_ENV = "FANJIN_AGENT_PERSISTENCE_ONLY_ENABLED";
export const AGENT_RUNTIME_WORKER_MAX_ATTEMPTS_ENV = "FANJIN_AGENT_WORKER_MAX_ATTEMPTS";
export const AGENT_GENERATION_SUBMIT_ENABLED_ENV = "FANJIN_AGENT_GENERATION_SUBMIT_ENABLED";
export const AGENT_SURFACE_REQUIRED_ENV = "FANJIN_AGENT_SURFACE_REQUIRED";
export const AGENT_AUTO_APPROVE_ENABLED_ENV = "FANJIN_AGENT_AUTO_APPROVE_ENABLED";
export const AGENT_STREAM_ENABLED_ENV = "FANJIN_AGENT_STREAM_ENABLED";
export const AGENT_REVIEW_GATE_ENABLED_ENV = "FANJIN_AGENT_REVIEW_GATE_ENABLED";
export const AGENT_BILLING_RECONCILE_ENABLED_ENV = "FANJIN_AGENT_BILLING_RECONCILE_ENABLED";

function isEnabled(value: unknown): boolean {
  return String(value || "").trim() === "1";
}

/**
 * Public Agent REST/SSE gate. The old PREVIEW flag remains a compatibility
 * alias so existing isolated tests and preview environments keep working.
 */
export function isAgentRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env[AGENT_RUNTIME_ENABLED_ENV]) || isEnabled(env[AGENT_RUNTIME_PREVIEW_ENV]);
}

export function isAgentRuntimePreviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isAgentRuntimeEnabled(env);
}

/** Worker and model execution are separate opt-ins; opening the API alone is persistence-only. */
export function isAgentRuntimeWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isRecoveryOnlyMode(env)
    && isAgentRuntimeEnabled(env)
    && isEnabled(env[AGENT_RUNTIME_WORKER_ENABLED_ENV]);
}

export function isAgentRuntimeModelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isRecoveryOnlyMode(env)
    && isAgentRuntimeEnabled(env)
    && isEnabled(env[AGENT_RUNTIME_MODEL_ENABLED_ENV]);
}

/**
 * A model-backed submission is serviceable only when all three data-plane
 * switches agree. In particular, MODEL=1 without WORKER=1 must never create a
 * queued Run that no process is authorized to claim.
 */
export function isAgentRuntimeExecutionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return isAgentRuntimeWorkerEnabled(env) && isAgentRuntimeModelEnabled(env);
}

/**
 * Admission gate for newly-created tool Runs. Existing Runs are always routed
 * from their immutable policy snapshot so switching this off drains rather
 * than strands or semantically downgrades queued tool work.
 */
export function isAgentRuntimeToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isAgentRuntimeExecutionConfigured(env) && isEnabled(env[AGENT_RUNTIME_TOOLS_ENABLED_ENV]);
}

/**
 * Admission gate for newly-created delegation Runs. Execution must continue
 * to use the immutable Run snapshot: this live switch cannot revoke or widen
 * an already admitted delegation Run.
 */
export function isAgentRuntimeDelegationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isAgentRuntimeToolsEnabled(env) && isEnabled(env[AGENT_RUNTIME_DELEGATION_ENABLED_ENV]);
}

/**
 * Reads the stable HMAC secret used to verify persisted DelegationGrants.
 * The value is never trimmed, echoed, attached to errors, or logged.
 */
export function getAgentRuntimeDelegationSigningSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env[AGENT_RUNTIME_DELEGATION_SIGNING_SECRET_ENV];
  if (configured === undefined || configured === "") return null;
  const secret = String(configured);
  if (!secret.trim() || Buffer.byteLength(secret, "utf8") < 32) {
    throw new AgentRuntimeError(
      503,
      "agent_delegation_signing_secret_invalid",
      `${AGENT_RUNTIME_DELEGATION_SIGNING_SECRET_ENV} 必须是至少 32 字节的非空字符串`,
    );
  }
  return secret;
}

export function requireAgentRuntimeDelegationSigningSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = getAgentRuntimeDelegationSigningSecret(env);
  if (!secret) {
    throw new AgentRuntimeError(
      503,
      "agent_delegation_signing_secret_missing",
      `${AGENT_RUNTIME_DELEGATION_SIGNING_SECRET_ENV} 未配置`,
    );
  }
  return secret;
}

/**
 * Explicit test/local escape hatch for exercising persistence contracts
 * without a real model worker. It is intentionally unavailable in production
 * and must never be inferred from the public Runtime/Preview switch alone.
 */
export function isAgentRuntimePersistenceOnlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  return nodeEnv !== "prod" && nodeEnv !== "production"
    && isAgentRuntimeEnabled(env)
    && isEnabled(env[AGENT_RUNTIME_PERSISTENCE_ONLY_ENV]);
}

export function getAgentRuntimeModelAlias(env: NodeJS.ProcessEnv = process.env): string {
  return String(env[AGENT_RUNTIME_MODEL_ALIAS_ENV] || "agent-main").trim() || "agent-main";
}

/**
 * Gray switch for the R2 generation submit tools (REVAMP-PLAN 1.1). The tools
 * are registered and approval-quoted regardless of this switch, but their
 * execute handler refuses any real provider/billing side effect while it is
 * off, returning a `{status:"unavailable"}` JSON result instead of throwing.
 * Default is OFF; only `=1` enables real paid execution.
 */
export function isAgentGenerationSubmitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isRecoveryOnlyMode(env)
    && isEnabled(env[AGENT_GENERATION_SUBMIT_ENABLED_ENV]);
}

export const AGENT_GENERATION_SUBMIT_REQUIRED_ENV = Object.freeze([
  AGENT_RUNTIME_ENABLED_ENV,
  AGENT_RUNTIME_WORKER_ENABLED_ENV,
  AGENT_RUNTIME_MODEL_ENABLED_ENV,
  AGENT_RUNTIME_TOOLS_ENABLED_ENV,
] as const);

export interface AgentGenerationSubmitConfigurationInspection {
  enabled: boolean;
  ready: boolean;
  missingVariables: string[];
}

/**
 * Process-readiness contract for opening paid Agent generation. The paid flag
 * does not itself widen an already-persisted Run policy; this inspection only
 * prevents a deployment from reporting ready when operators enabled paid
 * generation without the four explicit Runtime data-plane switches.
 *
 * The legacy PREVIEW alias is deliberately insufficient for paid generation.
 */
export function inspectAgentGenerationSubmitConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): AgentGenerationSubmitConfigurationInspection {
  const enabled = isAgentGenerationSubmitEnabled(env);
  const missingVariables = enabled
    ? AGENT_GENERATION_SUBMIT_REQUIRED_ENV.filter(
        (name) => !isEnabled(env[name]),
      )
    : [];
  return {
    enabled,
    ready: !enabled || missingVariables.length === 0,
    missingVariables: [...missingVariables],
  };
}

export type AgentRuntimeToolingSwitchName = "runtime" | "worker" | "model" | "tools";
export type AgentRuntimeToolingStatus = "missing" | "enabled" | "disabled" | "invalid";
export interface AgentRuntimeToolingSwitchInspection {
  configured: boolean;
  enabled: boolean;
  status: AgentRuntimeToolingStatus;
}
export interface AgentRuntimeToolingConfigurationInspection {
  configured: boolean;
  enabled: boolean;
  status: AgentRuntimeToolingStatus;
  executionConfigured: boolean;
  toolsEnabled: boolean;
  switches: Record<AgentRuntimeToolingSwitchName, AgentRuntimeToolingSwitchInspection>;
}

function inspectExplicitEnableFlag(
  environmentKey: string,
  env: NodeJS.ProcessEnv,
): AgentRuntimeToolingSwitchInspection {
  const raw = env[environmentKey];
  const normalized = raw === undefined ? "" : String(raw).trim().toLowerCase();
  if (!normalized) return { configured: false, enabled: false, status: "missing" };
  if (normalized === "1") return { configured: true, enabled: true, status: "enabled" };
  if (["0", "false", "off"].includes(normalized)) {
    return { configured: true, enabled: false, status: "disabled" };
  }
  return { configured: true, enabled: false, status: "invalid" };
}

/** Redacted inspection used by the Agent configuration control plane. */
export function inspectAgentRuntimeToolingConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeToolingConfigurationInspection {
  const switches: AgentRuntimeToolingConfigurationInspection["switches"] = {
    runtime: inspectExplicitEnableFlag(AGENT_RUNTIME_ENABLED_ENV, env),
    worker: inspectExplicitEnableFlag(AGENT_RUNTIME_WORKER_ENABLED_ENV, env),
    model: inspectExplicitEnableFlag(AGENT_RUNTIME_MODEL_ENABLED_ENV, env),
    tools: inspectExplicitEnableFlag(AGENT_RUNTIME_TOOLS_ENABLED_ENV, env),
  };
  const values = Object.values(switches);
  const configured = values.every((inspection) => inspection.configured);
  const explicitlyEnabled = values.every((inspection) => inspection.enabled);
  const executionConfigured = isAgentRuntimeExecutionConfigured(env);
  const toolsEnabled = isAgentRuntimeToolsEnabled(env);
  const enabled = explicitlyEnabled && executionConfigured && toolsEnabled;
  const status: AgentRuntimeToolingStatus = enabled
    ? "enabled"
    : values.some((inspection) => inspection.status === "invalid")
      ? "invalid"
      : values.some((inspection) => inspection.status === "missing")
        ? "missing"
        : "disabled";
  return { configured, enabled, status, executionConfigured, toolsEnabled, switches };
}

export const AGENT_SURFACE_REQUIRED_SWITCH_ENV = Object.freeze([
  AGENT_RUNTIME_ENABLED_ENV,
  AGENT_RUNTIME_WORKER_ENABLED_ENV,
  AGENT_RUNTIME_MODEL_ENABLED_ENV,
  AGENT_RUNTIME_TOOLS_ENABLED_ENV,
  AGENT_GENERATION_SUBMIT_ENABLED_ENV,
  AGENT_BILLING_RECONCILE_ENABLED_ENV,
] as const);

export interface AgentSurfaceReadinessInspection {
  required: boolean;
  ready: boolean;
  switches: {
    runtime: boolean;
    worker: boolean;
    model: boolean;
    tools: boolean;
    generationSubmit: boolean;
    billingReconciliation: boolean;
  };
  missingVariables: string[];
}

/**
 * Deployment readiness gate for environments that promise the complete Agent
 * user surface. The summary exposes only boolean switch state and variable
 * names; raw environment values are never reflected.
 */
export function inspectAgentSurfaceReadiness(
  env: NodeJS.ProcessEnv = process.env,
): AgentSurfaceReadinessInspection {
  const required = isEnabled(env[AGENT_SURFACE_REQUIRED_ENV]);
  const switches = {
    runtime: isEnabled(env[AGENT_RUNTIME_ENABLED_ENV]),
    worker: isEnabled(env[AGENT_RUNTIME_WORKER_ENABLED_ENV]),
    model: isEnabled(env[AGENT_RUNTIME_MODEL_ENABLED_ENV]),
    tools: isEnabled(env[AGENT_RUNTIME_TOOLS_ENABLED_ENV]),
    generationSubmit: isEnabled(env[AGENT_GENERATION_SUBMIT_ENABLED_ENV]),
    billingReconciliation: isEnabled(env[AGENT_BILLING_RECONCILE_ENABLED_ENV]),
  };
  const missingVariables = required
    ? AGENT_SURFACE_REQUIRED_SWITCH_ENV.filter((name) => !isEnabled(env[name]))
    : [];
  return {
    required,
    ready: !required || missingVariables.length === 0,
    switches,
    missingVariables: [...missingVariables],
  };
}

/**
 * 预算自主审批灰度开关(默认关)。关闭时 R2/R3 审批全部走现有人工路径;
 * 开启后,项目已设 GU 预算且预留+报价最高额 ≤ 预算的 R2 审批在
 * pauseForApproval 同事务内自动批准并直接恢复 Run,不打扰用户。
 * 预算的读取/设置 API 不受此开关控制;开关只控制自动批准执行分叉。
 */
export function isAgentAutoApproveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env[AGENT_AUTO_APPROVE_ENABLED_ENV]);
}

/**
 * SSE 真流式灰度开关(REVAMP-PLAN 4.1,默认开)。开启时主 Agent 模型 Turn
 * 经 relay SSE 流式读取,增量正文以 message.delta 直推给 SSE 订阅方;
 * 显式设为 0/false/off 时回到一次性 relay 响应 + 750ms 轮询的既有行为。
 */
export function isAgentStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env[AGENT_STREAM_ENABLED_ENV] ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * Reviewer 质量门灰度开关(REVAMP-PLAN 2.3,默认关)。开启后 generation
 * submit 工具执行成功(图片入库/视频任务创建)即在 Gateway 同事务内触发规则
 * 版质量评估并写 o_agent_generation_review;失败结论只标记需人工注意,不自动
 * 重试、不改变工具成功语义。二期模型评估版复用同一记录结构(engine 区分)。
 */
export function isAgentReviewGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env[AGENT_REVIEW_GATE_ENABLED_ENV]);
}

/**
 * R2/R3 审批-扣费对账灰度开关(REVAMP-PLAN 2.4,普通环境默认关)。完整
 * Agent surface 的 readiness 会要求该开关显式为 1。开启后 agent worker
 * 周期性扫描 consumed R2/R3 审批与 GU 扣费流水(审批最高额 vs 实际扣费),
 * 只产出对账报告(日志 + 指标),不做任何自动修复。
 */
export function isAgentBillingReconcileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env[AGENT_BILLING_RECONCILE_ENABLED_ENV]);
}

/**
 * Recovery-budget limit shared by API Run creation and the live Worker.
 *
 * The API snapshots this value into each new Run while the Worker applies its
 * current value as a safety ceiling. Strict decimal parsing avoids silently
 * accepting partial, fractional, exponential or unsafe-integer values.
 */
export function getAgentRuntimeWorkerMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env[AGENT_RUNTIME_WORKER_MAX_ATTEMPTS_ENV] ?? "").trim();
  if (!raw) return AGENT_RUNTIME_WORKER_DEFAULTS.maxAttempts;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new AgentRuntimeError(
      503,
      "agent_worker_max_attempts_invalid",
      `${AGENT_RUNTIME_WORKER_MAX_ATTEMPTS_ENV} 必须是正整数`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new AgentRuntimeError(
      503,
      "agent_worker_max_attempts_invalid",
      `${AGENT_RUNTIME_WORKER_MAX_ATTEMPTS_ENV} 必须是安全正整数`,
    );
  }
  return value;
}

export function requireAgentRuntimePreview(_req: Request, res: Response, next: NextFunction) {
  if (!isAgentRuntimeEnabled()) {
    return res.status(503).send({
      code: "agent_runtime_unavailable",
      message: "Agent 服务暂未开放，请稍后再试",
    });
  }
  return next();
}
