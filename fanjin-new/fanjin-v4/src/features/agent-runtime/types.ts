export type AgentRuntimeRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "waiting_delegation"
  | "waiting_external"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AgentRuntimeMessageStatus = "pending" | "streaming" | "completed" | "stopped" | "error";

export type AgentRuntimeError = {
  code: string;
  message: string;
} | null;

export type AgentRuntimeContentPart = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type AgentMessageContextAssetRefInput = {
  assetId: number;
};

export type AgentMessageGenerationPreferences =
  | {
      generationType: "image";
      model: string;
      ratio: string;
      quality: string;
      count: number;
    }
  | {
      generationType: "video";
      model: string;
      ratio: string;
      resolution: string;
      mode: string;
      duration: number;
      generateAudio: boolean;
      outputFormat?: "mp4" | "mov";
    };

/**
 * Client-selected project context. Attachments and skills stay in their
 * dedicated request fields so the Runtime can validate and canonicalize them
 * before returning the confirmed snapshot below.
 */
export type AgentMessageContextSnapshotInput = {
  assetRefs?: AgentMessageContextAssetRefInput[];
  style?: string | null;
  generationPreferences?: AgentMessageGenerationPreferences;
};

export type AgentMessageContextSnapshotAsset = {
  assetId: number;
  assetVersionId: string | null;
  name: string;
  kind: string | null;
};

export type AgentMessageContextSnapshotReference = {
  assetVersionId: string;
  assetId: number;
  name: string;
  kind: string | null;
};

export type AgentMessageContextSnapshotSkill = {
  key: string;
  version: string;
  displayName: string;
};

/**
 * Server-authored truth for the context accepted by a user message. The UI
 * must never promote client prompt labels to confirmed context.
 */
export type AgentMessageContextSnapshot = {
  schemaVersion: 1;
  status: "confirmed";
  digest: string;
  assets: AgentMessageContextSnapshotAsset[];
  attachments: AgentMessageContextSnapshotReference[];
  references: AgentMessageContextSnapshotReference[];
  skills: AgentMessageContextSnapshotSkill[];
  style: string | null;
  generationPreferences?: AgentMessageGenerationPreferences;
};

/** Server evidence that a successful assistant response consumed a snapshot. */
export type AgentMessageContextUsage = {
  schemaVersion: 1;
  status: "used";
  digest: string;
};

export type AgentRuntimeThread = {
  id: string;
  projectId: number;
  sessionId: string | null;
  title: string;
  status: "active" | "archived";
  activeRootRunId: string | null;
  messageSeq: number;
  eventSeq: number;
  lastMessageAt: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  replayed?: boolean;
};

export type AgentRuntimeCreationSession = {
  id: string;
  projectId: number;
  goal: string;
  mode: "agent" | "quick_create" | "canvas";
  inputs: unknown[];
  parameters: Record<string, unknown>;
  selectedAssetVersionIds: string[];
  canvasId: string | null;
  status: "active" | "archived";
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type AgentRuntimeEnsureResult = {
  project: { id: number; name: string; created: boolean };
  session: AgentRuntimeCreationSession;
  thread: AgentRuntimeThread;
  replayed: boolean;
};

export type AgentRuntimeMessage = {
  id: string;
  threadId: string;
  runId: string | null;
  replyToId: string | null;
  clientMessageId: string | null;
  seq: number;
  role: "user" | "assistant" | "system" | "tool";
  agentRole: string | null;
  status: AgentRuntimeMessageStatus;
  content: AgentRuntimeContentPart[];
  referenceRefs: string[];
  contextSnapshot: AgentMessageContextSnapshot | null;
  contextUsage?: AgentMessageContextUsage | null;
  error: AgentRuntimeError;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type AgentRuntimeRun = {
  id: string;
  threadId: string;
  rootRunId: string;
  parentRunId: string | null;
  kind: "root" | "delegated";
  agentRole: string;
  triggerMessageId: string;
  responseMessageId: string | null;
  status: AgentRuntimeRunStatus;
  waitType: string | null;
  wakeAt: number | null;
  sideEffectsCommitted: boolean;
  cancelRequestedAt: number | null;
  cancelReason: string | null;
  selectionSnapshot?: {
    chatModelId: string | null;
    skillRefs: Array<{ key: string; version: string }>;
  };
  error: AgentRuntimeError;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

export type AgentRuntimeEvent = {
  id?: string;
  threadId?: string;
  runId?: string | null;
  messageId?: string | null;
  stepId?: string | null;
  seq?: number;
  type: string;
  payload?: Record<string, unknown>;
  createdAt?: number;
  reason?: string;
  code?: string;
  message?: string;
};

export type AgentRuntimeThreadPage = {
  data: AgentRuntimeThread[];
  nextCursor: string | null;
};

export type AgentRuntimeMessagePage = {
  data: AgentRuntimeMessage[];
  nextCursor: number | null;
};

export type AgentRuntimeMessageSubmission = {
  threadId: string;
  message: AgentRuntimeMessage;
  run: AgentRuntimeRun;
  replayed: boolean;
};

/**
 * 随消息发送的附件引用(REVAMP-PLAN 4.4)。契约以 Worker T 后端报告为准;
 * 在其落地前按约定先行:kind 限 image/file,url/assetRef 至少给出一个才有
 * 后端意义,本地 blob 预览 URL 不上送。
 */
export type AgentMessageAttachmentInput = {
  kind: "image" | "file";
  name: string;
  url?: string;
  assetRef?: string;
};

/** 随消息发送的技能引用(REVAMP-PLAN 4.3),key 与后端技能注册表对齐。 */
export type AgentMessageSkillRefInput = {
  key: string;
  version?: string;
};

export type AgentSkillCatalogItem = {
  key: string;
  version: string;
  displayName: string;
  roles: AgentRuntimeRole[];
  billingPolicy: AgentSkillBillingPolicy;
  category?: string;
  summary?: string;
  useCases?: string[];
  input?: string;
  output?: string;
  limits?: string[];
  example?: string;
  publisher?: "Fanjin 官方";
  provenance?: "runtime_registry";
  copyMode?: "canonical_reference";
  description?: string;
  source?: "fanjin" | "jimeng";
  sourceId?: string | null;
  sourceAuthor?: string | null;
  tags?: string[];
};

export type AgentSkillBillingPolicy = {
  currency: "GU";
  catalogAccessMicros: number;
  templateCopyMicros: number;
  executionMode: "underlying_usage";
  surchargeMicros: number;
};

export type AgentChatModel = {
  id: string;
  /** 真实上游模型 id；id 可能是平台稳定别名。 */
  modelId?: string;
  displayName: string;
  description: string;
  /** 0.1.0 只展示已具备真实路由与 Token 定价的模型。 */
  available?: boolean;
  /** token=按上游权威 Token Usage 结算；旧值仅用于兼容历史响应。 */
  billingMode?: "token" | "usage" | "run" | "run_plus_usage";
  /** Agent LLM 单次调用授权额，最终结算不以此作为固定售价。 */
  reservationMicros?: number;
  /** 基于服务端保守 Token 上界得出的展示预估，不是固定报价。 */
  estimatedCostMicros?: number | null;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  /** @deprecated 0.0.x 固定按轮计费字段。 */
  free?: boolean;
  /** @deprecated 0.0.x 每轮固定价字段。 */
  priceMicros?: number;
  default: boolean;
};

export type AgentSurfaceAvailability = {
  available: boolean;
  reason:
    | "runtime_execution_unavailable"
    | "runtime_tools_unavailable"
    | "generation_submit_unavailable"
    | "agent_worker_unavailable"
    | "runtime_dependencies_unavailable"
    | "chat_model_unavailable"
    | "image_model_unavailable"
    | "video_model_unavailable"
    | null;
  message: string | null;
  capabilities: {
    chat: boolean;
    tools: boolean;
    imageGeneration: boolean;
    videoGeneration: boolean;
  };
  models: AgentChatModel[];
};

export type AgentRuntimeStepStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "awaiting_approval"
  | "waiting_external"
  | "uncertain";

export type AgentRuntimeStepPlanStep = {
  title: string;
  detail: string | null;
};

/**
 * Whitelisted plan.present echo projected by the Step DTO. The shape matches
 * the backend planPresentOutputSchema projection in fanjin-api agent-runtime
 * dto.ts; it is null for every non-plan Step and only populated for a
 * plan.present tool Step whose output passed the tool output schema.
 */
export type AgentRuntimeStepPlan = {
  title: string;
  summary: string | null;
  steps: AgentRuntimeStepPlanStep[];
  estimatedTotal: string | null;
};

export type AgentRuntimeGenerationReview = {
  reviewId: string;
  engine: string;
  verdict: "pass" | "attention";
} | null;

export type AgentRuntimeGenerationReceipt =
  | {
      generationType: "image";
      status: "succeeded" | "failed" | "unavailable";
      code: string | null;
      message: string | null;
      quoteId: string | null;
      model: string;
      units: number;
      size: string | null;
      assets: Array<{
        mediaAssetId: string;
        assetId: number;
        assetVersionId: number;
        url: string;
        mirrored: boolean;
      }>;
      review: AgentRuntimeGenerationReview;
    }
  | {
      generationType: "video";
      status: "succeeded" | "failed" | "unavailable";
      code: string | null;
      message: string | null;
      quoteId: string | null;
      model: string;
      units: 1;
      task: {
        taskId: string;
        status: string;
      } | null;
      assetVersionId: number | null;
      review: AgentRuntimeGenerationReview;
    };

export type AgentRuntimeStep = {
  id: string;
  runId: string;
  parentStepId: string | null;
  seq: number;
  agentRole: string;
  kind: string;
  status: AgentRuntimeStepStatus;
  toolName: string | null;
  error: AgentRuntimeError;
  plan: AgentRuntimeStepPlan | null;
  generationReceipt: AgentRuntimeGenerationReceipt | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

export type AgentRuntimeStepPage = {
  data: AgentRuntimeStep[];
  nextCursor: number | null;
};

export const AGENT_RUNTIME_ROLES = [
  "main",
  "writer",
  "visual",
  "storyboard",
  "executor",
  "reviewer",
] as const;

export type AgentRuntimeRole = (typeof AGENT_RUNTIME_ROLES)[number];

export type AgentRuntimeConfigRef = {
  key: string;
  version: string;
};

export type AgentRoleRuntimeConfig = {
  role: AgentRuntimeRole;
  promptRef: AgentRuntimeConfigRef;
  skillRefs: AgentRuntimeConfigRef[];
  modelProfileRef: AgentRuntimeConfigRef;
  modelAliasOverride: string | null;
  resolvedModelAlias: string;
  temperatureMilli: number;
  maxOutputTokens: number;
  enabled: boolean;
  revision: number;
  updatedBy: number | null;
  updatedAt: number | null;
  source: "registry" | "database";
};

export type AgentRuntimePromptRegistryItem = AgentRuntimeConfigRef & {
  role: AgentRuntimeRole;
};

export type AgentRuntimeSkillRegistryItem = AgentRuntimeConfigRef & {
  displayName: string;
  roles: AgentRuntimeRole[];
};

export type AgentRuntimeModelProfileRegistryItem = AgentRuntimeConfigRef & {
  modelAlias: string;
  temperatureMilli: number;
  maxOutputTokens: number;
  capabilities: string[];
};

export type AgentRuntimeConfigRegistry = {
  roles: AgentRuntimeRole[];
  prompts: AgentRuntimePromptRegistryItem[];
  skills: AgentRuntimeSkillRegistryItem[];
  modelProfiles: AgentRuntimeModelProfileRegistryItem[];
};

export type AgentRoleConfigListResult = {
  configs: AgentRoleRuntimeConfig[];
  registry: AgentRuntimeConfigRegistry;
  runtime: {
    available: boolean;
    status: "enabled" | "disabled" | "missing" | "invalid";
    executionConfigured: boolean;
    toolsEnabled: boolean;
    switches: Record<"runtime" | "worker" | "model" | "tools", {
      configured: boolean;
      enabled: boolean;
      status: "enabled" | "disabled" | "missing" | "invalid";
    }>;
    generationSubmit: {
      enabled: boolean;
      ready: boolean;
      missingVariables: string[];
    };
  };
};

export type UpdateAgentRoleConfigInput = {
  promptRef: AgentRuntimeConfigRef;
  skillRefs: AgentRuntimeConfigRef[];
  modelProfileRef: AgentRuntimeConfigRef;
  modelAliasOverride: string | null;
  temperatureMilli: number;
  maxOutputTokens: number;
  enabled: boolean;
  expectedRevision: number;
};

export type UpdateAgentRoleConfigResult = {
  config: AgentRoleRuntimeConfig;
};

export type AgentRuntimeConfigStepUpResult = {
  proof: string;
  scope: "admin.agent_runtime_config";
  expiresAt: number;
  method: "password" | "totp" | "recovery";
};
