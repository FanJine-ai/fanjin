import { formatGuMicros } from "../../utils/billingUnits";
import type { AgentSkillBillingPolicy } from "./types";

export function agentSkillBillingLabel(policy?: AgentSkillBillingPolicy | null): string {
  // The catalog endpoint added billing metadata after the first public skill
  // clients shipped. Treat an omitted policy as the canonical free-catalog /
  // underlying-usage policy so older cached responses and extensions remain
  // visible instead of making the entire catalog fail to render.
  const normalizedPolicy: AgentSkillBillingPolicy = policy ?? {
    currency: "GU",
    catalogAccessMicros: 0,
    templateCopyMicros: 0,
    executionMode: "underlying_usage",
    surchargeMicros: 0,
  };
  const access = normalizedPolicy.catalogAccessMicros === 0 && normalizedPolicy.templateCopyMicros === 0
    ? "浏览、查看和复制免费"
    : "浏览或复制可能收费";
  const execution = normalizedPolicy.executionMode === "underlying_usage"
    ? "执行按实际用量计费"
    : "执行费用以确认页为准";
  const surcharge = normalizedPolicy.surchargeMicros > 0
    ? `，另收 ${formatGuMicros(normalizedPolicy.surchargeMicros, 6)}/次`
    : "";
  return `${access}，${execution}${surcharge}`;
}
