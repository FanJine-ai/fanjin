import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, CircleDollarSign, Loader2, ShieldAlert, X } from "lucide-react";
import { ApiError } from "../../api/http";
import { formatGuMicros, formatYuanFromGuMicros } from "../../utils/billingUnits";
import { decideAgentApproval } from "./approvalApi";
import type {
  AgentRuntimeApproval,
  AgentRuntimeApprovalArgumentsSummary,
  AgentRuntimeApprovalDecision,
  AgentRuntimeApprovalStatus,
} from "./approvalTypes";
import "./AgentApprovalCard.css";

type AgentApprovalCardProps = {
  approval: AgentRuntimeApproval;
  generationCapability?: AgentApprovalGenerationCapability | null;
  onUpdated: (approval: AgentRuntimeApproval) => void;
  onRefresh: () => Promise<boolean>;
  onRequestError?: (error: unknown) => void;
};

export type AgentApprovalGenerationCapability = {
  generationType: "image" | "video";
  model: string;
  aspectRatios: readonly string[];
  qualities?: readonly string[];
  resolutions?: readonly string[];
};

const STATUS_LABELS: Record<AgentRuntimeApprovalStatus, string> = {
  pending: "待审批",
  approved: "已批准",
  denied: "已拒绝",
  consumed: "已执行",
  revoked: "已撤销",
  expired: "已过期",
};

// ─── 可编辑参数(REVAMP-PLAN 1.5,一期:prompt/ratio/resolution/quality;模型只读) ───

/** Editable keys of the phase-1 confirmation card. Everything else echoes read-only. */
const EDITABLE_ARGUMENT_KEYS = ["prompt", "ratio", "quality", "resolution"] as const;
type EditableArgumentKey = (typeof EDITABLE_ARGUMENT_KEYS)[number];

/** Draft values as shown in the form controls; "" on a select means 模型默认 (null). */
export type AgentApprovalArgumentDraft = Partial<Record<EditableArgumentKey, string>>;

const ARGUMENT_SUMMARY_STRING_LIMIT = 2_000;
const UNSUPPORTED_ARGUMENT_VALUE = "__unsupported_capability_value__";

type GenerationArgumentOptions = Partial<Record<Exclude<EditableArgumentKey, "prompt">, string[]>>;

function uniqueOptions(values: readonly string[] | undefined): string[] {
  return Array.from(new Set(
    (values || []).map((value) => String(value || "").trim()).filter(Boolean),
  ));
}

function approvalGenerationType(toolId: string): "image" | "video" | null {
  if (toolId === "generation.image.submit") return "image";
  if (toolId === "generation.video.submit") return "video";
  return null;
}

export function resolveApprovalGenerationArgumentOptions(
  approval: Pick<AgentRuntimeApproval, "toolId" | "argumentsSummary">,
  capability: AgentApprovalGenerationCapability | null | undefined,
): GenerationArgumentOptions | null {
  const generationType = approvalGenerationType(approval.toolId);
  if (!generationType) return {};
  const model = typeof approval.argumentsSummary?.model === "string"
    ? approval.argumentsSummary.model
    : "";
  if (
    !capability
    || capability.generationType !== generationType
    || capability.model !== model
  ) {
    return null;
  }
  if (generationType === "image") {
    return {
      ratio: uniqueOptions(capability.aspectRatios),
      quality: uniqueOptions(capability.qualities),
    };
  }
  return {
    ratio: uniqueOptions(capability.aspectRatios),
    resolution: uniqueOptions(capability.resolutions),
  };
}

export function unsupportedApprovalGenerationArguments(
  summary: AgentRuntimeApprovalArgumentsSummary | null,
  draft: AgentApprovalArgumentDraft,
  options: GenerationArgumentOptions | null,
): Exclude<EditableArgumentKey, "prompt">[] {
  if (!summary || options === null) return [];
  return (Object.entries(options) as Array<
    [Exclude<EditableArgumentKey, "prompt">, string[]]
  >).flatMap(([key, allowed]) => {
    if (!(key in summary)) return [];
    const value = draft[key] ?? readDraftValue(summary, key);
    if (allowed.length === 0 || (value !== "" && !allowed.includes(value))) {
      return [key];
    }
    return [];
  });
}

function readDraftValue(summary: AgentRuntimeApprovalArgumentsSummary, key: EditableArgumentKey): string {
  const raw = summary[key];
  if (raw === null || raw === undefined) return "";
  return String(raw);
}

/** Echo the current proposal values from the DTO arguments summary into a draft. */
export function readApprovalArgumentDraft(
  summary: AgentRuntimeApprovalArgumentsSummary | null,
): AgentApprovalArgumentDraft {
  const draft: AgentApprovalArgumentDraft = {};
  if (!summary) return draft;
  for (const key of EDITABLE_ARGUMENT_KEYS) {
    if (key in summary) draft[key] = readDraftValue(summary, key);
  }
  return draft;
}

function draftValueToArgument(key: EditableArgumentKey, value: string): string | null {
  if (key === "prompt") return value;
  return value === "" ? null : value;
}

/**
 * Merge the draft into the proposal's arguments summary. Returns the complete
 * revised tool-call payload when anything actually changed, otherwise
 * undefined — an untouched card must approve without revisedArguments so the
 * original hash/quote binding stays intact.
 */
export function resolveRevisedArguments(
  summary: AgentRuntimeApprovalArgumentsSummary | null,
  draft: AgentApprovalArgumentDraft,
): AgentRuntimeApprovalArgumentsSummary | undefined {
  if (!summary) return undefined;
  let dirty = false;
  const merged: AgentRuntimeApprovalArgumentsSummary = { ...summary };
  for (const key of EDITABLE_ARGUMENT_KEYS) {
    if (!(key in summary)) continue;
    const draftValue = draft[key];
    if (draftValue === undefined) continue;
    const nextValue = draftValueToArgument(key, draftValue);
    if (merged[key] !== nextValue) {
      merged[key] = nextValue;
      dirty = true;
    }
  }
  return dirty ? merged : undefined;
}

export function isApprovalArgumentDraftDirty(
  summary: AgentRuntimeApprovalArgumentsSummary | null,
  draft: AgentApprovalArgumentDraft,
): boolean {
  return resolveRevisedArguments(summary, draft) !== undefined;
}

/**
 * The server truncates summary strings at 2000 chars. Re-sending an edited
 * payload with a possibly-truncated prompt would silently shorten the real
 * prompt, so revision is only safe while the echoed prompt is below the cap.
 */
export function canSafelyReviseApproval(summary: AgentRuntimeApprovalArgumentsSummary | null): boolean {
  if (!summary) return false;
  return typeof summary.prompt !== "string" || summary.prompt.length < ARGUMENT_SUMMARY_STRING_LIMIT;
}

/** Prompt must survive the tool schema's trim().min(1) when revised. */
export function isApprovalDraftPromptValid(
  summary: AgentRuntimeApprovalArgumentsSummary | null,
  draft: AgentApprovalArgumentDraft,
): boolean {
  if (!summary || !("prompt" in summary)) return true;
  const value = draft.prompt;
  if (value === undefined) return true;
  return value.trim().length > 0;
}

export type AgentApprovalDecisionInput = {
  decision: AgentRuntimeApprovalDecision;
  expectedRevision: number;
  revisedArguments?: AgentRuntimeApprovalArgumentsSummary;
};

/**
 * 「批准」语义:参数被改过 → 携带完整 revisedArguments(修订批准,后端重算
 * 哈希/报价/检查点);未改 → 原样批准;「拒绝」永远不带 revisedArguments。
 */
export function buildApprovalDecisionInput(
  approval: AgentRuntimeApproval,
  decision: AgentRuntimeApprovalDecision,
  draft: AgentApprovalArgumentDraft,
): AgentApprovalDecisionInput {
  const base: AgentApprovalDecisionInput = {
    decision,
    expectedRevision: approval.revision,
  };
  if (decision !== "approved") return base;
  const revisedArguments = resolveRevisedArguments(approval.argumentsSummary, draft);
  return revisedArguments ? { ...base, revisedArguments } : base;
}

export type AgentApprovalDecisionResult =
  | { kind: "updated"; approval: AgentRuntimeApproval; revised: boolean }
  | { kind: "conflict"; refreshed: boolean }
  | { kind: "failed"; error: unknown };

/**
 * Card decision flow, isolated from React so the 409 过期/revision 冲突分支
 * stays unit-testable: conflict → onRefresh → caller renders the hint.
 */
export async function submitApprovalDecision(options: {
  approval: AgentRuntimeApproval;
  decision: AgentRuntimeApprovalDecision;
  draft?: AgentApprovalArgumentDraft;
  onRefresh: () => Promise<boolean>;
  decide?: typeof decideAgentApproval;
}): Promise<AgentApprovalDecisionResult> {
  const decide = options.decide ?? decideAgentApproval;
  const input = buildApprovalDecisionInput(options.approval, options.decision, options.draft ?? {});
  try {
    const updated = await decide(options.approval.id, input);
    return { kind: "updated", approval: updated, revised: input.revisedArguments !== undefined };
  } catch (error) {
    if (isApprovalStateConflict(error)) {
      return { kind: "conflict", refreshed: await options.onRefresh() };
    }
    if (isApprovalDecisionOutcomeUncertain(error)) {
      const refreshed = await options.onRefresh().catch(() => false);
      if (refreshed) return { kind: "conflict", refreshed: true };
    }
    return { kind: "failed", error };
  }
}

function formatQuote(micros: number) {
  return `${formatGuMicros(Math.max(0, micros))}（约 ${formatYuanFromGuMicros(Math.max(0, micros))}）`;
}

function formatExpiry(value: number) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isApprovalStateConflict(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  return error.status === 409
    || error.code === "approval_expired"
    || error.code === "approval_revision_conflict"
    || error.code === "approval_not_pending";
}

/**
 * 没有收到确定 HTTP 4xx 的决定请求都可能已经在服务端提交成功。此时绝不
 * 自动重发 POST，只允许调用方用 approvals GET 刷新同一审批。
 */
function isApprovalDecisionOutcomeUncertain(error: unknown) {
  if (!(error instanceof ApiError)) return true;
  return error.status === undefined
    || error.status === 408
    || error.status >= 500;
}

function readUnits(summary: AgentRuntimeApprovalArgumentsSummary | null) {
  const units = summary?.units;
  return typeof units === "number" && Number.isFinite(units) && units >= 1 ? Math.floor(units) : 1;
}

/** 报价/影响写成一句人话(借鉴 Copilot linkReason 风格)。 */
export function describeApprovalPlainly(approval: AgentRuntimeApproval): string | null {
  if (approval.toolId === "generation.image.submit" && approval.quote) {
    return `将在项目生成 ${readUnits(approval.argumentsSummary)} 张图片，预计消耗 ${formatQuote(approval.quote.estimatedCostMicros)}。`;
  }
  if (approval.toolId === "generation.video.submit" && approval.quote) {
    return `将在项目生成 ${readUnits(approval.argumentsSummary)} 段视频，预计消耗 ${formatQuote(approval.quote.estimatedCostMicros)}。`;
  }
  if (approval.quote) {
    return `执行该操作预计消耗 ${formatQuote(approval.quote.estimatedCostMicros)}（最高 ${formatQuote(approval.quote.maximumCostMicros)}）。`;
  }
  if (approval.impactSummary) return approval.impactSummary.summary;
  return null;
}

export default function AgentApprovalCard({
  approval,
  generationCapability,
  onUpdated,
  onRefresh,
  onRequestError,
}: AgentApprovalCardProps) {
  const [submitting, setSubmitting] = useState<AgentRuntimeApprovalDecision | null>(null);
  const [feedback, setFeedback] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const [draft, setDraft] = useState<AgentApprovalArgumentDraft>(() =>
    readApprovalArgumentDraft(approval.argumentsSummary));
  const submittingRef = useRef(false);

  useEffect(() => {
    if (approval.status !== "pending") return undefined;
    const remaining = approval.expiresAt - Date.now();
    if (remaining <= 0) {
      setClock(Date.now());
      return undefined;
    }
    const timer = window.setTimeout(() => setClock(Date.now()), remaining + 25);
    return () => window.clearTimeout(timer);
  }, [approval.expiresAt, approval.status]);

  // Re-echo the proposal only when the server-side proposal actually changed
  // (id/revision/content), so a background refresh never wipes an in-progress edit.
  const summaryKey = JSON.stringify(approval.argumentsSummary);
  useEffect(() => {
    setDraft(readApprovalArgumentDraft(approval.argumentsSummary));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval.id, approval.revision, summaryKey]);

  const locallyExpired = approval.status === "pending" && approval.expiresAt <= clock;
  const visibleStatus: AgentRuntimeApprovalStatus = locallyExpired ? "expired" : approval.status;
  const pending = visibleStatus === "pending";
  // 预算自主审批:额度内服务端自动批准,不打扰用户;卡片只读展示来源。
  const statusLabel = approval.autoApproved && visibleStatus === "approved"
    ? "预算内自动批准"
    : STATUS_LABELS[visibleStatus];

  const summary = approval.argumentsSummary;
  const dirty = isApprovalArgumentDraftDirty(summary, draft);
  const promptValid = isApprovalDraftPromptValid(summary, draft);
  const revisionUnsafe = dirty && !canSafelyReviseApproval(summary);
  const generationType = approvalGenerationType(approval.toolId);
  const generationArgumentOptions = resolveApprovalGenerationArgumentOptions(
    approval,
    generationCapability,
  );
  const capabilityUnavailable = Boolean(
    generationType
    && (!summary || generationArgumentOptions === null),
  );
  const unsupportedArguments = unsupportedApprovalGenerationArguments(
    summary,
    draft,
    generationArgumentOptions,
  );
  const approveDisabled = Boolean(submitting)
    || !promptValid
    || revisionUnsafe
    || capabilityUnavailable
    || unsupportedArguments.length > 0;
  const plainLine = describeApprovalPlainly(approval);

  async function submitDecision(decision: AgentRuntimeApprovalDecision) {
    if (!pending || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(decision);
    setFeedback("");
    try {
      const result = await submitApprovalDecision({ approval, decision, draft, onRefresh });
      if (result.kind === "updated") {
        onUpdated(result.approval);
        setFeedback(result.revised
          ? "审批决定已记录：已按修订后的参数批准，后端已重算报价。Runtime 将在后续恢复时继续处理。"
          : `审批决定已记录：${decision === "approved" ? "已批准" : "已拒绝"}。Runtime 将在后续恢复时继续处理。`);
      } else if (result.kind === "conflict") {
        setFeedback(result.refreshed
          ? "审批已过期或状态已变化，已从服务器重新确认；本次操作未重复提交。"
          : "审批状态暂时无法确认。为安全起见，本次操作未重复提交。");
      } else {
        onRequestError?.(result.error);
        setFeedback("审批决定未能记录。为安全起见，请确认服务器状态后再试。");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(null);
    }
  }

  function updateDraft(key: EditableArgumentKey, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function renderArgumentSelect(
    key: Exclude<EditableArgumentKey, "prompt">,
    label: string,
    options: string[] | undefined,
  ) {
    if (!summary || !(key in summary) || options === undefined) return null;
    const current = draft[key] ?? readDraftValue(summary, key);
    const unsupported = options.length === 0 || (current !== "" && !options.includes(current));
    const selectValue = unsupported ? UNSUPPORTED_ARGUMENT_VALUE : current;
    return (
      <label className="agentApprovalArgRow" data-field={key}>
        <span className="agentApprovalArgLabel">{label}</span>
        <select
          value={selectValue}
          disabled={Boolean(submitting)}
          onChange={(event) => updateDraft(key, event.target.value)}
          aria-label={`${label}（可修改）`}
        >
          {unsupported ? (
            <option value={UNSUPPORTED_ARGUMENT_VALUE} disabled>
              {options.length === 0 ? "模型未配置该能力" : "当前参数不受支持，请重新选择"}
            </option>
          ) : null}
          <option value="">模型默认</option>
          {options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }

  const otherArgumentEntries = summary
    ? Object.entries(summary).filter(([key]) => (
      key !== "model" && !(EDITABLE_ARGUMENT_KEYS as readonly string[]).includes(key)
    ))
    : [];

  return (
    <section
      className={`agentApprovalCard risk-${approval.riskClass.toLowerCase()}`}
      data-testid="agent-approval-card"
      data-tool-id={approval.toolId}
      aria-label={`工具审批：${approval.toolId}`}
      data-approval-id={approval.id}
      data-approval-status={visibleStatus}
    >
      <header>
        <div className="agentApprovalTitle">
          {approval.riskClass === "R3" ? <ShieldAlert size={18} /> : <CircleDollarSign size={18} />}
          <span>
            <strong>{approval.riskClass === "R3" ? "高风险工具审批" : "费用工具审批"}</strong>
            <small>{approval.toolId} · v{approval.toolVersion}</small>
          </span>
        </div>
        <span className="agentApprovalStatus">{statusLabel}</span>
      </header>

      <div className="agentApprovalEvidence">
        {plainLine ? <p className="agentApprovalPlain">{plainLine}</p> : null}

        {approval.quote ? (
          <div className="agentApprovalQuote" aria-label="GU 费用估算">
            <span>预计 <strong>{formatQuote(approval.quote.estimatedCostMicros)}</strong></span>
            <span>最高 <strong>{formatQuote(approval.quote.maximumCostMicros)}</strong></span>
          </div>
        ) : null}

        {approval.impactSummary ? (
          <>
            <p>{approval.impactSummary.summary}</p>
            {approval.impactSummary.destructive ? (
              <p className="agentApprovalDestructive" role="alert">
                <AlertTriangle size={14} />
                此操作具有破坏性，可能无法自动撤销。
              </p>
            ) : null}
            {approval.impactSummary.affectedResourceRefs.length ? (
              <ul className="agentApprovalResources" aria-label="受影响资源">
                {approval.impactSummary.affectedResourceRefs.map((resourceRef) => (
                  <li key={resourceRef}>{resourceRef}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}

        <p className="agentApprovalMeta">审批有效至 {formatExpiry(approval.expiresAt)}</p>
      </div>

      {pending && summary ? (
        <div className="agentApprovalArgs" aria-label="提案参数（可在批准前修改）">
          {typeof summary.model === "string" ? (
            <p className="agentApprovalArgRow" data-field="model">
              <span className="agentApprovalArgLabel">模型</span>
              <span className="agentApprovalArgValue">{summary.model}</span>
            </p>
          ) : null}

          {"prompt" in summary ? (
            <label className="agentApprovalArgRow" data-field="prompt">
              <span className="agentApprovalArgLabel">提示词</span>
              <textarea
                value={draft.prompt ?? readDraftValue(summary, "prompt")}
                rows={3}
                maxLength={4000}
                disabled={Boolean(submitting)}
                onChange={(event) => updateDraft("prompt", event.target.value)}
                aria-label="提示词（可修改）"
              />
            </label>
          ) : null}

          {renderArgumentSelect("ratio", "比例", generationArgumentOptions?.ratio)}
          {renderArgumentSelect("quality", "清晰度", generationArgumentOptions?.quality)}
          {renderArgumentSelect("resolution", "分辨率", generationArgumentOptions?.resolution)}

          {otherArgumentEntries.length ? (
            <div className="agentApprovalArgRow" data-field="other">
              <span className="agentApprovalArgLabel">其他参数</span>
              <ul className="agentApprovalResources" aria-label="其他提案参数">
                {otherArgumentEntries.map(([key, value]) => (
                  <li key={key}>{key}={String(value)}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {!promptValid ? (
            <p className="agentApprovalArgHint" role="alert">提示词不能为空；请填写内容，或改回模型原提案。</p>
          ) : null}
          {revisionUnsafe ? (
            <p className="agentApprovalArgHint" role="alert">
              提示词过长，无法在卡片内安全修订；请拒绝后重新描述需求，或不做修改直接批准。
            </p>
          ) : null}
          {capabilityUnavailable ? (
            <p className="agentApprovalArgHint" role="alert">
              当前模型能力尚未加载或已变化，暂不能安全批准；请刷新模型能力后重试。
            </p>
          ) : null}
          {unsupportedArguments.length > 0 ? (
            <p className="agentApprovalArgHint" role="alert">
              当前提案包含模型不支持的规格，请重新选择模型允许的参数后再批准。
            </p>
          ) : null}
        </div>
      ) : null}

      {pending && generationType && !summary ? (
        <p className="agentApprovalArgHint" role="alert">
          当前生成审批缺少可核验的参数摘要，暂不能安全批准；请刷新或重新发起生成提案。
        </p>
      ) : null}

      {pending ? (
        <div className="agentApprovalActions" aria-busy={submitting ? "true" : "false"}>
          <button
            className="reject"
            type="button"
            data-testid="agent-approval-deny"
            disabled={Boolean(submitting)}
            onClick={() => void submitDecision("denied")}
          >
            {submitting === "denied" ? <Loader2 className="jimengSpin" size={13} /> : <X size={13} />}
            拒绝
          </button>
          <button
            className="approve"
            type="button"
            disabled={approveDisabled}
            data-testid="agent-approval-approve"
            onClick={() => void submitDecision("approved")}
          >
            {submitting === "approved" ? <Loader2 className="jimengSpin" size={13} /> : <Check size={13} />}
            {dirty ? "按新参数批准" : "批准"}
          </button>
        </div>
      ) : null}

      {feedback ? (
        <p
          className="agentApprovalFeedback"
          role="status"
          aria-live="polite"
          data-testid="agent-approval-feedback"
        >
          {feedback}
        </p>
      ) : null}
    </section>
  );
}
