import type { PortraitAdmission, PortraitAdmissionStage } from "./api";

type Presentation = {
  title: string;
  description: string;
  tone: "progress" | "attention" | "success" | "danger";
};

const stages: Record<PortraitAdmissionStage, Presentation> = {
  scanning: { title: "素材已上传，正在检查人物信息", description: "无需重复上传，你可以继续编辑。", tone: "progress" },
  moderating: { title: "素材已上传，正在进行安全检查", description: "检查结果将自动更新，你可以继续编辑。", tone: "progress" },
  manual_review: { title: "素材已上传，正在进行安全检查", description: "检查结果将自动更新，你可以继续编辑。", tone: "progress" },
  needs_declaration: { title: "需要确认素材类型", description: "选一项即可，其余检查与同步由平台完成。", tone: "attention" },
  needs_real_authorization: { title: "需要补充真人授权", description: "确认授权对象后，将进入官方安全授权页面。", tone: "attention" },
  real_authorization_pending: { title: "等待真人授权完成", description: "请在已打开的授权页面完成验证；本页会自动更新。", tone: "progress" },
  virtual_attestation: { title: "正在确认虚构人物声明", description: "声明已提交，结果将自动更新。", tone: "progress" },
  trusted_output_verification: { title: "正在核验素材来源", description: "无需重复上传，你可以继续编辑。", tone: "progress" },
  syncing: { title: "素材来源已确认，登记尚未完成", description: "登记完成后会自动更新素材状态。", tone: "progress" },
  ready: { title: "素材可用", description: "平台人像检查已完成，生成结果仍以供应商实际处理为准。", tone: "success" },
  blocked: { title: "素材暂不可用", description: "该素材未满足使用要求，请替换素材后继续。", tone: "danger" },
  failed: { title: "暂时无法完成素材检查", description: "素材已保存，请稍后重试。", tone: "danger" },
};

export function isBackgroundAdmissionStage(stage: PortraitAdmissionStage): boolean {
  return ["scanning", "moderating", "manual_review", "virtual_attestation", "trusted_output_verification", "syncing"].includes(stage);
}

export function admissionPresentation(stage: PortraitAdmissionStage, elapsedMs = 0): Presentation {
  const base = stages[stage];
  if (elapsedMs < 60_000 || !["scanning", "moderating", "manual_review"].includes(stage)) return base;
  return { ...base, title: "素材仍在检查中", description: "无需重复上传，结果将自动更新。你可以继续编辑。" };
}

export function admissionDescription(admission: PortraitAdmission, elapsedMs = 0): string {
  if (admission.stage === "syncing" && admission.blocking === false) {
    return "人像登记尚未完成，可直接提交生成；最终审核以生成平台为准。";
  }
  if (admission.error?.code === "PORTRAIT_VIDEO_STORAGE_AUTHORITY_UNAVAILABLE") {
    return "视频人像检查的存储服务尚未就绪，需要平台修复；检测请求尚未发出，不代表素材被审核拒绝。无需反复重试。"
      + (admission.blocking ? "" : "可先继续生成。");
  }
  // Only actionable policy reasons belong in the dialog. Transport/provider
  // diagnostics are not instructions the person using the product can act on.
  const reason = admission.error?.message;
  if ((admission.stage === "blocked" || admission.error?.code === "PORTRAIT_UPSTREAM_REAL_PERSON_REJECTED")
    && reason && !/ImageX|Adapter|credential|access.?key|凭据|输入槽|IMAGEX_|https?:\/\//i.test(reason)) return reason;
  return admissionPresentation(admission.stage, elapsedMs).description;
}

export function formatAdmissionWait(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  return seconds < 60 ? `本次已等待 ${seconds} 秒` : `本次已等待 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
