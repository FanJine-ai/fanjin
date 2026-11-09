import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { EXTERNAL_TOOL_TABLE as TABLE } from "./migrations/externalTools";
import { requireLiveWorkspaceAuthority } from "./workspaceAccess";
export const uiStatePatchSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).optional(),
  theme: z.enum(["light", "dark"]).optional(),
  fontSize: z.union([z.literal(12), z.literal(13), z.literal(14), z.literal(16), z.literal(18), z.literal(20), z.literal(22)]).optional(),
  readIds: z.array(z.string().min(1).max(200)).max(2000).optional(),
  unreadIds: z.array(z.string().min(1).max(200)).max(2000).optional(),
  markAllRead: z.boolean().optional(),
});
export type UiState = { revision: number; theme: "light" | "dark" | null; fontSize: number | null; readIds: string[] };
const initial = (): UiState => ({ revision: 0, theme: null, fontSize: null, readIds: [] });
export async function workbenchUiState(database: Knex, identity: { userId: number; workspaceId: string }, patch?: z.infer<typeof uiStatePatchSchema>) {
  return database.transaction(async tx => {
    await requireLiveWorkspaceAuthority({ database: tx, actorUserId: identity.userId, workspaceId: identity.workspaceId,
      authenticatedWorkspaceId: identity.workspaceId, permission: "workspace:read" });
    const key = { kind: "workbench_ui_state", keyId: "workbench-ui-state", workspaceId: identity.workspaceId, userId: identity.userId, idempotencyKey: `user:${identity.userId}` };
    const row = await tx(TABLE).where(key).forUpdate().first();
    const current: UiState = row ? JSON.parse(row.resultJson) : initial();
    if (!patch) return current;
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
      throw Object.assign(new Error("界面设置已更新，请重新读取"), { status: 409, code: "UI_STATE_REVISION_CONFLICT" });
    }
    const unread = new Set(patch.unreadIds || []);
    const next: UiState = { revision: current.revision + 1, theme: patch.theme ?? current.theme, fontSize: patch.fontSize ?? current.fontSize,
      readIds: [...new Set([...current.readIds, ...patch.readIds || []])].filter(id => !unread.has(id)).slice(-2000) };
    if (row) await tx(TABLE).where({ id: row.id }).update({ resultJson: JSON.stringify(next), updatedAt: Date.now() });
    else await tx(TABLE).insert({ ...key, id: randomUUID(), requestHash: "ui-state-v1", requestJson: "{}", status: "succeeded", resultJson: JSON.stringify(next), createdAt: Date.now(), updatedAt: Date.now() });
    return next;
  });
}
