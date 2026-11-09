import express from "express";
import { z } from "zod";
import { AgentRuntimeConfigService } from "@/agent-runtime/agentRuntimeConfigService";
import { resolveAgentChatRunModel } from "@/agent-runtime/agentChatBilling";
import { A4_DELEGATION_PARENT_POLICY_SNAPSHOT } from "@/agent-runtime/delegationContracts";
import { toAgentMessageDto, toAgentRunDto } from "@/agent-runtime/dto";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import {
  AGENT_MESSAGE_ASSET_REF_LIMIT,
  agentMessageGenerationPreferencesInputSchema,
  resolveAgentMessageContextSnapshot,
} from "@/agent-runtime/messageContextSnapshot";
import {
  getAgentRuntimeModelAlias,
  getAgentRuntimeWorkerMaxAttempts,
  isAgentRuntimeDelegationEnabled,
  isAgentRuntimeExecutionConfigured,
  isAgentRuntimeModelEnabled,
  isAgentRuntimePersistenceOnlyEnabled,
  isAgentRuntimeToolsEnabled,
  isAgentRuntimeWorkerEnabled,
  requireAgentRuntimeDelegationSigningSecret,
  requireAgentRuntimePreview,
} from "@/agent-runtime/featureFlags";
import { assertAgentProjectAccess, getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { agentSuccess, requireResource, sendAgentRuntimeError } from "@/agent-runtime/http";
import {
  getAgentMessage,
  getAgentRun,
  getAgentThread,
  listAgentMessages,
  listAgentSteps,
} from "@/agent-runtime/repository";
import { assertAgentSafeRetryAllowed } from "@/agent-runtime/safeRetry";
import {
  buildAgentMessageContent,
  normalizeAgentMessageAttachments,
  queueAgentUserMessage,
  resolveAgentMessageSkillRefs,
} from "@/agent-runtime/service";
import { isMainAgentModelToolPromptVersion } from "@/agent-runtime/modelToolExposure";
import {
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_PROMPT_KEY,
  createAgentRuntimeConfigSnapshotFromSelection,
  defaultAgentChatModel,
  findAgentChatModel,
  resolveAgentRuntimeConfigSnapshot,
} from "@/agent-runtime/runtimeConfigRegistry";
import { probeAgentRuntimeWorkerReadiness } from "@/agent-runtime/workerReadiness";
import { db } from "@/utils/db";

const router = express.Router({ mergeParams: true });
router.use(requireAgentRuntimePreview);

const contentPartSchema = z.object({ type: z.literal("text"), text: z.string() });
// 真附件(REVAMP-PLAN 4.4):图 ≤4、文件 ≤2;URL 形式做长度与协议校验,
// 二进制上传与 10MB 限制走既有资产上传通道(assetRef 形式)。
const attachmentSchema = z.object({
  kind: z.enum(["image", "file"]),
  name: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1).max(2_048).regex(/^https?:\/\/\S+$/i, "附件 url 必须是 http(s) 链接").optional(),
  assetRef: z.string().trim().min(1).max(200).optional(),
}).strict().refine((value) => Boolean(value.url || value.assetRef), {
  message: "附件必须提供 url 或 assetRef",
});
const attachmentsSchema = z.array(attachmentSchema).max(6).superRefine((value, ctx) => {
  const images = value.filter((attachment) => attachment.kind === "image").length;
  const files = value.filter((attachment) => attachment.kind === "file").length;
  if (images > 4) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "图片附件最多 4 个", path: ["attachments"] });
  }
  if (files > 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "文件附件最多 2 个", path: ["attachments"] });
  }
});
// 真技能(REVAMP-PLAN 4.3):技能选择随 Run 传入,version 缺省取最高版本;
// 存在性校验(未知 400)在 service 层完成。
const skillRefSchema = z.object({
  key: z.string().trim().min(1).max(100),
  version: z.string().trim().min(1).max(50).optional(),
}).strict();
const contextSnapshotInputSchema = z.object({
  assetRefs: z.array(z.object({
    assetId: z.number().int().positive(),
  }).strict()).max(AGENT_MESSAGE_ASSET_REF_LIMIT).optional(),
  style: z.string().trim().max(2_000).nullable().optional(),
  generationPreferences: agentMessageGenerationPreferencesInputSchema.optional(),
}).strict();
export const sendSchema = z.object({
  clientMessageId: z.string().trim().min(1).max(200),
  retryOfRunId: z.string().uuid().optional(),
  content: z.array(contentPartSchema).min(1).max(50),
  model: z.string().trim().min(1).max(100).optional(),
  attachments: attachmentsSchema.optional(),
  skillRefs: z.array(skillRefSchema).max(5).optional(),
  contextSnapshot: contextSnapshotInputSchema.optional(),
}).strict();
export const listSchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get("/", async (req, res) => {
  try {
    const parsed = listSchema.safeParse(req.query ?? {});
    if (!parsed.success) return res.status(400).send({ code: "invalid_request", message: "参数错误", errors: parsed.error.issues });
    const actor = getAgentRequestActor(req);
    const thread = requireResource(
      await getAgentThread({ id: String((req.params as any).id || ""), workspaceId: actor.workspaceId }),
      "thread_not_found",
      "Agent Thread 不存在",
    );
    await assertAgentProjectAccess(req, thread.projectId, "project:read");
    const page = await listAgentMessages({
      threadId: thread.id,
      workspaceId: actor.workspaceId,
      visibility: "user",
      after: parsed.data.after,
      limit: parsed.data.limit,
    });
    return res.status(200).send(agentSuccess({
      data: page.data.map(toAgentMessageDto),
      nextCursor: page.nextCursor,
    }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

router.post("/", async (req, res) => {
  try {
    const parsed = sendSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).send({ code: "invalid_request", message: "参数错误", errors: parsed.error.issues });
    const actor = getAgentRequestActor(req);
    const thread = requireResource(
      await getAgentThread({ id: String((req.params as any).id || ""), workspaceId: actor.workspaceId }),
      "thread_not_found",
      "Agent Thread 不存在",
    );
    await assertAgentProjectAccess(req, thread.projectId, "project:write");
    let safeRetryContextDigest: string | undefined;
    if (parsed.data.retryOfRunId) {
      const sourceRun = requireResource(
        await getAgentRun({ id: parsed.data.retryOfRunId, workspaceId: actor.workspaceId }),
        "agent_safe_retry_source_not_found",
        "安全重试来源 Run 不存在",
      );
      const [sourceMessage, sourceStepPage] = await Promise.all([
        getAgentMessage({ id: sourceRun.triggerMessageId, workspaceId: actor.workspaceId }),
        listAgentSteps({
          runId: sourceRun.id,
          workspaceId: actor.workspaceId,
          after: 0,
          // Two rows are sufficient to prove the safe-retry contract's
          // "exactly one prepared model step" upper bound.
          limit: 2,
        }),
      ]);
      const normalizedAttachments = normalizeAgentMessageAttachments(parsed.data.attachments);
      const incomingContent = buildAgentMessageContent(parsed.data.content, normalizedAttachments);
      const resolvedSkillRefs = resolveAgentMessageSkillRefs(parsed.data.skillRefs);
      const incomingContext = await resolveAgentMessageContextSnapshot({
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        threadId: thread.id,
        context: parsed.data.contextSnapshot,
        attachments: normalizedAttachments,
        skills: resolvedSkillRefs,
      });
      assertAgentSafeRetryAllowed({
        sourceRun,
        sourceMessage: requireResource(
          sourceMessage,
          "agent_safe_retry_message_not_found",
          "安全重试来源消息不存在",
        ),
        sourceSteps: sourceStepPage.data,
        threadId: thread.id,
        clientMessageId: parsed.data.clientMessageId,
        incomingContent,
        incomingContextDigest: incomingContext.snapshot.digest,
        incomingChatModelId: parsed.data.model ?? defaultAgentChatModel().id,
      });
      safeRetryContextDigest = incomingContext.snapshot.digest;
    }
    const roleConfig = await new AgentRuntimeConfigService(db).getRoleConfig("main");
    // Keep the environment alias as a backwards-compatible deployment override
    // until an explicit database role configuration has been saved.
    const selectedConfig = roleConfig.source === "registry"
      ? { ...roleConfig, resolvedModelAlias: getAgentRuntimeModelAlias() }
      : roleConfig;
    // 用户选择或当前默认模型都固定进本次 Run 的配置快照，保证界面显示、
    // Worker 派发与计费使用同一个解析结果。
    const requestedChatModelId = parsed.data.model ?? null;
    const chatModel = await resolveAgentChatRunModel({
      workspaceId: actor.workspaceId,
      chatModelId: requestedChatModelId,
    });
    const shouldPinCatalogModel = Boolean(requestedChatModelId) || chatModel.source !== "legacy";
    const chatModelConfig = shouldPinCatalogModel
      ? {
          ...selectedConfig,
          resolvedModelAlias: chatModel.definition.modelAlias,
          temperatureMilli: chatModel.definition.temperatureMilli,
          maxOutputTokens: chatModel.definition.maxOutputTokens,
        }
      : selectedConfig;
    const agentConfig = createAgentRuntimeConfigSnapshotFromSelection(chatModelConfig);
    const runtimeModelEnabled = isAgentRuntimeModelEnabled();
    const runtimeWorkerEnabled = isAgentRuntimeWorkerEnabled();
    const executionConfigured = isAgentRuntimeExecutionConfigured();
    const persistenceOnlyEnabled = isAgentRuntimePersistenceOnlyEnabled();
    const runtimeDelegationEnabled = isAgentRuntimeDelegationEnabled();
    if (runtimeDelegationEnabled) requireAgentRuntimeDelegationSigningSecret();
    if (runtimeModelEnabled && !runtimeWorkerEnabled) {
      throw new AgentRuntimeError(
        503,
        "agent_worker_unavailable",
        "主 Agent 模型已开启，但执行 Worker 未开启",
      );
    }
    if (!executionConfigured && !persistenceOnlyEnabled) {
      throw new AgentRuntimeError(
        503,
        "agent_execution_unavailable",
        "主 Agent 执行服务当前不可用",
      );
    }
    if (executionConfigured) {
      const workerReadiness = await probeAgentRuntimeWorkerReadiness(db as any);
      if (!workerReadiness.ready) {
        throw new AgentRuntimeError(
          503,
          "agent_worker_unavailable",
          "Agent 专用执行 Worker 当前不可用，请稍后重试",
        );
      }
    }
    if (executionConfigured && !agentConfig.execution?.enabled) {
      throw new AgentRuntimeError(409, "agent_role_disabled", "主 Agent 当前已被管理员停用");
    }
    const modelEnabled = executionConfigured && agentConfig.execution?.enabled === true;
    const resolvedAgentConfig = resolveAgentRuntimeConfigSnapshot(agentConfig, "main");
    const toolsEnabled = modelEnabled
      && isAgentRuntimeToolsEnabled()
      && resolvedAgentConfig.prompt.key === AGENT_MAIN_PROMPT_KEY
      && isMainAgentModelToolPromptVersion(resolvedAgentConfig.prompt.version)
      && resolvedAgentConfig.modelProfile.capabilities.includes("tools");
    const delegationEnabled = toolsEnabled
      && runtimeDelegationEnabled
      && resolvedAgentConfig.prompt.key === AGENT_MAIN_PROMPT_KEY
      && (resolvedAgentConfig.prompt.version === AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION
        || resolvedAgentConfig.prompt.version === AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION);
    // Resolve once per request so the service persists an immutable Run-local
    // recovery budget even if deployment configuration later changes.
    const recoveryMaxAttempts = getAgentRuntimeWorkerMaxAttempts();
    const result = await queueAgentUserMessage({
      workspaceId: actor.workspaceId,
      threadId: thread.id,
      clientMessageId: parsed.data.clientMessageId,
      content: parsed.data.content,
      createdBy: actor.userId,
      recoveryMaxAttempts,
      chatModelId: requestedChatModelId,
      resolvedChatModel: chatModel,
      attachments: parsed.data.attachments,
      skillRefs: parsed.data.skillRefs,
      contextSnapshot: parsed.data.contextSnapshot,
      requiredContextDigest: safeRetryContextDigest,
      policySnapshot: {
        ...(parsed.data.retryOfRunId ? { safeRetryOfRunId: parsed.data.retryOfRunId } : {}),
        phase: delegationEnabled
          ? "A4-delegation"
          : toolsEnabled
            ? "A3-tool-loop"
            : modelEnabled
              ? "A1-text-model"
              : "A1-persistence-only",
        toolsEnabled,
        delegationEnabled,
        ...(delegationEnabled ? { delegation: A4_DELEGATION_PARENT_POLICY_SNAPSHOT } : {}),
        modelEnabled,
        modelAlias: agentConfig.execution?.modelAlias,
        agentConfig,
      },
    });
    return res.status(result.replayed ? 200 : 202).send(agentSuccess({
      threadId: thread.id,
      message: toAgentMessageDto(result.message),
      run: toAgentRunDto(result.run),
      replayed: result.replayed,
    }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
