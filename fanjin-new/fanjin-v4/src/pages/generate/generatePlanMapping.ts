import type { AgentRuntimeStep } from "../../features/agent-runtime/types";

const PLAN_PRESENT_TOOL_NAMES: ReadonlySet<string> = new Set(["plan.present", "plan.submit"]);

export type PlanPresentPlanStep = {
  title: string;
  detail: string | null;
};

export type PlanPresentPlan = {
  title: string;
  summary: string | null;
  steps: PlanPresentPlanStep[];
  estimatedTotal: string | null;
};

function isPlanPresentPlanStep(value: unknown): value is PlanPresentPlanStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  return typeof step.title === "string" && step.title.trim().length > 0
    && (step.detail == null || typeof step.detail === "string");
}

export function isPlanPresentPlan(value: unknown): value is PlanPresentPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (typeof plan.title !== "string" || !plan.title.trim()) return false;
  if (plan.summary != null && typeof plan.summary !== "string") return false;
  if (plan.estimatedTotal != null && typeof plan.estimatedTotal !== "string") return false;
  return Array.isArray(plan.steps) && plan.steps.length > 0 && plan.steps.every(isPlanPresentPlanStep);
}

type AgentRuntimeStepPlanCarrier = AgentRuntimeStep & { plan?: unknown; outputRefs?: unknown };

function planPresentFromStep(step: AgentRuntimeStep): PlanPresentPlan | null {
  if (step.kind !== "tool" || !step.toolName || !PLAN_PRESENT_TOOL_NAMES.has(step.toolName)) return null;
  const carrier = step as AgentRuntimeStepPlanCarrier;
  if (isPlanPresentPlan(carrier.plan)) return carrier.plan;
  if (Array.isArray(carrier.outputRefs)) {
    for (const ref of carrier.outputRefs) {
      if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
      const record = ref as Record<string, unknown>;
      if (record.type !== "inline_tool_result") continue;
      if (typeof record.toolName !== "string" || !PLAN_PRESENT_TOOL_NAMES.has(record.toolName)) continue;
      if (isPlanPresentPlan(record.value)) return record.value;
    }
  }
  return null;
}

export function latestPlanFromRuntimeSteps(steps: readonly AgentRuntimeStep[] | undefined): PlanPresentPlan | null {
  if (!steps?.length) return null;
  const ordered = [...steps].sort((left, right) => right.seq - left.seq);
  for (const step of ordered) {
    const found = planPresentFromStep(step);
    if (found) return found;
  }
  return null;
}
