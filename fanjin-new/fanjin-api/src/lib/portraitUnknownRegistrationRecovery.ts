import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { writeAuditLog } from "./audit";
import { portraitScopeCompliance } from "./portraitReviewScope";
import { hasPortraitSubmissionRestriction } from "./portraitSubmissionPolicy";

const ASSET = "o_portrait_provider_asset";
const UNKNOWN = "VOLC_PORTRAIT_OUTCOME_UNKNOWN";
const OBSERVED = "portrait.provider_asset.empty_observed";
export const PORTRAIT_UNKNOWN_GRACE_MS = 30 * 60_000;
export const PORTRAIT_EMPTY_RECHECK_MS = 60_000;
const BACKOFF_MS = 15 * 60_000;
const parse = (value: any): any => { try { return typeof value === "string" ? JSON.parse(value) : value || {}; } catch { return {}; } };
const digest = (value: unknown) => createHash("sha256").update(String(value)).digest("hex");

type Context = { asset: any; group: any; admission: any; channel: any; fingerprint: string };
export type PortraitUnknownLookup = {
  group: { Result: Record<string, any> };
  assets: { Result: Record<string, any> };
};

/** An empty, dedicated group is required; never adopt a same-name portrait,
 * change an account, clear a refusal, or replay the original mutation key.
 */
export function isVerifiedEmptyPortraitGroup(value: PortraitUnknownLookup, groupId: string): boolean {
  const group = value.group?.Result;
  const assets = value.assets?.Result;
  if (group?.Id !== groupId || group?.GroupType !== "AIGC" || !assets) return false;
  const lists = ["Items", "Assets", "AssetInfos", "Data"].filter(key => key in assets);
  const counts = ["TotalCount", "Count"].filter(key => key in assets);
  return lists.length > 0 && counts.length > 0
    && lists.every(key => Array.isArray(assets[key]) && assets[key].length === 0)
    && counts.every(key => Number.isSafeInteger(assets[key]) && assets[key] === 0);
}

async function context(database: Knex | Knex.Transaction, id: string, now: number,
  fingerprint: (channel: any) => string, lock = false): Promise<Context | null> {
  const query = database(ASSET).where({ id });
  const asset = await query.first();
  if (!asset || asset.state !== "failed" || asset.safeErrorCode !== UNKNOWN || asset.providerAssetId
    || asset.idempotencyKey.startsWith("portrait-recovered-")
    || Number(asset.createdAt) > now - PORTRAIT_UNKNOWN_GRACE_MS) return null;
  const attempt = await database("o_agent_idempotency").where({ workspaceId: asset.workspaceId,
    idempotencyKey: asset.idempotencyKey, resourceType: "volc_portrait_action:CreateAsset" })
    .whereIn("status", ["volc_portrait_outcome_unknown", "volc_portrait_in_progress"]).first();
  if (!attempt || Number(attempt.updatedAt) > now - PORTRAIT_UNKNOWN_GRACE_MS) return null;
  const admissionQuery = database("o_portrait_admission").where({ id: asset.admissionId, workspaceId: asset.workspaceId });
  if (lock) admissionQuery.forUpdate();
  const admission = await admissionQuery.first();
  if (!admission || admission.sourceSha256 !== asset.sourceSha256 || admission.sourceRecoveryState !== "ready"
    || !["virtual_person", "trusted_output", "detected_person"].includes(admission.subjectKind)) return null;
  const identityQuery = database("o_portrait_identity").where({ id: admission.identityId, workspaceId: asset.workspaceId });
  if (lock) identityQuery.forUpdate();
  const identity = await identityQuery.first();
  const consent = admission.currentConsentId
    ? await database("o_portrait_consent").where({ id: admission.currentConsentId, workspaceId: asset.workspaceId,
      admissionId: admission.id, identityId: identity?.id || "" }).first() : null;
  const effective = { ...admission, identityState: identity?.state, consentStatus: consent?.status, consentExpiresAt: consent?.expiresAt };
  if (!identity || identity.state !== "active" || identity.kind !== admission.subjectKind
    || portraitScopeCompliance(effective) !== "allowed" || hasPortraitSubmissionRestriction(effective, now)) return null;
  if (admission.subjectKind === "detected_person") {
    if (admission.declarationState !== "not_required" || admission.currentConsentId) return null;
  } else if (admission.declarationState !== "confirmed" || !consent || consent.status !== "active"
    || identity.activeConsentId !== consent.id
    || consent.consentType !== (admission.subjectKind === "trusted_output" ? "trusted_output_attestation" : "virtual_person_rights")) return null;
  const groupQuery = database("o_portrait_provider_group").where({ id: asset.groupBindingId,
    workspaceId: asset.workspaceId, channelId: asset.channelId, identityId: identity.id, state: "active", groupType: "AIGC" });
  if (lock) groupQuery.forUpdate();
  const group = await groupQuery.first();
  if (!group?.providerGroupId) return null;
  const siblings = await database(ASSET).where({ groupBindingId: group.id }).count({ count: "*" }).first();
  if (Number(siblings?.count) !== 1) return null;
  const channelQuery = database("o_provider_channel").where({ id: asset.channelId, disabled: 0,
    provider: "volcano", endpointType: "video_generation" });
  if (lock) channelQuery.forUpdate();
  const channel = await channelQuery.first();
  if (!channel || !((channel.scope === "platform" && channel.workspaceId == null)
    || (channel.scope === "workspace" && channel.workspaceId === asset.workspaceId))) return null;
  const currentFingerprint = fingerprint(channel);
  if (currentFingerprint !== group.providerAccountFingerprint) return null;
  if (lock) {
    const locked = await database(ASSET).where({ id, state: "failed", idempotencyKey: asset.idempotencyKey,
      safeErrorCode: UNKNOWN, sourceSha256: asset.sourceSha256, groupBindingId: group.id })
      .whereNull("providerAssetId").forUpdate().first();
    if (!locked) return null;
    Object.assign(asset, locked);
  }
  return { asset, group, admission: { ...admission, ownerUserId: identity.ownerUserId }, channel, fingerprint: currentFingerprint };
}

export async function recoverUnknownPortraitRegistrations(input: {
  database: Knex;
  now?: () => number;
  fingerprint: (channel: any) => string;
  lookup: (context: Context) => Promise<PortraitUnknownLookup>;
}): Promise<number> {
  const database = input.database, clock = input.now || Date.now;
  const due = clock();
  const candidates = await database(ASSET).where({ state: "failed", safeErrorCode: UNKNOWN })
    .whereNull("providerAssetId").whereNot("idempotencyKey", "like", "portrait-recovered-%")
    .where("createdAt", "<=", due - PORTRAIT_UNKNOWN_GRACE_MS).where("nextAttemptAt", "<=", due)
    .where(q => q.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<", due))
    .orderBy("nextAttemptAt", "asc").limit(4).select("id");
  let recovered = 0;
  for (const candidate of candidates) {
    const owner = `portrait-recovery-${randomUUID()}`;
    try {
      const before = await context(database, candidate.id, clock(), input.fingerprint);
      if (!before) continue;
      const claimed = await database(ASSET).where({ id: candidate.id, state: "failed", idempotencyKey: before.asset.idempotencyKey })
        .where(q => q.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<", clock()))
        .update({ leaseOwner: owner, leaseExpiresAt: clock() + 120_000 });
      if (Number(claimed) !== 1) continue;
      const observed = await input.lookup(before);
      if (!isVerifiedEmptyPortraitGroup(observed, before.group.providerGroupId)) continue;
      await database.transaction(async trx => {
        const at = clock();
        const current = await context(trx, candidate.id, at, input.fingerprint, true);
        if (!current || current.asset.leaseOwner !== owner || Number(current.asset.leaseExpiresAt) <= at
          || current.asset.idempotencyKey !== before.asset.idempotencyKey
          || current.group.providerGroupId !== before.group.providerGroupId || current.fingerprint !== before.fingerprint
          || current.admission.identityId !== before.admission.identityId
          || current.admission.currentConsentId !== before.admission.currentConsentId) return;
        const oldKeyHash = digest(current.asset.idempotencyKey);
        const receipt = await trx("o_audit_log").where({ workspaceId: current.asset.workspaceId,
          resourceId: candidate.id, action: OBSERVED }).orderBy("createdAt", "desc").first();
        const prior = parse(receipt?.metadata);
        const sameObservation = prior.oldKeyHash === oldKeyHash && prior.accountFingerprint === current.fingerprint
          && prior.groupId === current.group.providerGroupId && prior.sourceSha256 === current.asset.sourceSha256
          && Number.isSafeInteger(prior.observedAt) && prior.observedAt >= at - BACKOFF_MS;
        if (sameObservation && at - prior.observedAt < PORTRAIT_EMPTY_RECHECK_MS) return;
        const audit = { oldKeyHash, accountFingerprint: current.fingerprint, groupId: current.group.providerGroupId,
          sourceSha256: current.asset.sourceSha256, observedAt: at, totalCount: 0,
          priorBindingCreatedAt: Number(current.asset.createdAt),
          firstObservedAt: sameObservation ? prior.observedAt : at, oldMutationPreserved: true };
        const requeue = sameObservation && at - prior.observedAt >= PORTRAIT_EMPTY_RECHECK_MS;
        await writeAuditLog({ workspaceId: current.asset.workspaceId, actor: { actorKind: "system" } }, {
          workspaceId: current.asset.workspaceId, action: requeue ? "portrait.provider_asset.requeued_after_verified_absence" : OBSERVED,
          resourceType: "portrait_provider_asset", resourceId: candidate.id, metadata: audit, required: true,
        }, trx);
        if (!requeue) {
          await trx(ASSET).where({ id: candidate.id, leaseOwner: owner }).update({
            nextAttemptAt: at + PORTRAIT_EMPTY_RECHECK_MS, leaseOwner: null, leaseExpiresAt: null,
            safeErrorMessage: "平台正在自动核对原登记记录，无需重复声明", updatedAt: at,
          });
          return;
        }
        // Keep the original durable unknown receipt. A single new operation is
        // allowed only after two scoped, complete empty reads of the same group.
        await trx(ASSET).where({ id: candidate.id, leaseOwner: owner }).update({
          state: "queued", idempotencyKey: `portrait-recovered-${candidate.id}`, retryCount: 0,
          nextAttemptAt: at, leaseOwner: null, leaseExpiresAt: null, safeErrorCode: null, safeErrorMessage: null,
          createdAt: at, updatedAt: at,
        });
        if (current.admission.preferredProviderChannelId === current.asset.channelId
          && current.admission.providerSyncState !== "active") {
          await trx("o_portrait_admission").where({ id: current.admission.id }).update({
            providerSyncState: "queued", safeErrorCode: null, safeErrorMessage: null,
            revision: Number(current.admission.revision) + 1, updatedAt: at,
          });
        }
        recovered++;
      });
    } catch {
      // Network errors and unverified list responses are never absence proof.
    } finally {
      await database(ASSET).where({ id: candidate.id, leaseOwner: owner }).update({
        leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: clock() + BACKOFF_MS,
      });
    }
  }
  return recovered;
}
