import { createHash } from "node:crypto";

export const ASSET_RECOMMENDATION_RULE_VERSION = "asset-metadata-literal-v1" as const;

type AuthorizedAssetCandidate = {
  id: number;
  imageId?: number | null;
  name?: string | null;
  type?: string | null;
  describe?: string | null;
  prompt?: string | null;
  startTime?: number | null;
  authority: "owner" | "workspace_owner" | "grant" | "none";
  ownership: {
    ownerType: "user" | "workspace";
    revision: number;
  };
  permissions: { view: boolean; use: boolean; manage: boolean };
  projectReference?: { assetVersionId?: string | null } | null;
};

export type AssetRecommendation = {
  recommendationId: string;
  assetId: number;
  assetVersionId: string;
  name: string;
  type: string;
  score: number;
  reasons: string[];
  source: "account" | "workspace" | "shared";
  alreadyInProject: boolean;
  expectedOwnershipRevision: number;
  ruleVersion: typeof ASSET_RECOMMENDATION_RULE_VERSION;
  billing: { mode: "retrieval_only"; chargeMicros: 0 };
};

function words(value: string): string[] {
  return [...new Set(value
    .toLocaleLowerCase("zh-CN")
    .split(/[\s,，。.!！?？:：;；、/\\|()[\]{}<>《》"'“”‘’_-]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 32))];
}

function sourceOf(candidate: AuthorizedAssetCandidate): AssetRecommendation["source"] {
  if (candidate.authority === "grant") return "shared";
  return candidate.ownership.ownerType === "workspace" ? "workspace" : "account";
}

function versionOf(candidate: AuthorizedAssetCandidate): string {
  const bound = String(candidate.projectReference?.assetVersionId || "").trim();
  if (bound) return bound;
  const imageId = Number(candidate.imageId || 0);
  return Number.isSafeInteger(imageId) && imageId > 0 ? `image:${imageId}` : `asset:${candidate.id}`;
}

/**
 * Deterministic retrieval only. Authorization is a prerequisite supplied by
 * listAssetLibrary; unusable/revoked items are dropped again before ranking.
 * No model call, generation task or billing mutation occurs here.
 */
export function recommendAuthorizedAssets(input: {
  projectId: number;
  query?: string | null;
  context?: string | null;
  limit?: number;
  candidates: AuthorizedAssetCandidate[];
}): AssetRecommendation[] {
  const query = String(input.query || "").trim().slice(0, 500);
  const context = String(input.context || "").trim().slice(0, 120);
  const needles = words(`${query} ${context}`);
  const limit = Math.min(20, Math.max(1, Number(input.limit || 8)));

  return input.candidates
    .filter((candidate) => candidate.permissions.view && candidate.permissions.use)
    .map((candidate) => {
      const name = String(candidate.name || `资产 ${candidate.id}`);
      const type = String(candidate.type || "unknown");
      const fields = {
        name: name.toLocaleLowerCase("zh-CN"),
        type: type.toLocaleLowerCase("zh-CN"),
        describe: String(candidate.describe || "").toLocaleLowerCase("zh-CN"),
        prompt: String(candidate.prompt || "").toLocaleLowerCase("zh-CN"),
      };
      const matches = needles.flatMap((needle) => {
        const hit = Object.entries(fields).find(([, value]) => value.includes(needle));
        return hit ? [{ needle, field: hit[0] }] : [];
      });
      const alreadyInProject = Boolean(candidate.projectReference);
      const score = matches.reduce((sum, match) => sum + (match.field === "name" ? 6 : match.field === "type" ? 4 : 2), 0)
        + (alreadyInProject ? 1 : 0);
      const assetVersionId = versionOf(candidate);
      const reasons = matches.length
        ? matches.slice(0, 3).map((match) => `“${match.needle}”匹配${match.field === "name" ? "名称" : match.field === "type" ? "类型" : match.field === "describe" ? "描述" : "提示信息"}`)
        : [`按${sourceOf(candidate) === "account" ? "账号" : sourceOf(candidate) === "workspace" ? "工作区" : "已授权分享"}资产的更新时间排序`];
      if (alreadyInProject) reasons.push("已绑定当前项目的明确版本");
      const identity = [ASSET_RECOMMENDATION_RULE_VERSION, input.projectId, candidate.id, assetVersionId, query, context].join("|");
      return {
        recommendationId: `asset-rec-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
        assetId: candidate.id,
        assetVersionId,
        name,
        type,
        score,
        reasons,
        source: sourceOf(candidate),
        alreadyInProject,
        expectedOwnershipRevision: Number(candidate.ownership.revision),
        ruleVersion: ASSET_RECOMMENDATION_RULE_VERSION,
        billing: { mode: "retrieval_only" as const, chargeMicros: 0 as const },
        startTime: Number(candidate.startTime || 0),
      };
    })
    .filter((item) => needles.length === 0 || item.score > (item.alreadyInProject ? 1 : 0))
    .sort((left, right) => right.score - left.score || right.startTime - left.startTime || left.assetId - right.assetId)
    .slice(0, limit)
    .map(({ startTime: _startTime, ...item }) => item);
}
