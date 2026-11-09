/**
 * 按 FANJIN_AGENT_USE_CORE 决定 Router 的 toolLoop 这一路用哪个实现。
 * 支持全局和细粒度（workspace/project/百分比）灰度控制。
 */
import { AgentRunProcessorRouter } from "@/agent-runtime/runProcessorRouter";
import type { AgentRunProcessorRouterTarget } from "@/agent-runtime/runProcessorRouter";
import type { AgentRunProcessInput } from "@/agent-runtime/runProcessor";
import type { Knex } from "knex";
import { isAgentCoreEnabled, shouldUseCoreBackedProcessor } from "./featureFlag";

/** 组装 Router 所需的依赖。 */
export interface RouterCompositionDeps {
  database: Knex;
  textProcessor: AgentRunProcessorRouterTarget;
  legacyToolLoopProcessor: AgentRunProcessorRouterTarget;
  coreBackedProcessor: AgentRunProcessorRouterTarget;
  delegatedProcessor?: AgentRunProcessorRouterTarget;
}

/**
 * 按 flag 组装 AgentRunProcessorRouter。
 * 
 * 全局模式（FANJIN_AGENT_USE_CORE=1）：进程级决策，所有 Run 使用同一实现
 * 灰度模式（workspace:/project:/percent:）：运行时决策，支持动态切换
 * 
 * 注意：灰度切换需要在 Router 层之前解析 Run 的 workspace/project 信息
 * 当前实现使用静态路由（全局启用或全局禁用），细粒度灰度需要在上层实现
 */
export function composeAgentRunProcessorRouter(deps: RouterCompositionDeps): AgentRunProcessorRouter {
  // 全局启用时使用 core-backed processor
  const toolLoopProcessor = isAgentCoreEnabled()
    ? deps.coreBackedProcessor
    : deps.legacyToolLoopProcessor;

  return new AgentRunProcessorRouter({
    database: deps.database,
    textProcessor: deps.textProcessor,
    toolLoopProcessor,
    delegatedProcessor: deps.delegatedProcessor,
  });
}
