// Workspace API：从旧 Vue 的 src/stores/workspace.ts 迁移。
// 注意：workspace 列表来自会话（/auth/me、登录返回的 workspaces），没有独立 list 接口。
// 切换/创建/更新 workspace 都会返回新的会话结构 { user, workspace, workspaces }。
import { apiPost } from "./http";
import type { AuthSession } from "./types";

export type SwitchWorkspacePayload = {
  workspaceId: string;
};

export type CreateWorkspacePayload = {
  name: string;
  switchTo?: boolean;
  initialAllocationMicros?: number;
};

export type UpdateWorkspacePayload = {
  workspaceId: string;
  name: string;
};

/** POST /workspace/switch → { user, workspace, workspaces }。 */
export function switchWorkspace(payload: SwitchWorkspacePayload): Promise<AuthSession> {
  return apiPost<AuthSession, SwitchWorkspacePayload>("/workspace/switch", payload);
}

/** POST /workspace/create → { user, workspace, workspaces }。 */
export function createWorkspace(payload: CreateWorkspacePayload): Promise<AuthSession> {
  return apiPost<AuthSession, CreateWorkspacePayload>("/workspace/create", {
    switchTo: true,
    ...payload,
  });
}

/** POST /workspace/update → { user, workspace, workspaces }。 */
export function updateWorkspace(payload: UpdateWorkspacePayload): Promise<AuthSession> {
  return apiPost<AuthSession, UpdateWorkspacePayload>("/workspace/update", payload);
}
