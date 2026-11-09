import type { Knex } from "knex";

import { isPostgresClient } from "@/lib/dbDialect";

export class QuickCreateVideoMutationFenceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QuickCreateVideoMutationFenceError";
  }
}

/**
 * Serializes the first local-video write with project-scoped durable mutations.
 * The project row is always locked first, followed by the exact production
 * track. Deletion uses the same project-first order, so either the generator
 * publishes its durable checkpoint before deletion inspects active commands,
 * or generation observes that deletion already removed/deactivated its target.
 */
export async function lockActiveQuickCreateVideoTarget(
  transaction: Knex.Transaction,
  input: {
    workspaceId: string;
    projectId: number;
    scriptId: number;
    trackId: number;
  },
): Promise<void> {
  let projectQuery = transaction("o_project")
    .where({
      id: input.projectId,
      workspaceId: input.workspaceId,
      deletionState: "active",
    })
    .select("id");
  if (isPostgresClient(transaction)) projectQuery = projectQuery.forUpdate();
  if (!await projectQuery.first()) {
    throw new QuickCreateVideoMutationFenceError(
      409,
      "quick_create_target_not_active",
      "项目正在删除或已不可用，不能启动视频生成任务",
    );
  }

  let trackQuery = transaction("o_videoTrack")
    .where({
      id: input.trackId,
      projectId: input.projectId,
      scriptId: input.scriptId,
    })
    .select("id");
  if (isPostgresClient(transaction)) trackQuery = trackQuery.forUpdate();
  if (!await trackQuery.first()) {
    throw new QuickCreateVideoMutationFenceError(
      409,
      "quick_create_target_not_active",
      "镜头已删除或不属于当前剧本，不能启动视频生成任务",
    );
  }
}
