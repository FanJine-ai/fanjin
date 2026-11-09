import type { Knex } from "knex";
import { quoteSqlIdentifier, tableIndexRows } from "@/lib/dbDialect";

export const USER_VIDEO_ENHANCE_TASK_TABLE = "o_user_video_enhance_task";

const WORKSPACE_TIME_INDEX = "idx_o_user_video_enhance_task_ws_time";
const WORKSPACE_IDEMPOTENCY_INDEX = "uniq_o_user_video_enhance_task_ws_idem";

/**
 * 创作台用户画质增强任务(路径 B,2026-07-19 video-fulfillment-recipes §4.4)。
 * 与 relay 内部生成后增强(路径 A)分表:relay 的 o_relay_task 计费/轮询均
 * 假定 endpointType=video_generation,用户增强任务独立成行
 * (kind=user_video_enhance),billingSubject=video_enhance 单独冻结/结算。
 */
export async function upUserVideoEnhanceTask(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(USER_VIDEO_ENHANCE_TASK_TABLE))) {
    await trx.schema.createTable(USER_VIDEO_ENHANCE_TASK_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("kind").notNullable().defaultTo("user_video_enhance");
      table.text("workspaceId").notNullable();
      table.bigInteger("userId");
      table.text("sourceAssetId");
      table.text("sourceUrl").notNullable();
      table.text("sourceResolution").notNullable();
      table.text("targetResolution").notNullable();
      table.bigInteger("durationSeconds").notNullable().defaultTo(0);
      table.text("enhanceChannelId");
      table.text("provider");
      table.text("providerTaskId");
      // created | enhancing | succeeded | failed
      table.text("status").notNullable().defaultTo("created");
      table.text("quoteJson").notNullable().defaultTo("{}");
      table.text("reservationId");
      table.text("usageRecordId");
      table.text("resultAssetId");
      table.text("resultUrl");
      table.text("errorMessage");
      table.text("idempotencyKey");
      table.text("requestId");
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
    });
  }

  const indexes = await tableIndexRows(trx, USER_VIDEO_ENHANCE_TASK_TABLE);
  if (!indexes.some((index) => index.name === WORKSPACE_TIME_INDEX)) {
    await trx.raw(
      `CREATE INDEX ${quoteSqlIdentifier(WORKSPACE_TIME_INDEX)} ON ${quoteSqlIdentifier(USER_VIDEO_ENHANCE_TASK_TABLE)} (${quoteSqlIdentifier("workspaceId")}, ${quoteSqlIdentifier("createdAt")})`,
    );
  }
  // 幂等重放防重:同一工作区内 idempotencyKey 唯一;NULL 不参与唯一约束
  // (SQLite/Postgres 均允许重复 NULL),未传 key 的请求不受限。
  if (!indexes.some((index) => index.name === WORKSPACE_IDEMPOTENCY_INDEX)) {
    await trx.raw(
      `CREATE UNIQUE INDEX ${quoteSqlIdentifier(WORKSPACE_IDEMPOTENCY_INDEX)} ON ${quoteSqlIdentifier(USER_VIDEO_ENHANCE_TASK_TABLE)} (${quoteSqlIdentifier("workspaceId")}, ${quoteSqlIdentifier("idempotencyKey")})`,
    );
  }
}

export async function downUserVideoEnhanceTask(): Promise<void> {
  throw new Error(
    "Migration user_video_enhance_task cannot be rolled back safely because it would drop user enhance task records tied to billing reservations.",
  );
}
