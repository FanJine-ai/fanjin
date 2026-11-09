import { z } from "zod";
import { defineAgentTool } from "@/agent-runtime/tools/registry";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  assertMergeSegmentsPassQualityGate,
  loadMergeableVideoSegments,
  mergeVideoAssetVersions,
  VideoMergeError,
  VIDEO_MERGE_MAX_SEGMENTS,
  VIDEO_MERGE_MIN_SEGMENTS,
} from "@/lib/videoMergeService";

/**
 * 成片拼接工具（AGENTKIT-ADOPTION-CHECKLIST P2 2.3）。
 *
 * R2(资源密集 + 新建资产),审批走 impactSummary 通道(本地计算无供应商
 * 计费,不铸造 GU 报价);可预期的拼接失败映射为 Gateway 安全错误,
 * 以便 Executor 将 merge/storyVideo 终态标记为失败;重试由用户显式发起。
 */
export const VIDEO_MERGE_APPROVAL_POLICY_VERSION = "video-merge-approval-v1";

export const videoMergeInputSchema = z.object({
  assetVersionIds: z.array(z.number().int().positive())
    .min(VIDEO_MERGE_MIN_SEGMENTS)
    .max(VIDEO_MERGE_MAX_SEGMENTS),
  name: z.string().trim().min(1).max(80).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (new Set(value.assetVersionIds).size !== value.assetVersionIds.length) {
    context.addIssue({
      code: "custom",
      path: ["assetVersionIds"],
      message: "拼接段资产版本不能重复",
    });
  }
});

export type VideoMergeInput = z.infer<typeof videoMergeInputSchema>;

export const videoMergeOutputSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  code: z.string().min(1).nullable(),
  message: z.string().min(1).nullable(),
  mediaAssetId: z.string().min(1).nullable(),
  assetId: z.number().int().positive().nullable(),
  assetVersionId: z.number().int().positive().nullable(),
  url: z.string().min(1).nullable(),
  segmentAssetVersionIds: z.array(z.number().int().positive()),
}).strict();

export type VideoMergeOutput = z.infer<typeof videoMergeOutputSchema>;

function successfulVideoMergeOutput(result: {
  mediaAssetId: string;
  assetId: number;
  assetVersionId: number;
  url: string;
  segmentAssetVersionIds: number[];
}): VideoMergeOutput {
  return {
    status: "succeeded",
    code: null,
    message: null,
    mediaAssetId: result.mediaAssetId,
    assetId: result.assetId,
    assetVersionId: result.assetVersionId,
    url: result.url,
    segmentAssetVersionIds: result.segmentAssetVersionIds,
  };
}

export const VIDEO_MERGE_TOOL = defineAgentTool({
  // Downloading up to 20 segments, ffmpeg, and object upload must never hold a
  // PostgreSQL pool connection or SQLite's only writer transaction.
  executionMode: "detached",
  manifest: {
    name: "video.merge",
    version: "1.0.0",
    displayName: "拼接视频成片",
    description: "把同一项目内多段视频资产版本按输入顺序拼接为完整成片,并写入项目资产库(R2,需用户批准后执行)。"
      + "正例:storyVideo 管线的全部过渡段生成完成后,按顺序传入各段 assetVersionId 拼接成片;"
      + "负例:只想预览时不要调用;各段必须属于当前项目且已完成;拼接不会修改原片段,失败时不会产生新资产。",
    riskClass: "R2",
    availability: { state: "available", sincePhase: "A4" },
    requiredPermissions: ["project:read", "generation:create"],
    resourceTypes: ["media_asset", "asset"],
    mutatesState: true,
    metered: false,
  },
  inputSchema: videoMergeInputSchema,
  outputSchema: videoMergeOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    // 证据相位只做只读校验(归属/类型/数量/质量门);ffmpeg 与文件副作用推迟到执行。
    const segments = await loadMergeableVideoSegments({
      database: context.database,
      projectId: context.projectId,
      assetVersionIds: input.assetVersionIds,
    }).catch((error) => {
      if (error instanceof VideoMergeError) {
        throw new AgentToolGatewayError(error.code, error.message, { status: error.status });
      }
      throw error;
    });
    // 强制质量门:拼接段存在未处理 attention 结论时 fail-closed,不进入审批。
    await assertMergeSegmentsPassQualityGate({
      database: context.database,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      segments,
    }).catch((error) => {
      if (error instanceof VideoMergeError) {
        throw new AgentToolGatewayError(error.code, error.message, { status: error.status });
      }
      throw error;
    });
    return {
      impactSummary: {
        summary: `拼接 ${segments.length} 段视频为完整成片并写入项目资产库`,
        affectedResourceRefs: segments.map((segment) => `asset_version:${segment.assetVersionId}`),
        destructive: false,
      },
      policyVersion: VIDEO_MERGE_APPROVAL_POLICY_VERSION,
    };
  },
  async execute(input, context): Promise<VideoMergeOutput> {
    try {
      if (
        !context.assertDetachedExecutionFence
        || !context.recordDetachedDomainCommit
      ) {
        throw new AgentToolGatewayError(
          "detached_execution_fence_unavailable",
          "拼接执行的 detached 安全栅栏或领域提交回执不可用",
          { status: 500 },
        );
      }
      const result = await mergeVideoAssetVersions({
        database: context.durableDatabase ?? context.database,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorUserId: context.actorUserId,
        runId: context.runId,
        stepId: context.stepId,
        assetVersionIds: input.assetVersionIds,
        now: context.now,
        assertDetachedExecutionFence: context.assertDetachedExecutionFence,
        recordDetachedDomainCommit: async (transaction, committed) => {
          await context.recordDetachedDomainCommit!(
            transaction,
            successfulVideoMergeOutput(committed),
          );
        },
      });
      return successfulVideoMergeOutput(result);
    } catch (error) {
      if (error instanceof VideoMergeError) {
        throw new AgentToolGatewayError(error.code, error.message, { status: error.status });
      }
      throw error;
    }
  },
});
