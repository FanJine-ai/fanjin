import crypto from "node:crypto";
import type { Knex } from "knex";
import {
  VIDEO_ASSET_POLICY_EVIDENCE_VERSION,
  readVideoAssetPolicyConfiguration,
  resolveVideoAssetPolicyDecisions,
  type TrustedVideoAssetPolicyEvidence,
  type VideoAssetPolicyVerdict,
  type VideoOutputPolicy,
} from "@/lib/videoAssetPolicy";
import type { VideoGenerationRequest } from "@/lib/videoGenerationContract";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._/-]{2,127}$/u;
const OPAQUE_ID_PATTERN = /^[^\u0000-\u001f\u007f\s]{1,256}$/u;

export class VideoAssetPolicyRelayBindingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "VideoAssetPolicyRelayBindingError";
    this.code = code;
    this.status = 409;
    this.statusCode = 409;
    this.retryable = retryable;
  }
}

function fail(code: string, message: string, retryable = false): never {
  throw new VideoAssetPolicyRelayBindingError(code, message, retryable);
}

function failCurrentPolicyDecision(input: {
  verdict: VideoAssetPolicyVerdict;
  reason?: string;
}): never {
  const failures: Partial<Record<VideoAssetPolicyVerdict, {
    code: string;
    message: string;
    retryable: boolean;
  }>> = {
    denied: {
      code: "video_asset_policy_denied",
      message: "参考素材已被管理员拒绝使用",
      retryable: false,
    },
    portrait_pending: {
      code: "portrait_admission_pending",
      message: "参考素材的人像校验尚未完成，请稍后重试",
      retryable: true,
    },
    portrait_provider_pending: {
      code: "portrait_provider_binding_pending",
      message: "参考素材的上游人像资产尚未就绪，请稍后重试",
      retryable: true,
    },
    portrait_consent_invalid: {
      code: "portrait_consent_inactive",
      message: "参考素材的人像授权未生效，请重新授权后重试",
      retryable: true,
    },
    portrait_rejected: {
      code: "portrait_admission_denied",
      message: "参考素材未通过人像准入校验",
      retryable: false,
    },
  };
  const failure = failures[input.verdict] ?? {
    code: "video_asset_policy_evidence_stale",
    message: "视频素材策略证据已变化，请重新校验参考素材",
    retryable: false,
  };
  fail(failure.code, input.reason || failure.message, failure.retryable);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function parseOutputPolicy(value: unknown): VideoOutputPolicy {
  const candidate = record(value);
  if (
    !candidate
    || !exactKeys(candidate, ["aigcLabel", "watermark", "retainPolicyEvidenceDays"])
    || !["required", "provider", "disabled"].includes(String(candidate.aigcLabel))
    || !["required", "provider", "disabled"].includes(String(candidate.watermark))
    || !Number.isSafeInteger(candidate.retainPolicyEvidenceDays)
    || Number(candidate.retainPolicyEvidenceDays) < 1
    || Number(candidate.retainPolicyEvidenceDays) > 3650
  ) {
    fail("video_asset_policy_evidence_invalid", "视频素材策略输出证据无效");
  }
  return {
    aigcLabel: candidate.aigcLabel as VideoOutputPolicy["aigcLabel"],
    watermark: candidate.watermark as VideoOutputPolicy["watermark"],
    retainPolicyEvidenceDays: Number(candidate.retainPolicyEvidenceDays),
  };
}

function parseConsentExpiry(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !value
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("video_asset_policy_evidence_invalid", "视频素材授权有效期证据无效");
  }
  return value;
}

/**
 * Re-validates a server-produced policy proof at Relay's trust boundary.
 * The binding is never read from an HTTP/provider-shaped payload.
 */
export function validateTrustedVideoAssetPolicyRelayBinding(input: {
  canonicalRequest: VideoGenerationRequest;
  workspaceId: string;
  projectId: string | number;
  evidence: TrustedVideoAssetPolicyEvidence | null | undefined;
}): TrustedVideoAssetPolicyEvidence | null {
  const workspaceId = String(input.workspaceId || "").trim();
  const projectId = String(input.projectId || "").trim();
  if (!OPAQUE_ID_PATTERN.test(workspaceId) || !OPAQUE_ID_PATTERN.test(projectId)) {
    fail("video_asset_policy_scope_invalid", "视频素材策略绑定缺少可信工作区或项目范围");
  }
  const requestedAssetVersionIds = Array.from(new Set(
    input.canonicalRequest.inputs.map((item) => String(item.assetVersionId || "").trim()),
  ));
  if (requestedAssetVersionIds.some((id) => !OPAQUE_ID_PATTERN.test(id))) {
    fail("video_asset_policy_request_invalid", "统一视频请求包含无效素材版本");
  }
  if (!input.evidence) {
    if (requestedAssetVersionIds.length === 0) return null;
    fail("video_asset_policy_evidence_required", "视频参考素材缺少可信策略证据");
  }

  const candidate = record(input.evidence);
  if (!candidate || !exactKeys(candidate, [
    "version",
    "workspaceId",
    "projectId",
    "assetVersionIds",
    "enforcementEnabled",
    "policyVersion",
    "outputPolicy",
    "evidenceDigest",
    "decisions",
  ])) {
    fail("video_asset_policy_evidence_invalid", "视频素材策略证据结构无效");
  }
  if (
    candidate.version !== VIDEO_ASSET_POLICY_EVIDENCE_VERSION
    || candidate.workspaceId !== workspaceId
    || candidate.projectId !== projectId
    || !Array.isArray(candidate.assetVersionIds)
    || typeof candidate.enforcementEnabled !== "boolean"
    || typeof candidate.policyVersion !== "string"
    || !VERSION_PATTERN.test(candidate.policyVersion)
    || typeof candidate.evidenceDigest !== "string"
    || !DIGEST_PATTERN.test(candidate.evidenceDigest)
    || !Array.isArray(candidate.decisions)
  ) {
    fail("video_asset_policy_evidence_invalid", "视频素材策略证据字段无效");
  }

  const boundAssetVersionIds = candidate.assetVersionIds.map((value) => (
    typeof value === "string" ? value : ""
  ));
  if (
    boundAssetVersionIds.some((id) => !OPAQUE_ID_PATTERN.test(id))
    || new Set(boundAssetVersionIds).size !== boundAssetVersionIds.length
    || boundAssetVersionIds.length !== requestedAssetVersionIds.length
    || boundAssetVersionIds.some((id, index) => id !== requestedAssetVersionIds[index])
  ) {
    fail("video_asset_policy_evidence_mismatch", "视频素材策略证据与实际参考素材顺序不一致");
  }

  const outputPolicy = parseOutputPolicy(candidate.outputPolicy);
  const decisions = candidate.decisions.map((value) => {
    const decision = record(value);
    if (!decision || !exactKeys(decision, [
      "decisionId",
      "decisionDigest",
      "decidedAt",
      "assetVersionId",
      "authorizationEvidenceId",
      "moderationEvidenceId",
      "policyVersion",
      "consentExpiresAt",
    ])) {
      fail("video_asset_policy_evidence_invalid", "视频素材策略判定证据结构无效");
    }
    for (const key of [
      "decisionId",
      "assetVersionId",
      "authorizationEvidenceId",
      "moderationEvidenceId",
    ] as const) {
      if (typeof decision[key] !== "string" || !OPAQUE_ID_PATTERN.test(decision[key])) {
        fail("video_asset_policy_evidence_invalid", "视频素材策略判定证据标识无效");
      }
    }
    const undatedNonPortraitMedia = decision.decidedAt === null
      && decision.decisionId === `portrait-non-media:${decision.assetVersionId}`
      && decision.authorizationEvidenceId === `portrait-not-required:${decision.assetVersionId}`
      && decision.moderationEvidenceId === `portrait-not-required:${decision.assetVersionId}`;
    const advisoryPrefix = "portrait-precheck-advisory:";
    const advisoryAdmissionId = String(decision.decisionId).startsWith(advisoryPrefix)
      ? String(decision.decisionId).slice(advisoryPrefix.length) : "";
    // Advisory submission permission has no successful audit timestamp. It
    // remains bound to a real admission and is compared with current policy
    // immediately before dispatch, including any new refusal or revocation.
    const undatedAdvisory = decision.decidedAt === null
      && OPAQUE_ID_PATTERN.test(advisoryAdmissionId)
      && decision.authorizationEvidenceId === `project-asset:${decision.assetVersionId}`
      && decision.moderationEvidenceId === `provider-review-pending:${advisoryAdmissionId}`;
    if (
      typeof decision.decisionDigest !== "string"
      || !DIGEST_PATTERN.test(decision.decisionDigest)
      || (!(undatedNonPortraitMedia || undatedAdvisory) && (
        !Number.isSafeInteger(decision.decidedAt)
        || Number(decision.decidedAt) <= 0
      ))
      || decision.policyVersion !== candidate.policyVersion
    ) {
      fail("video_asset_policy_evidence_invalid", "视频素材策略判定证据字段无效");
    }
    return {
      decisionId: decision.decisionId as string,
      decisionDigest: decision.decisionDigest as string,
      decidedAt: undatedNonPortraitMedia || undatedAdvisory ? null : Number(decision.decidedAt),
      assetVersionId: decision.assetVersionId as string,
      authorizationEvidenceId: decision.authorizationEvidenceId as string,
      moderationEvidenceId: decision.moderationEvidenceId as string,
      policyVersion: decision.policyVersion as string,
      consentExpiresAt: parseConsentExpiry(decision.consentExpiresAt),
    };
  });

  const decisionAssetVersionIds = decisions.map((decision) => decision.assetVersionId);
  if (
    new Set(decisionAssetVersionIds).size !== decisionAssetVersionIds.length
    || decisionAssetVersionIds.some((id) => !requestedAssetVersionIds.includes(id))
  ) {
    fail("video_asset_policy_evidence_invalid", "视频素材策略证据包含重复素材判定");
  }
  if (candidate.enforcementEnabled) {
    const requested = [...requestedAssetVersionIds].sort();
    const decided = [...decisionAssetVersionIds].sort();
    if (
      requested.length !== decided.length
      || requested.some((id, index) => id !== decided[index])
    ) {
      fail("video_asset_policy_evidence_mismatch", "视频素材策略证据与实际参考素材不一致");
    }
  }

  const core = {
    version: VIDEO_ASSET_POLICY_EVIDENCE_VERSION,
    workspaceId,
    projectId,
    assetVersionIds: boundAssetVersionIds,
    enforcementEnabled: candidate.enforcementEnabled,
    policyVersion: candidate.policyVersion,
    outputPolicy,
    decisions,
  };
  if (candidate.evidenceDigest !== sha256(core)) {
    fail("video_asset_policy_evidence_digest_mismatch", "视频素材策略证据摘要校验失败");
  }
  return {
    ...core,
    evidenceDigest: candidate.evidenceDigest,
  };
}

/**
 * Re-reads the current signed policy decisions immediately before Relay
 * routing/pricing/reservation. This closes the race between reference URL
 * resolution and provider dispatch when consent, moderation or policy version
 * changes in between.
 */
export async function resolveFreshVideoAssetPolicyRelayBinding(input: {
  canonicalRequest: VideoGenerationRequest | null;
  workspaceId: string;
  projectId: string | number;
  evidence: TrustedVideoAssetPolicyEvidence | null | undefined;
  database?: Knex | Knex.Transaction;
}): Promise<TrustedVideoAssetPolicyEvidence | null> {
  const workspaceId = String(input.workspaceId || "").trim();
  const projectId = String(input.projectId || "").trim();
  if (!OPAQUE_ID_PATTERN.test(workspaceId) || !OPAQUE_ID_PATTERN.test(projectId)) {
    if (!input.canonicalRequest && !input.evidence) {
      const configuration = await readVideoAssetPolicyConfiguration({
        ...(input.database ? { database: input.database } : {}),
      });
      if (!configuration.enforcementEnabled) return null;
    }
    fail("video_asset_policy_scope_invalid", "视频素材策略绑定缺少可信工作区或项目范围");
  }
  const assetVersionIds = input.canonicalRequest
    ? Array.from(new Set(input.canonicalRequest.inputs.map((item) => item.assetVersionId)))
    : [];
  const current = await resolveVideoAssetPolicyDecisions({
    ...(input.database ? { database: input.database } : {}),
    workspaceId,
    projectId,
    assetVersionIds,
  });
  const currentRejection = current.decisions.find((decision) => decision.verdict !== "allowed");
  if (currentRejection) {
    failCurrentPolicyDecision(currentRejection);
  }

  if (!input.canonicalRequest) {
    if (input.evidence) {
      fail(
        "video_asset_policy_endpoint_mismatch",
        "素材策略证据只能绑定规范化视频请求",
      );
    }
    if (current.configuration.enforcementEnabled) {
      fail(
        "video_asset_policy_canonical_request_required",
        "启用视频素材策略后必须使用规范化视频请求",
      );
    }
    return null;
  }

  if (!input.evidence) {
    if (current.configuration.enforcementEnabled || current.decisions.length > 0) {
      fail("video_asset_policy_evidence_required", "视频请求缺少当前素材策略证据");
    }
    return null;
  }
  const validated = validateTrustedVideoAssetPolicyRelayBinding({
    canonicalRequest: input.canonicalRequest,
    workspaceId,
    projectId,
    evidence: input.evidence,
  });
  if (
    !validated
    || !current.trustedEvidence
    || validated.evidenceDigest !== current.trustedEvidence.evidenceDigest
  ) {
    fail(
      "video_asset_policy_evidence_stale",
      "视频素材策略证据已变化，请重新校验参考素材",
    );
  }
  return validated;
}
