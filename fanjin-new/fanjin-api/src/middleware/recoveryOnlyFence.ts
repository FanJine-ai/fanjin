import type { NextFunction, Request, Response } from "express";

import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";
import { isCandidateRuntimeReadonlyEvidenceMode } from "@/lib/candidateRuntimeAttestation";
import {
  resolveCandidateSignedReadContract,
} from "@/lib/candidateSignedReadContract";
import {
  ISOLATED_SESSION_EVIDENCE_SEQUENCE_HEADER,
  authorizeInstalledIsolatedSessionEvidenceRequest,
  isIsolatedSessionEvidenceMode,
} from "@/lib/isolatedSessionEvidenceRuntime";
import {
  authorizeCandidateESettledImageRecoveryRequest,
} from "@/lib/candidateESettledImageRecovery";
import {
  QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_HEADER,
  quickCreateImageCheckpointRecoveryAuthorizedValue,
} from "@/lib/quickCreateImageCheckpointMaterialization";

// Recovery GETs are fail-closed too. Every entry below was reviewed as a
// recovery-only local evidence read that is not part of the signed candidate
// registry. Provider polling is kept in a separate GET-only list:
// Express otherwise maps HEAD to GET and would turn a metadata probe into a
// provider request plus task materialization writes.
export const RECOVERY_ONLY_READ_GET_PATHS = new Set([
  "/api/health",
  "/api/internal/candidate-runtime-attestation",
  "/api/metrics",
  "/api/ready",
  "/api/account/oauth/identities",
  "/api/auth/oauth/providers",
  "/api/auth/registration-policy",
  "/api/billing/ledger",
  "/api/other/getVersion",
  "/api/workbench/commands/status",
  "/health",
  "/healthz",
  "/metrics",
  "/readiness",
  "/ready",
]);

const SAFE_RESOURCE_SEGMENT = "[A-Za-z0-9._:-]{1,200}";
export const RECOVERY_ONLY_READ_GET_PATTERNS = Object.freeze([
  /^\/(?:assets|oss|skills)(?:\/.*)?$/,
  new RegExp(`^/api/agent/config/roles(?:/${SAFE_RESOURCE_SEGMENT})?$`),
  new RegExp(`^/api/agent/runs/${SAFE_RESOURCE_SEGMENT}(?:/(?:approvals|steps))?$`),
  new RegExp(`^/api/deletion/operations/${SAFE_RESOURCE_SEGMENT}$`),
  /^\/api\/projects\/[1-9]\d*\/creationSessions\/current$/,
]);

export const RECOVERY_ONLY_PROVIDER_POLL_GET_PATTERNS = Object.freeze([
  new RegExp(`^/api/v3/contents/generations/tasks/${SAFE_RESOURCE_SEGMENT}$`),
  new RegExp(`^/api/workbench/canvas/tasks/${SAFE_RESOURCE_SEGMENT}$`),
]);

function normalizedPathname(value: unknown): string {
  const pathname = String(value || "").split("?", 1)[0].replace(/\/+$/, "");
  return pathname || "/";
}

export function recoveryOnlyRequestAllowed(input: {
  method?: unknown;
  path?: unknown;
  body?: unknown;
}): boolean {
  const method = String(input.method || "GET").trim().toUpperCase();
  const requestTarget = String(input.path || "");
  const pathname = normalizedPathname(requestTarget);
  if (method === "OPTIONS") return true;
  let signedCandidateRead = false;
  if (method === "GET" || method === "HEAD" || method === "POST") {
    try {
      resolveCandidateSignedReadContract({
        method,
        requestTarget,
        ...(method === "POST" ? { requestBody: input.body } : {}),
      });
      signedCandidateRead = true;
    } catch {
      signedCandidateRead = false;
    }
  }
  if (method === "GET" || method === "HEAD") {
    const localRead = RECOVERY_ONLY_READ_GET_PATHS.has(pathname)
      || signedCandidateRead
      || RECOVERY_ONLY_READ_GET_PATTERNS.some((pattern) => pattern.test(pathname));
    if (localRead) return true;
    return method === "GET"
      && RECOVERY_ONLY_PROVIDER_POLL_GET_PATTERNS.some(
        (pattern) => pattern.test(pathname),
      );
  }
  return method === "POST" && signedCandidateRead;
}

export function recoveryOnlyFenceMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isRecoveryOnlyMode() && isIsolatedSessionEvidenceMode()) {
    let ticket;
    try {
      ticket = authorizeInstalledIsolatedSessionEvidenceRequest({
        method: req.method,
        target: req.originalUrl || req.url || req.path,
        body: req.body,
      });
    } catch {
      res.status(503).send({
        code: "ISOLATED_SESSION_EVIDENCE_RUNTIME_INVALID",
        message: "隔离会话验证运行时未正确绑定",
      });
      return;
    }
    if (!ticket) {
      res.status(503).send({
        code: "ISOLATED_SESSION_EVIDENCE_REQUEST_BLOCKED",
        message: "隔离会话验证仅允许执行已绑定请求计划",
      });
      return;
    }
    if (ticket.kind === "planned") {
      res.setHeader(
        ISOLATED_SESSION_EVIDENCE_SEQUENCE_HEADER,
        String(ticket.sequence),
      );
    }
    let completed = false;
    res.once("finish", () => {
      if (completed) return;
      completed = true;
      ticket.complete(res.statusCode);
    });
    res.once("close", () => {
      if (completed) return;
      completed = true;
      ticket.abort();
    });
    next();
    return;
  }
  if (isRecoveryOnlyMode()) {
    let recoveryTicket;
    try {
      recoveryTicket = authorizeCandidateESettledImageRecoveryRequest({
        method: req.method,
        target: req.originalUrl || req.url || req.path,
        body: req.body,
        headers: (req.headers || {}) as Record<string, unknown>,
      });
    } catch {
      res.status(503).send({
        code: "RECOVERY_ONLY_CANDIDATE_E_RECOVERY_INVALID",
        message: "Candidate E 已结算图片恢复票据无效或已被消费",
      });
      return;
    }
    if (recoveryTicket) {
      if (recoveryTicket.reconciled) {
        res.status(409).send({
          code: "CANDIDATE_E_IMAGE_RECOVERY_ALREADY_SUCCEEDED",
          message: "Candidate E 已结算图片恢复已成功，只允许离线对账",
        });
        return;
      }
      try {
        recoveryTicket.bind(req);
      } catch {
        res.status(503).send({
          code: "RECOVERY_ONLY_CANDIDATE_E_RECOVERY_INVALID",
          message: "Candidate E 已结算图片恢复能力无法绑定当前请求",
        });
        return;
      }
      req.headers[QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_HEADER] =
        quickCreateImageCheckpointRecoveryAuthorizedValue(
          recoveryTicket.guardDigest,
        );
      let completed = false;
      res.once("finish", () => {
        if (completed) return;
        completed = true;
        recoveryTicket.complete(res.statusCode);
      });
      res.once("close", () => {
        if (completed) return;
        completed = true;
        recoveryTicket.abort();
      });
      next();
      return;
    }
  }
  if (
    !isRecoveryOnlyMode()
    || (
      recoveryOnlyRequestAllowed({
        method: req.method,
        path: req.originalUrl || req.url || req.path,
        ...(String(req.method || "").toUpperCase() === "POST"
          ? { body: req.body }
          : {}),
      })
      && !(
        isCandidateRuntimeReadonlyEvidenceMode()
        && String(req.method || "").toUpperCase() === "GET"
        && RECOVERY_ONLY_PROVIDER_POLL_GET_PATTERNS.some(
          (pattern) => pattern.test(normalizedPathname(req.path)),
        )
      )
    )
  ) {
    next();
    return;
  }
  res.status(503).send({
    code: "RECOVERY_ONLY_MUTATION_BLOCKED",
    message: "恢复候选环境仅允许读取已有证据，不允许创建或重试生成任务",
  });
}
