import { getPortraitAdmission, type PortraitAdmission } from "./api";

const labels: Partial<Record<PortraitAdmission["stage"], string>> = {
  scanning: "正在识别人物", moderating: "正在审核素材", syncing: "正在登记人物素材",
};

/** Wait before the generation POST. Completed registrations are reused and no
 * generation/billing request is replayed by this helper. */
export async function waitForPortraitAdmissions(input: {
  projectId: number;
  assetVersionIds: readonly number[];
  onProgress: (message: string) => void;
  isCurrent?: () => boolean;
  read?: typeof getPortraitAdmission;
  timeoutMs?: number;
  intervalMs?: number;
  requireRegistration?: boolean;
  registrationConfigured?: boolean;
}): Promise<void> {
  const pending = new Set(input.assetVersionIds.filter((id) => Number.isSafeInteger(id) && id > 0));
  const total = pending.size;
  const deadline = Date.now() + (input.timeoutMs ?? 300_000);
  const current = () => {
    if (input.isCurrent && !input.isCurrent()) throw new DOMException("已取消本次生成", "AbortError");
  };
  while (pending.size) {
    current();
    const admissions = await Promise.all([...pending].map((id) => (input.read ?? getPortraitAdmission)(input.projectId, id)));
    current();
    for (const admission of admissions) {
      if ((!input.requireRegistration && admission.blocking === false) || admission.stage === "ready") pending.delete(admission.assetVersionId);
      else if (["blocked", "failed", "needs_declaration", "needs_real_authorization"].includes(admission.stage)) {
        throw new Error(admission.error?.message || "人物素材暂不可用，请查看素材检查结果");
      }
      else if (input.requireRegistration && admission.stage === "syncing" && input.registrationConfigured === false) {
        throw new Error("所选火山视频通道的人像服务未配置，请联系管理员配置后继续，无需反复重试");
      }
    }
    if (!pending.size) return;
    const stage = admissions.find((entry) => pending.has(entry.assetVersionId))?.stage;
    input.onProgress(`${labels[stage ?? "scanning"] || "正在准备人物素材"}（${total - pending.size}/${total}），完成后自动继续生成`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("人物素材处理时间较长，请稍后提交；已完成的登记会自动复用");
    await new Promise((resolve) => globalThis.setTimeout(resolve, Math.min(input.intervalMs ?? 2500, remaining)));
  }
}
