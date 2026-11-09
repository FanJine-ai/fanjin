/**
 * PolicyPort 的实现：薄封装。核心判定 100% 委托现有纯函数 evaluateToolPolicy。
 * 本文件不得包含任何 if 判定业务规则——那些全在 policy.ts 里。
 */
import { evaluateToolPolicy } from "@/agent-runtime/policy";
import type { PolicyDecision } from "@/agent-runtime/policy";
import type { PolicyPort, PolicyCheckInput } from "./ports";
import { toEvaluateToolPolicyInput } from "./evidenceAdapter";

/** PolicyPort 实现：判定全部委托 policy.ts 的 evaluateToolPolicy。 */
export class RuntimePolicyAdapter implements PolicyPort {
  /** 返回 evaluateToolPolicy 的判定结果，不做任何修改。 */
  check(input: PolicyCheckInput): PolicyDecision {
    return evaluateToolPolicy(toEvaluateToolPolicyInput(input));
  }
}
