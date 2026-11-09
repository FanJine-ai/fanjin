import type { Knex } from "knex";
import { PORTRAIT_ADMISSION_TABLE, PORTRAIT_IDENTITY_TABLE } from "./migrations/portraitAssetAdmission";
import { PortraitAdmissionWorkflowError } from "./portraitAdmissionError";
import { readPortraitAdmission } from "./portraitAdmissionStore";
import { preferredVolcanoPortraitChannel } from "./portraitProviderChannel";
import { ensurePortraitProviderBindingQueued } from "./portraitProviderRuntime";
import { isAutomaticPortrait } from "./portraitAutomaticRegistration";
import { resolveProjectAssetVersion } from "./projectAssetVersion";
import { isPortraitProviderRefusal, PORTRAIT_PROVIDER_REFUSAL_MESSAGE } from "./portraitSubmissionPolicy";
import { portraitScopeCompliance } from "./portraitReviewScope";
import { hasUpstreamRealPersonRejection } from "./portraitUpstreamRejection";
import { v4 as uuid } from "uuid";

/** Queue registration of an existing, declared asset. Does not attest rights or submit generation. */
export async function registerPortraitAsset(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  actorUserId: number;
  expectedRevision?: number | null;
  model?: string;
  /** Internal dispatch selection. Public registration routes do not accept this field. */
  channelId?: string;
  now?: number;
}) {
  return input.database.transaction(async (tx) => {
    const source = await resolveProjectAssetVersion({ ...input, database: tx });
    if (!source) throw new PortraitAdmissionWorkflowError(404, "portrait_admission_not_found", "素材不存在或无权使用");
    let row = await tx(PORTRAIT_ADMISSION_TABLE).where({
      workspaceId: input.workspaceId, projectId: source.sourceProjectId, assetVersionId: input.assetVersionId,
    }).forUpdate().first();
    if (!row) throw new PortraitAdmissionWorkflowError(404, "portrait_admission_not_found", "素材尚在入库，请稍后自动重试登记");
    if (input.expectedRevision != null && Number(row.revision) !== input.expectedRevision) {
      throw new PortraitAdmissionWorkflowError(409, "portrait_revision_conflict", "素材状态已更新，请刷新后重试");
    }
    if (isPortraitProviderRefusal(row.safeErrorCode)) {
      throw new PortraitAdmissionWorkflowError(409, "portrait_provider_review_required", PORTRAIT_PROVIDER_REFUSAL_MESSAGE);
    }
    if (hasUpstreamRealPersonRejection(row)) {
      throw new PortraitAdmissionWorkflowError(409, "portrait_upstream_review_required", "上游要求核实人物来源，请查看素材登记结果");
    }
    const compliance = portraitScopeCompliance(row);
    if (["revoked", "expired"].includes(compliance)
      || (compliance === "denied" && row.safeErrorCode !== "PORTRAIT_SOURCE_UNCERTAIN")) {
      throw new PortraitAdmissionWorkflowError(409, "portrait_admission_restricted", "素材授权或登记已受限，请查看素材状态");
    }
    const routeSelected = Boolean(String(input.model || input.channelId || "").trim());
    const scanState = String(row.faceScanState || "");
    const noFace = row.mediaType === "image" && scanState === "no_face" && Number(row.faceCount || 0) === 0;
    // The selected model route is made at reference upload time. It is the
    // routing choice for this asset and deliberately does not ask the user to
    // repeat a portrait declaration after the face detector returns uncertain.
    // A confirmed no-face image remains an ordinary reference and never enters
    // the portrait provider.
    if (routeSelected && row.declarationState !== "confirmed" && row.subjectKind !== "real_person" && noFace) {
      await tx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
        subjectKind: "ordinary", declarationState: "not_required", declarationVersion: null,
        declaredByUserId: null, declaredAt: null, currentConsentId: null, identityId: null,
        complianceState: "not_required", providerSyncState: "not_needed",
        safeErrorCode: null, safeErrorMessage: null, revision: Number(row.revision) + 1,
        updatedAt: input.now ?? Date.now(),
      });
      const admission = await readPortraitAdmission({ ...input, database: tx });
      if (!admission) throw new PortraitAdmissionWorkflowError(404, "portrait_admission_not_found", "素材人像准入记录不存在");
      return {
        admission,
        registration: {
          assetVersionId: input.assetVersionId,
          model: input.model,
          mediaType: admission.mediaType,
          status: "registered" as const,
          providerSyncState: "not_needed",
          message: "当前线路无需人像登记，可直接使用素材",
          statusEndpoint: "/api/workbench/portrait-admissions/register",
        },
      };
    }
    let automatic = isAutomaticPortrait(row);
    if (routeSelected && (!automatic || !row.identityId) && row.declarationState !== "confirmed"
      && row.subjectKind !== "real_person") {
      const project = await tx("o_project").where({ id: row.projectId }).first("userId");
      const ownerUserId = Number(project?.userId || input.actorUserId);
      if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
        throw new PortraitAdmissionWorkflowError(404, "portrait_admission_not_found", "素材所属项目不存在");
      }
      const identityId = String(row.identityId || uuid());
      if (!row.identityId) {
        await tx(PORTRAIT_IDENTITY_TABLE).insert({
          id: identityId, workspaceId: input.workspaceId, ownerUserId,
          kind: "detected_person", label: "人物参考素材", state: "active",
          activeConsentId: null, revision: 1, createdAt: input.now ?? Date.now(), updatedAt: input.now ?? Date.now(),
        });
      }
      await tx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
        subjectKind: "detected_person", declarationState: "not_required", declarationVersion: null,
        declaredByUserId: null, declaredAt: null, identityId, currentConsentId: null,
        complianceState: "allowed", providerSyncState: "queued", safeErrorCode: null,
        safeErrorMessage: null, revision: Number(row.revision) + 1, updatedAt: input.now ?? Date.now(),
      });
      row = { ...row, subjectKind: "detected_person", declarationState: "not_required", identityId,
        currentConsentId: null, complianceState: "allowed", providerSyncState: "queued", safeErrorCode: null };
      automatic = true;
    }
    if (!automatic && row.declarationState !== "confirmed") {
      throw new PortraitAdmissionWorkflowError(409, "portrait_declaration_required", "请先由用户确认素材真实来源并提交声明，再登记资产");
    }
    if (!automatic && !["virtual_person", "trusted_output", "real_person"].includes(row.subjectKind)) {
      throw new PortraitAdmissionWorkflowError(422, "portrait_provider_subject_unsupported", "当前素材不需要人像资产登记");
    }
    // An explicit target model prepares its own account-bound registration.
    // Unspecified models preserve the existing default; never silently fall
    // back to a domestic account when an explicit overseas route is missing.
    const channelId = input.model || input.channelId
      ? await preferredVolcanoPortraitChannel({ database: tx, workspaceId: input.workspaceId,
          model: input.model, channelId: input.channelId, requireModelRoute: Boolean(input.model) })
      : row.preferredProviderChannelId || await preferredVolcanoPortraitChannel({
          database: tx, workspaceId: input.workspaceId,
        });
    if (!channelId) throw new PortraitAdmissionWorkflowError(503, "portrait_provider_channel_unavailable", "平台人像登记通道尚未配置，请联系管理员；素材声明已保留");
    const queued = await ensurePortraitProviderBindingQueued({
      database: tx, workspaceId: input.workspaceId, projectId: source.sourceProjectId,
      assetVersionId: input.assetVersionId, channelId, now: input.now, retryFailed: false, refreshFailedObservation: true,
    });
    const admission = await readPortraitAdmission({ ...input, database: tx });
    if (!admission) throw new PortraitAdmissionWorkflowError(404, "portrait_admission_not_found", "素材人像准入记录不存在");
    const registered = queued.state === "active";
    return {
      admission,
      // Return only public workflow state, never provider IDs, namespaces, URLs or credentials.
      registration: {
        assetVersionId: input.assetVersionId,
        ...(input.model ? { model: input.model, statusEndpoint: "/api/workbench/portrait-admissions/register" } : {}),
        mediaType: admission.mediaType,
        status: registered ? "registered" as const : "processing" as const,
        providerSyncState: queued.state,
        message: registered ? "资产已在目标通道登记，可重新报价" : "目标通道正在登记；其他通道已就绪不代表本通道已登记",
        ...(input.model ? {} : { statusTool: "fanjin_asset_get" as const }),
        ...(registered ? {} : { pollAfterMs: 3000 }),
      },
    };
  });
}
