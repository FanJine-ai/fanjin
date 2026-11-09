import { hasUpstreamRealPersonRejection, UPSTREAM_REAL_PERSON_REJECTION } from "@/lib/portraitUpstreamRejection";
import { portraitScopeCompliance, wherePortraitScopeEligible } from "@/lib/portraitReviewScope";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { inspectProviderChannelPortraitCredential } from "@/lib/providerChannelCredentials";
import { PORTRAIT_ADMISSION_TABLE, PORTRAIT_IDENTITY_TABLE } from "@/lib/migrations/portraitAssetAdmission";
import { logger } from "@/lib/logger";
import { isPortraitProviderRefusal } from "@/lib/portraitSubmissionPolicy";

// Routing is a product policy, not an assertion about a person's identity or
// an end user's consent. Keep it separate from real/virtual declarations.
export const AUTOMATIC_PORTRAIT_SUBJECT = "detected_person";

export function isAutomaticPortrait(row: Record<string, any>): boolean {
  return row.subjectKind === AUTOMATIC_PORTRAIT_SUBJECT
    && row.declarationState === "not_required";
}

export async function prepareAutomaticPortraitRegistrations(database: Knex, now: number): Promise<number> {
  const rows = await database(PORTRAIT_ADMISSION_TABLE)
    .where((routing) => routing.whereIn("faceScanState", ["single_face", "multiple_faces"])
      .orWhere({ subjectKind: AUTOMATIC_PORTRAIT_SUBJECT, declarationState: "not_required" }))
    .whereIn("subjectKind", ["pending", "multiple_faces", AUTOMATIC_PORTRAIT_SUBJECT])
    .whereNull("identityId")
    .modify(wherePortraitScopeEligible)
    .where(query => query.whereNull("safeErrorCode").orWhere(allowed => allowed
      .whereNotIn("safeErrorCode", [UPSTREAM_REAL_PERSON_REJECTION, "CONTENT_REJECTED", "CONTENT_REVIEW_REJECTED", "VOLC_PORTRAIT_ASSET_REJECTED"])
      .whereRaw("UPPER(??) NOT LIKE ?", ["safeErrorCode", "INPUTIMAGESENSITIVECONTENTDETECTED%"])
      .whereRaw("UPPER(??) NOT LIKE ?", ["safeErrorCode", "INPUTVIDEOSENSITIVECONTENTDETECTED%"])))
    .orderBy("updatedAt", "asc").orderBy("id", "asc").limit(8).select("id", "revision");
  let prepared = 0;
  for (const candidate of rows) {
    try { await database.transaction(async (trx) => {
      const row = await trx(PORTRAIT_ADMISSION_TABLE).where({ id: candidate.id }).forUpdate().first();
      if (!row || row.identityId || hasUpstreamRealPersonRejection(row) || isPortraitProviderRefusal(row.safeErrorCode)
        || ["denied", "revoked", "expired"].includes(portraitScopeCompliance(row))) return;
      const channels = await trx("o_provider_channel")
        .where({ provider: "volcano", endpointType: "video_generation", disabled: 0 })
        .where((scope) => scope
          .where({ scope: "workspace", workspaceId: row.workspaceId })
          .orWhere((platform) => platform.where("scope", "platform").whereNull("workspaceId")))
        .orderByRaw("CASE WHEN scope = 'workspace' THEN 0 ELSE 1 END")
        .orderBy("id", "asc").select("id", "configJson");
      const channel = channels.find((value) => {
        const credential = inspectProviderChannelPortraitCredential(String(value.id), value.configJson);
        return credential.enabled && credential.configured;
      });
      if (!channel) {
        await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
          subjectKind: AUTOMATIC_PORTRAIT_SUBJECT, declarationState: "not_required",
          providerSyncState: "failed", safeErrorCode: "PORTRAIT_CHANNEL_UNAVAILABLE",
          safeErrorMessage: "人物素材登记通道未配置，配置恢复后将自动继续",
          revision: Number(row.revision) + 1, updatedAt: now,
        });
        return;
      }
      const project = await trx("o_project").where({ id: row.projectId }).first("userId");
      if (!project || !Number.isSafeInteger(Number(project.userId)) || Number(project.userId) <= 0) {
        throw new Error("portrait_project_owner_unavailable");
      }
      const identityId = uuid();
      await trx(PORTRAIT_IDENTITY_TABLE).insert({
        id: identityId, workspaceId: row.workspaceId, ownerUserId: Number(project.userId),
        kind: AUTOMATIC_PORTRAIT_SUBJECT, label: "人物参考素材", state: "active",
        activeConsentId: null, revision: 1, createdAt: now, updatedAt: now,
      });
      await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
        subjectKind: AUTOMATIC_PORTRAIT_SUBJECT, declarationState: "not_required",
        identityId, currentConsentId: null, preferredProviderChannelId: channel.id,
        complianceState: "allowed",
        providerSyncState: "queued", safeErrorCode: null, safeErrorMessage: null,
        revision: Number(row.revision) + 1, updatedAt: now,
      });
      prepared += 1;
    }); } catch {
      // Rotate a broken row out of the oldest batch. Do not let one historical
      // asset prevent all newer uploads from getting a registration identity.
      await database(PORTRAIT_ADMISSION_TABLE).where({ id: candidate.id, revision: candidate.revision })
        .whereNull("identityId").update({
          safeErrorCode: "PORTRAIT_REGISTRATION_PREPARATION_FAILED",
          safeErrorMessage: "素材登记准备暂不可用，平台将自动重试",
          revision: Number(candidate.revision) + 1, updatedAt: now,
        });
      logger.warn({ worker: "portrait-provider", admissionId: candidate.id,
        code: "PORTRAIT_REGISTRATION_PREPARATION_FAILED" }, "Portrait identity preparation failed");
    }
  }
  return prepared;
}
