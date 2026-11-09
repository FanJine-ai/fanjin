import express from "express";

import { writeAuditLog } from "@/lib/audit";
import { portraitRelayGuidance } from "@/lib/portraitAccessGuidance";
import {
  PORTRAIT_ASSET_RELAY_VERSION,
  PortraitAssetRelayContractError,
  isPortraitAssetRelayAction,
  portraitAssetRelayPermission,
  portraitAssetRelayReadActions,
} from "@/lib/portraitAssetRelayContract";
import {
  executePortraitAssetRelayAction,
  PortraitAssetRelayError,
} from "@/lib/portraitAssetRelayService";
import { hasRelayApiKeyPermission } from "@/lib/relayApiKeyPermissions";
import { VolcenginePortraitAssetsError } from "@/lib/volcenginePortraitAssets";
import { VolcenginePortraitIdempotencyStoreError } from "@/lib/volcenginePortraitIdempotencyStore";
import { apiKeyAuth, type RelayApiKeyContext } from "@/middleware/apiKeyAuth";

const router = express.Router();

function queryValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeProviderStatus(error: VolcenginePortraitAssetsError): number {
  if (error.code.includes("IDEMPOTENCY") || error.code.includes("OUTCOME_UNKNOWN")) return 409;
  if (error.code.includes("SCOPE_MISMATCH")) return 403;
  if (error.httpStatus && error.httpStatus >= 400 && error.httpStatus <= 599) {
    return error.httpStatus;
  }
  if (error.dispatchState === "not_dispatched") return 400;
  return 502;
}

router.post("/", apiKeyAuth({ reserveRequestQuota: true }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const requestId = String((req as any).requestId || res.getHeader("X-Request-Id") || "").trim();
  if (requestId) res.setHeader("X-Fanjin-Request-Id", requestId);
  const action = queryValue(req.query.Action);
  const version = queryValue(req.query.Version);
  if (!isPortraitAssetRelayAction(action)) {
    return res.status(400).send({ code: "portrait_asset_action_invalid", message: "不支持的人像资产 Action" });
  }
  if (version !== PORTRAIT_ASSET_RELAY_VERSION) {
    return res.status(400).send({
      code: "portrait_asset_version_invalid",
      message: `Version 必须为 ${PORTRAIT_ASSET_RELAY_VERSION}`,
    });
  }
  const apiKey = (req as any).apiKey as RelayApiKeyContext | undefined;
  const permission = portraitAssetRelayPermission(action);
  if (!apiKey || !hasRelayApiKeyPermission(apiKey.permissions, permission)) {
    return res.status(403).send({
      code: "portrait_asset_permission_denied",
      message: `API Key 缺少独立人像中转权限 ${permission}。正常 MCP / CLI 素材审核请使用 fanjin_asset_get，无需为此接口追加权限。`,
      requiredPermission: permission,
      guidance: portraitRelayGuidance,
    });
  }
  const workspaceId = String(apiKey.workspaceId || "").trim();
  const requestedWorkspaceId = String(req.header("x-fanjin-workspace-id") || "").trim();
  if (!workspaceId || (requestedWorkspaceId && requestedWorkspaceId !== workspaceId)) {
    return res.status(403).send({
      code: "portrait_asset_workspace_forbidden",
      message: "API Key 不能选择或访问其他工作区",
    });
  }
  const mutates = !(portraitAssetRelayReadActions as readonly string[]).includes(action);

  try {
    // Persist authorization intent before a provider mutation. A required
    // outcome audit after dispatch could hide a successful one-time liveness
    // response and make the result impossible to replay safely.
    if (mutates) {
      await writeAuditLog({
        workspaceId,
        actor: { actorKind: "api_key", actorUserId: apiKey.ownerUserId },
      }, {
        action: `portrait_asset_relay.${action}.requested`,
        resourceType: "portrait_asset_relay",
        resourceId: requestId || null,
        metadata: { action, apiKeyId: apiKey.id, version },
        required: true,
      });
    }
    const result = await executePortraitAssetRelayAction({
      action,
      actorUserId: apiKey.ownerUserId,
      body: req.body ?? {},
      consentConfirmed: req.header("x-fanjin-portrait-consent") === "confirmed",
      idempotencyKey: req.header("idempotency-key"),
      workspaceId,
    });
    if (mutates) {
      await writeAuditLog({
        workspaceId,
        actor: { actorKind: "api_key", actorUserId: apiKey.ownerUserId },
      }, {
        action: `portrait_asset_relay.${action}.completed`,
        resourceType: "portrait_asset_relay",
        resourceId: requestId || null,
        metadata: {
          action,
          apiKeyId: apiKey.id,
          version,
        },
        required: false,
      });
    }
    return res.status(200).send(result);
  } catch (error) {
    if (error instanceof PortraitAssetRelayContractError) {
      return res.status(error.status).send({ code: error.code, message: error.message, errors: error.issues });
    }
    if (error instanceof PortraitAssetRelayError) {
      return res.status(error.status).send({ code: error.code, message: error.message, guidance: portraitRelayGuidance });
    }
    if (error instanceof VolcenginePortraitAssetsError) {
      return res.status(safeProviderStatus(error)).send({ code: error.code, message: error.message });
    }
    if (error instanceof VolcenginePortraitIdempotencyStoreError) {
      const status = error.code.includes("CONFLICT") || error.code.includes("LEASE") ? 409 : 503;
      return res.status(status).send({ code: error.code, message: error.message });
    }
    if (error instanceof Error && error.message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send({
        code: "portrait_asset_audit_unavailable",
        message: "安全审计暂不可用，人像资产操作未发起",
      });
    }
    console.error("[portrait-asset-relay] request failed", error instanceof Error ? error.name : "UnknownError");
    return res.status(500).send({ code: "portrait_asset_internal_error", message: "人像资产中转请求处理失败" });
  }
});

export default router;
