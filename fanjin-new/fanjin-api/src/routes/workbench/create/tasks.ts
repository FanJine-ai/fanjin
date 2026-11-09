import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { syncWorkbenchVideoRelay, videoFileUrl } from "@/lib/workbenchVideoRelay";
import { projectWorkbenchRelayVideoForPublic } from "@/lib/workbenchRelayPublicProjection";
import { collapseQuickCreateTaskRows } from "@/lib/quickCreateTaskList";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import { isCandidateRuntimeReadonlyEvidenceMode } from "@/lib/candidateRuntimeAttestation";
import {
  projectWorkbenchVideoBillingAuditQuarantine,
} from "@/lib/workbenchVideoTaskListProjection";

const router = express.Router();

function normalizeStatus(
  videoState?: string | null,
  relayStatus?: string | null,
  billingState?: string | null,
  errorReason?: string | null,
): string {
  // Generation state never derives from billing status or error text.
  if (relayStatus === "pending_reconcile") return "pending_reconcile";
  if (relayStatus === "cancelled") return "cancelled";
  if (videoState === "生成成功") return "succeeded";
  if (videoState === "生成失败") return "failed";
  if (relayStatus === "succeeded") return "succeeded";
  if (relayStatus === "failed") return "failed";
  if (relayStatus === "queued") return "queued";
  return "running";
}

export default router.post(
  "/",
  requireProjectPermission("project:read"),
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const { projectId } = req.body as { projectId: number };
    const rows = await u
      .db("o_video as video")
      .leftJoin("o_videoTrack as track", "track.id", "video.videoTrackId")
      .leftJoin("o_relay_task as relay", "relay.id", "video.relayTaskId")
      .where("video.projectId", projectId)
      .select(
        "video.id as videoId",
        "video.filePath as filePath",
        "video.errorReason as errorReason",
        "video.time as time",
        "video.state as state",
        "video.scriptId as scriptId",
        "video.projectId as projectId",
        "video.videoTrackId as trackId",
        "video.relayTaskId as relayTaskId",
        "track.prompt as prompt",
        "track.duration as duration",
        "relay.status as relayStatus",
        "relay.requestId as requestId",
        "relay.errorMessage as relayErrorMessage",
      )
      .orderBy("video.time", "desc");

    const data = await Promise.all(
      rows.map(async (row: any) => {
        // Formal readonly evidence must project the checkpointed row exactly.
        // The ordinary convenience sync performs a provider GET and may update
        // relay/video rows, so it is deliberately unreachable in this mode.
        let synced: any = row;
        if (!isCandidateRuntimeReadonlyEvidenceMode()) {
          try {
            synced = await syncWorkbenchVideoRelay({
              id: row.videoId,
              state: row.state,
              relayTaskId: row.relayTaskId,
            });
          } catch (error) {
            synced = projectWorkbenchVideoBillingAuditQuarantine(row, error);
            console.warn("[workbench-video] quarantined invalid billing audit projection", {
              videoId: row.videoId,
              relayTaskId: row.relayTaskId,
            });
          }
        }
        const publicVideo = projectWorkbenchRelayVideoForPublic({
          state: synced.state || row.state,
          // null/empty values explicitly clear obsolete delivery and billing
          // errors; only a missing projection may fall back to the old row.
          filePath: synced.filePath === undefined ? row.filePath : synced.filePath,
          errorReason: synced.errorReason === undefined
            ? row.errorReason || row.relayErrorMessage
            : synced.errorReason,
          relayStatus: synced.relayStatus || row.relayStatus,
        });
        const state = publicVideo.state;
        const relayStatus = publicVideo.relayStatus;
        const persistedMedia = row.relayTaskId && (state === "生成成功" || state === "已完成")
          ? await u.db("o_media_asset")
            .where({ taskId: row.relayTaskId, source: "relay_final" })
            .select("id", "metadata")
            .first()
          : null;
        let persistedLink: Record<string, unknown> = {};
        try {
          persistedLink = persistedMedia?.metadata
            ? JSON.parse(String(persistedMedia.metadata)) as Record<string, unknown>
            : {};
        } catch {
          persistedLink = {};
        }
        const assetId = Number((synced as any).assetId || persistedLink.assetId || 0);
        const assetVersionId = Number(
          (synced as any).assetVersionId || persistedLink.assetVersionId || 0,
        );
        const mediaAssetId = String(
          (synced as any).mediaAssetId || persistedMedia?.id || "",
        ).trim();
        return {
          videoId: row.videoId,
          trackId: row.trackId,
          scriptId: row.scriptId,
          projectId: row.projectId,
          relayTaskId: row.relayTaskId,
          requestId: row.requestId,
          status: normalizeStatus(
            state,
            relayStatus,
            String((synced as any).relayBillingState || ""),
            publicVideo.errorReason,
          ),
          state,
          preparationStage: synced.preparationStage ?? null,
          statusMessage: synced.statusMessage ?? null,
          prompt: row.prompt || "",
          duration: Number(row.duration || 0),
          url: state === "生成成功" || state === "已完成"
            ? await videoFileUrl(publicVideo.filePath)
            : "",
          errorReason: redactSensitiveText(publicVideo.errorReason || ""),
          createdAt: Number(row.time || 0),
          ...(mediaAssetId ? { mediaAssetId } : {}),
          ...(Number.isSafeInteger(assetId) && assetId > 0 ? { assetId } : {}),
          ...(Number.isSafeInteger(assetVersionId) && assetVersionId > 0 ? { assetVersionId } : {}),
        };
      }),
    );

    res.status(200).send(success(collapseQuickCreateTaskRows(data)));
  },
);
