import {
  ApiError,
  apiDelete,
  apiPost,
  readApiSettings,
  type ApiRequestOptions,
  type ApiSettings,
} from "./http";

export const stepUpScopes = [
  "account.security.update",
  "account.profile.sensitive",
  "account.oauth.unbind",
  "admin.user.create",
  "admin.user.profile",
  "admin.user.status",
  "admin.user.role",
  "admin.user.commercial",
  "admin.user.attribution",
  "admin.tenant_domain",
  "admin.tenant_certificate",
  "admin.tenant_ingress",
  "admin.tenant_reconciliation",
  "admin.billing.plan",
  "admin.billing.service_request",
  "admin.billing.reconciliation",
  "admin.finance.case",
  "admin.finance.gift_grant",
  "admin.finance.adjustment",
  "admin.model_route",
  "admin.portrait_asset_relay",
  "admin.portrait_review",
  "admin.pricing_rule",
  "admin.provider_channel",
  "admin.media_service",
  "admin.redemption",
  "admin.relay_task",
  "admin.release",
  "admin.deployment",
  "admin.backup.manage",
  "admin.backup.delete",
  "admin.backup.restore",
  "admin.request_log.export",
  "admin.request_log.purge",
  "admin.agent_runtime_config",
  "admin.system_settings",
  "admin.video_fulfillment",
  "api_key.create",
  "api_key.update",
  "api_key.rotate",
  "api_key.revoke",
  "workspace.member.manage",
  "workspace.owner.transfer",
  "legacy.vendor_config.manage",
  "legacy.agent_config.manage",
  "legacy.model_config.manage",
  "legacy.content_config.manage",
  "legacy.developer_config.manage",
  "legacy.memory_config.manage",
  "legacy.database.destructive",
] as const;

export type StepUpScope = (typeof stepUpScopes)[number];

export type StepUpPrompt = {
  scopes: StepUpScope[];
  reason?: string;
};

type StepUpProofConsumer = (proof: string, scope: StepUpScope, index: number) => Promise<void>;
type StepUpPresenter = (prompt: StepUpPrompt, consume: StepUpProofConsumer) => Promise<void>;

type SessionStepUpResult = {
  proofs: Array<{
    proof: string;
    scope: StepUpScope;
    expiresAt: number;
    method: "password" | "totp" | "recovery";
  }>;
};

let presenter: StepUpPresenter | null = null;

export class StepUpCancelledError extends Error {
  constructor() {
    super("已取消管理员身份验证");
    this.name = "StepUpCancelledError";
  }
}

export function registerStepUpPresenter(next: StepUpPresenter) {
  presenter = next;
  return () => {
    if (presenter === next) presenter = null;
  };
}

function presentStepUp(scopes: StepUpScope[], consume: StepUpProofConsumer, reason?: string): Promise<void> {
  if (!scopes.length) return Promise.resolve();
  if (!presenter) return Promise.reject(new Error("身份验证界面尚未就绪，请稍后重试"));
  return presenter({ scopes, reason }, consume);
}

function withProof(options: ApiRequestOptions | undefined, proof: string): ApiRequestOptions {
  return {
    ...options,
    headers: {
      ...(options?.headers || {}),
      "X-Fanjin-Step-Up": proof,
    },
  };
}

export async function apiPostWithStepUp<
  TResponse,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
>(
  path: string,
  payload: TPayload,
  scope: StepUpScope,
  reason?: string,
  settings?: ApiSettings,
  options?: ApiRequestOptions,
): Promise<TResponse> {
  const [result] = await withStepUpProofs(
    [scope],
    // Resolve the current session only when the proof is consumed. A step-up
    // dialog may stay open while auth hydration or another-tab login repairs
    // the stored token; capturing settings before the dialog would reuse an
    // empty/stale Authorization value for the final privileged write.
    (proof) => apiPost<TResponse, TPayload>(
      path,
      payload,
      settings ?? readApiSettings(),
      withProof(options, proof),
    ),
    reason,
  );
  return result;
}

export async function apiDeleteWithStepUp<TResponse>(
  path: string,
  scope: StepUpScope,
  reason?: string,
  settings?: ApiSettings,
  options?: ApiRequestOptions,
): Promise<TResponse> {
  const [result] = await withStepUpProofs(
    [scope],
    (proof) => apiDelete<TResponse>(
      path,
      settings ?? readApiSettings(),
      withProof(options, proof),
    ),
    reason,
  );
  return result;
}

export async function withStepUpProofs<T>(
  scopes: StepUpScope[],
  action: (proof: string, index: number, scope: StepUpScope) => Promise<T>,
  reason?: string,
): Promise<T[]> {
  const results: T[] = [];
  let sessionProofs: SessionStepUpResult | null = null;
  try {
    sessionProofs = await apiPost<SessionStepUpResult>(
      "/account/security/step-up/session",
      { scopes },
    );
  } catch (error) {
    const interactiveFallback = error instanceof ApiError && (
      error.status === 404
      || [
        "STEP_UP_SESSION_ASSURANCE_REQUIRED",
        "STEP_UP_SESSION_REUSE_FORBIDDEN",
      ].includes(String(error.code || ""))
    );
    if (!interactiveFallback) {
      throw error;
    }
  }
  if (sessionProofs) {
    if (!Array.isArray(sessionProofs.proofs) || sessionProofs.proofs.length !== scopes.length) {
      throw new Error("服务端未返回完整的登录会话授权凭据");
    }
    for (let index = 0; index < scopes.length; index += 1) {
      const expectedScope = scopes[index];
      const issued = sessionProofs.proofs[index];
      if (!issued?.proof || issued.scope !== expectedScope) {
        throw new Error("登录会话授权凭据与操作顺序不匹配");
      }
      results[index] = await action(issued.proof, index, expectedScope);
    }
    return results;
  }
  await presentStepUp(
    scopes,
    async (proof, scope, index) => {
      results[index] = await action(proof, index, scope);
    },
    reason,
  );
  return results;
}

export function stepUpRequestOptions(proof: string, options?: ApiRequestOptions): ApiRequestOptions {
  return withProof(options, proof);
}
