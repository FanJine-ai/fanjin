import { readPortraitAdmission, type PortraitAdmissionDto } from "@/lib/portraitAdmissionStore";

const nextSteps: Record<PortraitAdmissionDto["nextAction"], string> = {
  wait_for_scan: "素材正在检测，请稍后使用 fanjin_asset_get 查询同一素材版本。",
  wait_for_moderation: "素材正在审核，请稍后使用 fanjin_asset_get 查询同一素材版本。",
  wait_for_provider: "素材正在同步；已识别人像或已确认来源的素材可用 fanjin_portrait_asset_register 主动登记。使用 fanjin_asset_get 查询同一素材版本，ready 前不能视为已登记完成。",
  wait_for_admin_review: "素材需要复核，请在项目素材中查看进度。",
  confirm_source: "检测未能确定人物类型。若上传时已有所选模型线路，请直接用该 model 调用 fanjin_portrait_asset_register，按当前线路登记并继续查询 fanjin_asset_get；不再向用户重复索要声明。若没有线路元数据，或上游明确要求补充来源确认，再向用户展示免责声明，由用户按真实内容确认：没有人物用 ordinary_no_person；不对应现实个人的 AI 虚构人物用 fully_virtual_person；真人须选择 real_person_with_rights 并完成授权。视频按整段原片单独登记，不能复用角色图片的登记。明确被上游以含真人拒绝后不能改选无人像直接重投，应更换素材或申请复核。确认后查询 fanjin_asset_get 至 ready，再报价和确认预算；不会自动重投。",
  authorize_real_person: "请由用户在项目素材中完成所需的人像授权。",
  retry: "请在项目素材中查看错误并重试素材检查，不要重复上传或提交生成。",
  replace_or_split_media: "该素材尚不能用于生成，请在项目素材中查看原因并更换或拆分素材。",
  ready: "素材已就绪，可用同一 assetVersionId 报价，最终准入仍在提交时校验。",
};

/** Read only after asset/project authorization; project resolution also rechecks shared references. */
export async function toolPortraitStatus(input: Parameters<typeof readPortraitAdmission>[0], mediaType: string) {
  // Legacy versions may retain their asset-domain type (role/scene/tool/clip).
  // Read the actual admission instead of treating that domain label as no portrait.
  if (!["image", "video", "role", "scene", "tool", "clip"].includes(mediaType)) return null;
  const admission = await readPortraitAdmission(input);
  if (!admission) return {
    status: "unavailable" as const,
    blocking: null,
    nextAction: "check_in_workbench" as const,
    message: "尚无人像准入记录，请在项目素材中检查；这不表示审核通过，也不能据此判断平台缺少凭据。",
  };
  const admissionMediaType = admission.mediaType || (mediaType === "clip" ? "video" : mediaType);
  const waiting = admission.nextAction.startsWith("wait_for_");
  const registered = admission.nextAction === "ready" && admission.providerSyncState === "active";
  const registrationStatus = registered ? "registered"
    : admission.providerSyncState === "not_needed" ? "not_registered"
    : waiting && admission.nextAction === "wait_for_provider" ? "processing" : "unavailable";
  return {
    status: admission.nextAction === "ready" ? "ready" : waiting ? "processing" : "action_required",
    blocking: admission.blocking,
    nextAction: admission.nextAction,
    canSubmitForProviderReview: !admission.blocking,
    message: !admission.blocking && !registered && admission.nextAction !== "ready"
      ? "人像预检仅作提示，不阻止开始生成。上传时已选择模型线路的素材，直接用该 model 调用 fanjin_portrait_asset_register 并查询 fanjin_asset_get；不再重复索要声明。没有线路元数据的旧素材才使用 fanjin_portrait_admission_declare 完成来源声明和整段视频登记。若平台拒绝，任务会返回拒绝原因，不会自动重投；应更换素材或申请复核。Agent 不得代替用户判断或确认，不能把预检未完成称为已审核通过。"
      : registered
      ? "该素材版本已完成人像登记，可直接复用同一 assetVersionId 报价，无需重新上传或重复声明。更换通道时平台会校验并准备该通道的登记；登记不保证后续生成审核通过。"
      : admissionMediaType === "video" && admission.nextAction === "wait_for_scan"
        ? "视频正在抽帧检测。若上传时已选择模型线路，等待检测完成后直接用该 model 调用 fanjin_portrait_asset_register 登记整段视频，不再重复索要声明；没有线路元数据的旧素材才使用 fanjin_portrait_admission_declare。Agent 不得代替用户判断或确认。来源未明确时使用 fanjin_asset_get 继续查询检测结果。"
        : nextSteps[admission.nextAction],
    registration: { status: registrationStatus, reusable: registered, mediaType: admissionMediaType },
    ...(waiting ? { pollAfterMs: 3000 } : {}),
    faceScanState: admission.faceScan.state,
    moderationState: admission.moderation.state,
    providerSyncState: admission.providerSyncState,
    revision: admission.revision,
    declarationState: admission.declarationState,
    error: admission.error,
    updatedAt: admission.updatedAt,
  };
}
