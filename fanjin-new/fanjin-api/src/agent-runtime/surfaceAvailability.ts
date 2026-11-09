import type { Knex } from "knex";
import {
  type AgentChatModelCatalogEntry,
  listAgentChatModels,
} from "@/agent-runtime/agentChatBilling";
import {
  inspectAgentGenerationSubmitConfiguration,
  isAgentRuntimeExecutionConfigured,
  isAgentRuntimeToolsEnabled,
} from "@/agent-runtime/featureFlags";
import {
  probeAgentRuntimeWorkerReadiness,
} from "@/agent-runtime/workerReadiness";
import { probeRuntimeReadiness } from "@/lib/runtimeReadiness";
import {
  buildWorkbenchModelCatalog,
  listWorkbenchRouteModels,
  type WorkbenchModelCatalog,
  type WorkbenchRouteModelSummary,
} from "@/lib/workbenchModelCatalog";
import { db } from "@/utils/db";

export type AgentSurfaceAvailabilityReason =
  | "runtime_execution_unavailable"
  | "runtime_tools_unavailable"
  | "generation_submit_unavailable"
  | "agent_worker_unavailable"
  | "runtime_dependencies_unavailable"
  | "chat_model_unavailable"
  | "image_model_unavailable"
  | "video_model_unavailable";

export interface AgentSurfaceAvailability {
  available: boolean;
  reason: AgentSurfaceAvailabilityReason | null;
  message: string | null;
  capabilities: {
    chat: boolean;
    tools: boolean;
    imageGeneration: boolean;
    videoGeneration: boolean;
  };
  models: AgentChatModelCatalogEntry[];
}

type RuntimeReadinessSummary = { ready: boolean };

export interface InspectAgentSurfaceAvailabilityOptions {
  workspaceId: string;
  environment?: NodeJS.ProcessEnv;
  database?: Knex;
  probeAgentWorker?: () => Promise<RuntimeReadinessSummary>;
  probeReadiness?: () => Promise<RuntimeReadinessSummary>;
  listChatModels?: (workspaceId: string) => Promise<AgentChatModelCatalogEntry[]>;
  listTextRoutes?: (workspaceId: string) => Promise<WorkbenchRouteModelSummary[]>;
  readGenerationCatalog?: (workspaceId: string) => Promise<WorkbenchModelCatalog>;
}

function unavailable(
  reason: AgentSurfaceAvailabilityReason,
  message: string,
  capabilities: Partial<AgentSurfaceAvailability["capabilities"]> = {},
  models: AgentChatModelCatalogEntry[] = [],
): AgentSurfaceAvailability {
  return {
    available: false,
    reason,
    message,
    capabilities: {
      chat: false,
      tools: false,
      imageGeneration: false,
      videoGeneration: false,
      ...capabilities,
    },
    models,
  };
}

/**
 * One fail-closed truth source for Agent execution and release readiness.
 *
 * `available` remains the complete four-capability release gate. Once chat and
 * tools are proven, executable chat models are retained in a partial response
 * so the UI can keep text conversation usable while disabling only a degraded
 * image or video generation control.
 */
export async function inspectAgentSurfaceAvailability(
  options: InspectAgentSurfaceAvailabilityOptions,
): Promise<AgentSurfaceAvailability> {
  const workspaceId = String(options.workspaceId || "").trim();
  const environment = options.environment ?? process.env;
  if (!isAgentRuntimeExecutionConfigured(environment)) {
    return unavailable("runtime_execution_unavailable", "Agent 执行服务尚未就绪");
  }
  const toolsConfigured = isAgentRuntimeToolsEnabled(environment);
  const generationSubmit = inspectAgentGenerationSubmitConfiguration(environment);
  const database = options.database ?? (db as unknown as Knex);
  const [chatModelsResult, textRoutesResult, generationCatalogResult, agentWorkerResult, readinessResult]
    = await Promise.allSettled([
    (options.listChatModels ?? listAgentChatModels)(workspaceId),
    options.listTextRoutes
      ? options.listTextRoutes(workspaceId)
      : listWorkbenchRouteModels({
          workspaceId,
          endpointTypes: ["text"],
          database,
        }),
    options.readGenerationCatalog
      ? options.readGenerationCatalog(workspaceId)
      : buildWorkbenchModelCatalog(workspaceId, database),
    options.probeAgentWorker
      ? options.probeAgentWorker()
      : probeAgentRuntimeWorkerReadiness(database, { environment }),
    options.probeReadiness
      ? options.probeReadiness()
      : probeRuntimeReadiness(database, {
          requireWorker: true,
          requireWeb: false,
        }),
  ]);

  // Configuration is the durable service-open truth. Health probes are
  // operational observations: they may make the complete release gate red,
  // but they must not rewrite all configured capabilities to false.
  const chatModels = chatModelsResult.status === "fulfilled" ? chatModelsResult.value : [];
  const textRoutes = textRoutesResult.status === "fulfilled" ? textRoutesResult.value : [];
  const generationCatalog = generationCatalogResult.status === "fulfilled"
    ? generationCatalogResult.value
    : null;
  const agentWorkerReady = agentWorkerResult.status === "fulfilled"
    && agentWorkerResult.value.ready;
  const runtimeDependenciesReady = readinessResult.status === "fulfilled"
    && readinessResult.value.ready;

  const executableTextModels = new Set(
    textRoutes
      .filter((route) => route.canSubmit)
      .flatMap((route) => [route.id, route.model, route.resolvedModel]),
  );
  const executableChatModels = chatModels.filter((model) => (
    model.available
    && (executableTextModels.has(model.id) || executableTextModels.has(model.modelId))
  ));
  const generationConfigured = generationSubmit.enabled && generationSubmit.ready;
  const imageGeneration = generationConfigured
    && Boolean(generationCatalog?.imageModels.some((model) => model.canSubmit));
  const videoGeneration = generationConfigured
    && Boolean(generationCatalog?.videoModels.some((model) => model.canSubmit));
  const capabilities = {
    chat: executableChatModels.length > 0,
    tools: toolsConfigured,
    imageGeneration,
    videoGeneration,
  };

  let reason: AgentSurfaceAvailabilityReason | null = null;
  let message: string | null = null;
  if (!toolsConfigured) {
    reason = "runtime_tools_unavailable";
    message = "Agent 工具执行服务尚未就绪";
  } else if (!generationConfigured) {
    reason = "generation_submit_unavailable";
    message = "Agent 真实生成能力尚未就绪";
  } else if (!capabilities.chat) {
    reason = "chat_model_unavailable";
    message = "Agent 对话模型路由或计费尚未就绪";
  } else if (!imageGeneration) {
    reason = "image_model_unavailable";
    message = "Agent 图片生成模型路由或计费尚未就绪";
  } else if (!videoGeneration) {
    reason = "video_model_unavailable";
    message = "Agent 视频生成模型路由或计费尚未就绪";
  } else if (!agentWorkerReady) {
    reason = "agent_worker_unavailable";
    message = "Agent 专用执行 Worker 暂时不可达，服务配置保持开放";
  } else if (!runtimeDependenciesReady) {
    reason = "runtime_dependencies_unavailable";
    message = "Agent 运行依赖暂时不可达，服务配置保持开放";
  }

  const available = reason === null;
  return {
    available,
    reason,
    message,
    capabilities,
    models: executableChatModels,
  };
}
