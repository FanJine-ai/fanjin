import { addAssetToProject } from "../../api/assets";
import { ApiError } from "../../api/http";
import { ensureAgentThread, listAgentChatModels, sendAgentTextMessage } from "../../features/agent-runtime/api";
import { resolveAgentMessageAttachments } from "../../features/agent-runtime/attachments";
import type { AgentMessageGenerationPreferences, AgentMessageSkillRefInput } from "../../features/agent-runtime/types";
import { buildProjectModeHref } from "../../routes/projectModeRoutes";
import { resolveAgentSurfaceExecutionState } from "../generate/generateCatalog";
import {
  clearPendingAgentSubmission,
  isDefinitiveAgentClientError,
  pendingAgentSubmissionKey,
  writePendingAgentSubmission,
} from "../generate/generateSubmissionRecovery";

export type QuickCreateAgentReference = {
  assetId: number;
  assetVersionId: number;
  name: string;
  kind: string;
};

/** Submit the first turn before navigating. The destination only restores the
 * server thread, so refresh/remount cannot send the first paid turn twice. */
export async function startQuickCreateAgent(input: {
  scope: string;
  projectId: number | null;
  brief: string;
  model: string;
  style: string;
  references: QuickCreateAgentReference[];
  assets: Array<{ assetId: number; assetVersionId?: number }>;
  skillRefs: AgentMessageSkillRefInput[];
  generationPreferences?: AgentMessageGenerationPreferences;
  idempotencyKey: string;
  assertCurrent: () => void;
}) {
  const catalog = await listAgentChatModels();
  input.assertCurrent();
  const runtime = resolveAgentSurfaceExecutionState(catalog);
  if (!runtime.conversationAvailable) {
    throw new Error(catalog.message || "Agent 对话暂不可用，请稍后重试");
  }
  const model = runtime.models.find((candidate) => candidate.id === input.model);
  if (!model) throw new Error("所选对话模型暂不支持 Agent，请选择其他对话模型");
  const resolved = await resolveAgentMessageAttachments([], {
    projectId: input.projectId,
    persistedReferences: input.references.map((reference) => ({
      ...reference,
      assetVersionId: String(reference.assetVersionId),
    })),
  });
  if (resolved.skipped.length) {
    throw new Error(`这些参考素材暂不能随 Agent 对话发送，请调整后再试：${resolved.skipped.join("、")}`);
  }
  input.assertCurrent();
  const preference = input.generationPreferences;
  const ensured = await ensureAgentThread({
    projectId: input.projectId,
    projectName: input.brief.slice(0, 60),
    title: input.brief.slice(0, 60),
    goal: input.brief.slice(0, 4_000),
    parameters: {
      agentChatModel: model.id,
      style: input.style,
      ...(preference ? {
        outputType: preference.generationType,
        ratio: preference.ratio,
        ...(preference.generationType === "image" ? {
          imageModel: preference.model, imageQuality: preference.quality, imageCount: preference.count,
        } : {
          videoModel: preference.model, resolution: preference.resolution,
          videoMode: preference.mode, videoDuration: preference.duration, videoAudio: preference.generateAudio,
        }),
      } : {}),
    },
    idempotencyKey: input.idempotencyKey,
  });
  input.assertCurrent();
  const assets = new Map([...input.assets, ...input.references].map((asset) => [asset.assetId, asset]));
  // Home uploads belong to a temporary inspiration project. Explicitly attach
  // their existing versions to the Agent project; do not upload or audit again.
  for (const asset of assets.values()) {
    input.assertCurrent();
    await addAssetToProject({
      projectId: ensured.project.id,
      assetId: asset.assetId,
      ...(asset.assetVersionId ? { assetVersionId: `image:${asset.assetVersionId}` } : {}),
      idempotencyKey: `${input.idempotencyKey}:asset:${asset.assetId}`,
    });
  }
  input.assertCurrent();
  const storageKey = pendingAgentSubmissionKey(input.scope, ensured.project.id);
  const clientMessageId = `${input.idempotencyKey}:first-turn`;
  writePendingAgentSubmission(storageKey, {
    projectId: ensured.project.id,
    brief: input.brief,
    idempotencyKey: input.idempotencyKey,
    clientMessageId,
    threadId: ensured.thread.id,
    createdAt: Date.now(),
  });
  let pending = false;
  try {
    await sendAgentTextMessage({
      threadId: ensured.thread.id,
      clientMessageId,
      text: input.brief,
      model: model.id,
      attachments: resolved.attachments,
      skillRefs: input.skillRefs,
      contextSnapshot: {
        assetRefs: [...assets.keys()].map((assetId) => ({ assetId })),
        style: input.style.trim() || null,
        ...(input.generationPreferences ? { generationPreferences: input.generationPreferences } : {}),
      },
    });
    clearPendingAgentSubmission(storageKey, clientMessageId);
  } catch (error) {
    if (error instanceof ApiError && isDefinitiveAgentClientError(error)) {
      clearPendingAgentSubmission(storageKey, clientMessageId);
      throw error;
    }
    // An unknown POST outcome must be recovered by GET on the same thread.
    // Never auto-resend or create another conversation to escape the error.
    pending = true;
  }
  return {
    projectId: ensured.project.id,
    pending,
    href: buildProjectModeHref("agent", {
      projectId: ensured.project.id,
      sessionId: ensured.session.id,
      threadId: ensured.thread.id,
    }),
  };
}
