import crypto from "node:crypto";
import type { Knex } from "knex";

import { isPostgresClient } from "@/lib/dbDialect";
import { PORTRAIT_IMAGEX_REVIEW_JOB_TABLE } from "@/lib/migrations/portraitAssetAdmission";
import {
  encodeProviderChannelImageXReviewCredential,
  type ProviderChannelImageXReviewCredential,
} from "@/lib/providerChannelCredentials";

export const PORTRAIT_IMAGEX_CREDENTIAL_BOUND_JOB_STATES = Object.freeze([
  "prepared",
  "submitting",
  "polling",
  // Unknown submissions remain bound until reconciliation or explicit service
  // replacement closes local processing while preserving that unknown outcome.
  "submission_unknown",
] as const);

export const POSTGRES_PORTRAIT_IMAGEX_CHANNEL_MUTATION_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))";
const PORTRAIT_IMAGEX_CHANNEL_MUTATION_LOCK_NAMESPACE =
  "fanjin-portrait-imagex-channel";

/**
 * Serialize one channel's credential generation with creation of review jobs
 * that snapshot that generation. The transaction-local lock is a PostgreSQL
 * fleet fence; SQLite remains protected by its single-writer transaction.
 */
export async function acquirePortraitImageXChannelMutationLock(
  client: Knex | Knex.Transaction,
  channelId: string,
): Promise<void> {
  if (!isPostgresClient(client)) return;
  await client.raw(POSTGRES_PORTRAIT_IMAGEX_CHANNEL_MUTATION_LOCK_SQL, [
    PORTRAIT_IMAGEX_CHANNEL_MUTATION_LOCK_NAMESPACE,
    channelId,
  ]);
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function providerChannelImageXReviewCredentialChanged(
  current: ProviderChannelImageXReviewCredential | null,
  submitted: ProviderChannelImageXReviewCredential,
): boolean {
  if (!current) return true;
  return !constantTimeTextEqual(
    encodeProviderChannelImageXReviewCredential(current),
    encodeProviderChannelImageXReviewCredential(submitted),
  );
}

/**
 * Lock and detect one exact channel/current-generation job that still depends
 * on the old ImageX identity. No job id, state, or credential is returned to
 * callers, keeping the Admin error surface deliberately non-sensitive.
 */
export async function hasCredentialBoundPortraitImageXReviewJob(input: {
  transaction: Knex.Transaction;
  channelId: string;
  credentialGeneration: number;
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.credentialGeneration) || input.credentialGeneration < 1) {
    return false;
  }
  const query = input.transaction(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
    .where({
      channelId: input.channelId,
      credentialGeneration: input.credentialGeneration,
    })
    .whereIn("state", PORTRAIT_IMAGEX_CREDENTIAL_BOUND_JOB_STATES)
    .orderBy("id", "asc")
    .select("id")
    .first();
  if (isPostgresClient(input.transaction)) query.forUpdate();
  return Boolean(await query);
}

/** Close local processing when an operator replaces a service. Unknown
 * upstream outcomes stay explicit in the evidence; they are never resubmitted.
 * A live worker lease must finish first so credentials cannot change mid-call. */
export async function closeImageXJobsForReplacement(input: {
  transaction: Knex.Transaction;
  channelId: string;
  credentialGeneration: number;
  now?: number;
}): Promise<number> {
  const now = input.now ?? Date.now();
  const query = input.transaction(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
    .where({ channelId: input.channelId, credentialGeneration: input.credentialGeneration })
    .whereIn("state", PORTRAIT_IMAGEX_CREDENTIAL_BOUND_JOB_STATES).orderBy("id");
  if (isPostgresClient(input.transaction)) query.forUpdate();
  const jobs = await query;
  if (jobs.some(job => job.leaseOwner && Number(job.leaseExpiresAt) > now)) {
    const error = new Error("ImageX 检查正在执行，请等待当前请求完成后保存");
    Object.assign(error, { code: "IMAGEX_ACTIVE_REQUEST", status: 409 });
    throw error;
  }
  const hasAdmissions = await input.transaction.schema.hasTable("o_portrait_admission");
  for (const job of jobs) {
    const reason = job.state === "prepared"
      ? "IMAGEX_SERVICE_REPLACED_NOT_SUBMITTED"
      : "IMAGEX_SERVICE_REPLACED_OUTCOME_UNKNOWN";
    const evidence = {
      version: "imagex-service-replacement/v1", jobId: job.id,
      channelId: job.channelId, credentialGeneration: Number(job.credentialGeneration),
      previousState: job.state, previousEvidenceHash: job.resultEvidenceHash ?? null,
      reason, closedAt: now,
    };
    await input.transaction(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({ id: job.id }).update({
      state: "failed", safeReasonCode: reason,
      resultEvidenceHash: crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
      leaseOwner: null, leaseExpiresAt: null, completedAt: now, updatedAt: now,
      revision: Number(job.revision || 0) + 1,
    });
    if (hasAdmissions) {
      await input.transaction("o_portrait_admission")
        .where({ currentImageXReviewJobId: job.id })
        .whereIn("moderationState", ["pending", "checking", "failed"])
        .update({ moderationState: "failed", moderationReasonCode: "imagex_service_replaced",
          safeErrorCode: reason, safeErrorMessage: "审核服务已更新，请重新上传素材进行检查",
          updatedAt: now, revision: input.transaction.raw('"revision" + 1') });
    }
  }
  return jobs.length;
}
