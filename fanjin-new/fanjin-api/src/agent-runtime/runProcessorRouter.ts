import type { Knex } from "knex";
import type {
  AgentRunProcessInput,
  AgentRunProcessResult,
} from "@/agent-runtime/runProcessor";

export interface AgentRunProcessorRouterTarget {
  process(input: AgentRunProcessInput): Promise<AgentRunProcessResult>;
}

export interface AgentRunProcessorRouterOptions {
  database: Knex;
  textProcessor: AgentRunProcessorRouterTarget;
  toolLoopProcessor: AgentRunProcessorRouterTarget;
  /** Optional until the A4 WorkerService composition is enabled. */
  delegatedProcessor?: AgentRunProcessorRouterTarget;
  /** Deterministic executor delegated Runs (V3 / storyVideo pipeline). */
  executorProcessor?: AgentRunProcessorRouterTarget;
}

function parsePolicySnapshot(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Routes a claimed main Run from its immutable admission snapshot. The live
 * tools feature flag is deliberately not consulted here: turning admission
 * off must still drain already-queued and approval-resumed tool Runs.
 */
export class AgentRunProcessorRouter implements AgentRunProcessorRouterTarget {
  private readonly database: Knex;
  private readonly textProcessor: AgentRunProcessorRouterTarget;
  private readonly toolLoopProcessor: AgentRunProcessorRouterTarget;
  private readonly delegatedProcessor: AgentRunProcessorRouterTarget | null;
  private readonly executorProcessor: AgentRunProcessorRouterTarget | null;

  constructor(options: AgentRunProcessorRouterOptions) {
    this.database = options.database;
    this.textProcessor = options.textProcessor;
    this.toolLoopProcessor = options.toolLoopProcessor;
    this.delegatedProcessor = options.delegatedProcessor ?? null;
    this.executorProcessor = options.executorProcessor ?? null;
  }

  async process(input: AgentRunProcessInput): Promise<AgentRunProcessResult> {
    const run = await this.database("o_agent_run")
      .where({ id: input.claimedRun.id })
      .select("kind", "agentRole", "policySnapshot")
      .first<{ kind?: unknown; agentRole?: unknown; policySnapshot?: unknown }>();
    if (!run) {
      return {
        status: "lease_lost",
        runId: input.claimedRun.id,
        responseMessageId: null,
      };
    }
    if (run.kind === "delegated") {
      if (run.agentRole === "executor") {
        if (!this.executorProcessor) {
          throw new Error("Executor Run Processor 未配置，拒绝执行 executor Run");
        }
        return this.executorProcessor.process(input);
      }
      if (!this.delegatedProcessor) {
        throw new Error("Delegated Run Processor 未配置，拒绝执行 delegated Run");
      }
      return this.delegatedProcessor.process(input);
    }
    if (run.kind !== "root") {
      throw new Error("Agent Run kind 无效，拒绝执行");
    }
    const policy = parsePolicySnapshot(run?.policySnapshot);
    const target = policy.toolsEnabled === true
      ? this.toolLoopProcessor
      : this.textProcessor;
    return target.process(input);
  }
}
