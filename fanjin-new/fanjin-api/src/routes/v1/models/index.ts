import { publicModelId, modelAllowlistIncludes } from "@/lib/minimaxH3PublicIdentity";
// OpenAI-compatible model discovery.
// Only exposes models that have an enabled route/channel in the caller's
// workspace and that the current API key is permitted to invoke.
import express from "express";
import { db } from "@/utils/db";
import { apiKeyAuth, type RelayApiKeyContext } from "@/middleware/apiKeyAuth";
import { hasRelayApiKeyPermission } from "@/lib/relayApiKeyPermissions";
import { resolveRelayWorkspaceId } from "@/lib/relayUtils";

const router = express.Router();

interface PublicModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

function applyScope(query: any, workspaceId: string) {
  query.andWhere((builder: any) => {
    builder.where({ scope: "platform" }).orWhere({ scope: "workspace", workspaceId });
  });
  return query;
}

function parseModelNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function endpointPermission(
  endpointType: string,
): RelayApiKeyContext["permissions"][number] | null {
  if (endpointType === "image_generation") return "relay:image_generation";
  // video_upscale is internal fulfillment only — not a sellable developer relay product.
  if (endpointType === "video_generation") return "relay:video_generation";
  if (endpointType === "video_upscale") return null;
  if (["text", "embedding", "multimodal_embedding", "tts", "rerank", "transcription"].includes(endpointType)) {
    return "relay:text";
  }
  return null;
}

function canUseEndpoint(apiKey: RelayApiKeyContext | undefined, endpointType: string): boolean {
  const permission = endpointPermission(endpointType);
  if (!permission) return false;
  return (
    !apiKey
    || hasRelayApiKeyPermission(apiKey.permissions, permission)
  );
}

function canUseModel(apiKey: RelayApiKeyContext | undefined, model: string): boolean {
  return !apiKey || apiKey.modelAllowlist.length === 0 || modelAllowlistIncludes(apiKey.modelAllowlist, model);
}

function publicModel(model: string, createdAt: unknown): PublicModel {
  const milliseconds = Number(createdAt || 0);
  return {
    id: publicModelId(model),
    object: "model",
    created: Number.isFinite(milliseconds) && milliseconds > 0 ? Math.floor(milliseconds / 1000) : 0,
    owned_by: "fanjin",
  };
}

async function listAvailableModels(req: express.Request, workspaceId: string): Promise<PublicModel[]> {
  const apiKey = (req as any).apiKey as RelayApiKeyContext | undefined;
  const [routes, channels] = await Promise.all([
    applyScope(db("o_model_route").where({ disabled: 0 }), workspaceId),
    applyScope(db("o_provider_channel").where({ disabled: 0 }), workspaceId),
  ]);
  const channelById = new Map<string, any>((channels as any[]).map((channel) => [String(channel.id), channel]));
  const models = new Map<string, PublicModel>();

  const add = (model: unknown, endpointType: unknown, createdAt: unknown) => {
    const id = String(model || "").trim();
    const type = String(endpointType || "");
    if (!id || !canUseEndpoint(apiKey, type) || !canUseModel(apiKey, id)) return;
    const next = publicModel(id, createdAt);
    const current = models.get(next.id);
    if (!current || (next.created > 0 && (current.created === 0 || next.created < current.created))) models.set(next.id, next);
  };

  for (const route of routes as any[]) {
    const matchingChannel = route.channelId
      ? channelById.get(String(route.channelId))
      : (channels as any[]).find((channel) =>
          channel.endpointType === route.endpointType && (!route.provider || channel.provider === route.provider),
        );
    if (!matchingChannel || matchingChannel.endpointType !== route.endpointType) continue;
    add(route.model, route.endpointType, route.createTime);
  }

  // A channel can also explicitly advertise directly routable models without
  // an alias row in o_model_route. This mirrors the generic-channel fallback
  // used by the relay selector while never inventing arbitrary model names.
  for (const channel of channels as any[]) {
    for (const model of parseModelNames(channel.modelNames)) {
      add(model, channel.endpointType, channel.createTime);
    }
  }

  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function sendError(res: express.Response, status: number, message: string, code?: string) {
  return res.status(status).send({
    error: {
      message,
      type: status === 404 ? "invalid_request_error" : "authentication_error",
      ...(code ? { code } : {}),
    },
  });
}

const authenticate = apiKeyAuth({ optional: true });

router.get("/", authenticate, async (req, res) => {
  const workspaceId = resolveRelayWorkspaceId(req);
  if (!workspaceId) return sendError(res, 403, "缺少工作区上下文");
  const data = await listAvailableModels(req, workspaceId);
  return res.status(200).send({ object: "list", data });
});

// Name the parameter `model` so apiKeyAuth applies the same model allowlist
// check used by generation endpoints before the lookup runs.
router.get("/:model", authenticate, async (req, res) => {
  const workspaceId = resolveRelayWorkspaceId(req);
  if (!workspaceId) return sendError(res, 403, "缺少工作区上下文");
  const models = await listAvailableModels(req, workspaceId);
  const model = models.find((item) => item.id === publicModelId(String(req.params.model)));
  if (!model) return sendError(res, 404, `The model '${req.params.model}' does not exist or you do not have access to it.`, "model_not_found");
  return res.status(200).send(model);
});

export default router;
