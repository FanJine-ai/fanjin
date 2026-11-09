import { z } from "zod";
import u from "@/utils";
import { defineAgentTool } from "@/agent-runtime/tools/registry";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import { resolveObjectStorageConfiguration } from "@/lib/objectStorageConfig";

/**
 * 交付预览工具（AGENTKIT-ADOPTION-CHECKLIST P3 3.2）。
 *
 * R0 只读:输入项目内资产版本,返回限时签名预览链接。签名 TTL 跟随对象
 * 存储配置(remote 供应商签名 URL 本地配置 TTL;本地存储返回站内 URL)。
 * 对外分享仍走未来 delivery.share(R3 两阶段确认),本工具不扩大分享范围。
 */

export const deliveryPreviewInputSchema = z.object({
  assetVersionId: z.number().int().positive(),
}).strict();

export type DeliveryPreviewInput = z.infer<typeof deliveryPreviewInputSchema>;

export const deliveryPreviewOutputSchema = z.object({
  assetVersionId: z.number().int().positive(),
  assetId: z.number().int().positive(),
  assetType: z.string().min(1).nullable(),
  previewUrl: z.string().min(1),
  /** 供应商签名 URL 的过期时间(毫秒);本地存储/原始 URL 无过期时为 null。 */
  expiresAt: z.number().int().positive().nullable(),
  storage: z.enum(["signed-remote", "local", "external-url"]),
}).strict();

export type DeliveryPreviewOutput = z.infer<typeof deliveryPreviewOutputSchema>;

function remoteSignedUrlTtlMs(): number | null {
  const configuration = resolveObjectStorageConfiguration();
  if (configuration.provider === "local") return null;
  const ttlSeconds = Number((configuration as { signedUrlTtlSeconds?: unknown }).signedUrlTtlSeconds);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) return null;
  return ttlSeconds * 1000;
}

export const DELIVERY_PREVIEW_TOOL = defineAgentTool({
  manifest: {
    name: "delivery.preview",
    version: "1.0.0",
    displayName: "获取交付预览链接",
    description: "返回当前项目内指定资产版本的限时预览链接(只读)。"
      + "正例:成片入库后向用户展示可播放预览;"
      + "负例:不要用它对外分享(分享需 delivery.share 审批);只接受当前项目的资产版本 ID。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A4" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["asset", "media_asset"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: deliveryPreviewInputSchema,
  outputSchema: deliveryPreviewOutputSchema,
  async execute(input, context): Promise<DeliveryPreviewOutput> {
    const rows = await context.database("o_image as asset_version")
      .innerJoin("o_assets as asset", "asset.id", "asset_version.assetsId")
      .where({
        "asset.projectId": context.projectId,
        "asset_version.id": input.assetVersionId,
      })
      .select({
        filePath: "asset_version.filePath",
        assetType: "asset_version.type",
        assetId: "asset.id",
      })
      .first();
    if (!rows || !String(rows.filePath || "")) {
      throw new AgentToolGatewayError(
        "delivery_preview_asset_not_found",
        "资产版本不存在或不属于当前项目",
        { status: 404 },
      );
    }
    const filePath = String(rows.filePath);
    if (/^https?:\/\//i.test(filePath)) {
      return {
        assetVersionId: input.assetVersionId,
        assetId: Number(rows.assetId),
        assetType: rows.assetType ? String(rows.assetType) : null,
        previewUrl: filePath,
        expiresAt: null,
        storage: "external-url",
      };
    }
    const previewUrl = await u.oss.getFileUrl(filePath);
    const ttlMs = remoteSignedUrlTtlMs();
    return {
      assetVersionId: input.assetVersionId,
      assetId: Number(rows.assetId),
      assetType: rows.assetType ? String(rows.assetType) : null,
      previewUrl,
      expiresAt: ttlMs != null ? context.now + ttlMs : null,
      storage: ttlMs != null ? "signed-remote" : "local",
    };
  },
});
