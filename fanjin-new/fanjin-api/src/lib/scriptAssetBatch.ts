import type { Knex } from "knex";
import { buildStoredScriptAssetProposal, parseStoredScriptAssetProposal, ScriptAssetExtractionError,
  type ScriptAssetProposalItem, type ScriptAssetSnapshot, type StoredScriptAssetProposal } from "./scriptAssetExtraction";

export const MAX_MERGED_SCRIPT_ASSETS = 5_000;
export const MAX_EXTRACTION_BATCHES = 200;

/** Deterministically combine paid proposals; this operation never calls a model. */
export function mergeScriptAssetProposals(proposalId: string, projectId: number, proposals: StoredScriptAssetProposal[]) {
  const scripts = new Map<number, ScriptAssetSnapshot>();
  const assets: ScriptAssetProposalItem[] = [];
  const byIdentity = new Map<string, ScriptAssetProposalItem>();
  const canonical = (value: string) => value.trim().toLocaleLowerCase("zh-CN");
  for (const proposal of proposals) {
    for (const snapshot of proposal.scriptSnapshots) {
      const prior = scripts.get(snapshot.id);
      if (prior && (prior.contentHash !== snapshot.contentHash || prior.name !== snapshot.name)) {
        throw new ScriptAssetExtractionError(409, "script_asset_proposal_stale", "不同批次中的剧本版本不一致，请核对已修改的剧本");
      }
      scripts.set(snapshot.id, snapshot);
    }
    const localIds = new Map<string, string>();
    const ordered = [...proposal.assets.filter((asset) => !asset.parentClientId), ...proposal.assets.filter((asset) => asset.parentClientId)];
    for (const asset of ordered) {
      const parentId = asset.parentClientId ? localIds.get(asset.parentClientId) : null;
      if (asset.parentClientId && !parentId) throw new ScriptAssetExtractionError(409, "script_asset_proposal_invalid", "批次资产缺少有效的基础资产");
      const key = JSON.stringify([asset.type, canonical(asset.name), parentId, canonical(asset.stateLabel || "")]);
      let merged = byIdentity.get(key);
      if (!merged) {
        merged = { ...asset, clientId: `batch-asset-${assets.length + 1}`, parentClientId: parentId || null, scriptIds: [] };
        assets.push(merged);
        byIdentity.set(key, merged);
      }
      // Keep the first non-empty description instead of mixing contradictory
      // character/state descriptions; the user can edit the final proposal.
      if (!merged.describe) merged.describe = asset.describe;
      if (!merged.prompt) merged.prompt = asset.prompt;
      merged.scriptIds = [...new Set([...merged.scriptIds, ...(asset.scriptIds.length ? asset.scriptIds : proposal.scriptIds)])].sort((a, b) => a - b);
      localIds.set(asset.clientId, merged.clientId);
    }
  }
  if (assets.length > MAX_MERGED_SCRIPT_ASSETS) throw new ScriptAssetExtractionError(413, "script_asset_merge_too_large", "汇总资产超过 5000 项，请按分集范围分别审核");
  return buildStoredScriptAssetProposal({
    proposalId, projectId, claimEpoch: 0,
    model: [...new Set(proposals.map((proposal) => proposal.model))].join(","),
    scripts: [...scripts.values()].sort((a, b) => a.id - b.id), assets,
  });
}

export async function loadScriptAssetBatchProposals(database: Knex | Knex.Transaction, workspaceId: string, projectId: number, ids: string[]) {
  const rows = await database("o_agent_idempotency").where({ workspaceId, resourceType: "project", resourceId: String(projectId), status: "completed" })
    .where("scopeKey", "like", `script:asset-extraction:proposal:${workspaceId}:%`).whereIn("id", ids).select("id", "responseBody");
  if (rows.length !== ids.length) throw new ScriptAssetExtractionError(404, "script_asset_proposal_not_found", "部分批次提案尚未完成、已失效或不属于当前项目");
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids.map((id) => {
    const proposal = parseStoredScriptAssetProposal(JSON.parse(String(byId.get(id)!.responseBody)));
    if (proposal.projectId !== projectId || proposal.proposalId !== id) throw new ScriptAssetExtractionError(409, "script_asset_proposal_invalid", "批次提案与项目不匹配");
    return proposal;
  });
}
