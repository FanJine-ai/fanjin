import { apiGet, apiPost, type ApiRequestOptions } from "../../../api/http";
import {
  apiPostWithStepUp,
  stepUpRequestOptions,
  withStepUpProofs,
  type StepUpScope,
} from "../../../api/stepUp";
import type { ChangeOwnerTenantInput, CreateUserInput, UpdateUserInput, UserAttributionDetail, UsersListInput, UsersListPayload } from "./types";

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) return (value as { data?: unknown }).data;
  return value;
}

export async function listAdminUsers(input: UsersListInput, options?: ApiRequestOptions): Promise<UsersListPayload> {
  const payload = unwrap(await apiPost<unknown>("/admin/users/list", { ...input }, undefined, options));
  if (!payload || typeof payload !== "object") return { items: [], total: 0, pageNum: input.pageNum, pageSize: input.pageSize };
  const value = payload as Partial<UsersListPayload>;
  return {
    items: Array.isArray(value.items) ? value.items : [],
    total: Number(value.total || 0),
    pageNum: Number(value.pageNum || input.pageNum),
    pageSize: Number(value.pageSize || input.pageSize),
    summary: value.summary || {},
  };
}

export function createAdminUser(input: CreateUserInput) {
  return apiPostWithStepUp("/admin/users/create", { ...input }, "admin.user.create");
}

export type ScopedAdminUserUpdate = {
  input: UpdateUserInput;
  scope: Extract<StepUpScope, "admin.user.profile" | "admin.user.status" | "admin.user.role" | "admin.user.commercial">;
};

export async function updateAdminUserCategories(operations: ScopedAdminUserUpdate[]) {
  if (!operations.length) return [];
  return withStepUpProofs(
    operations.map((operation) => operation.scope),
    (proof, index) => apiPost("/admin/users/update", { ...operations[index].input }, undefined, stepUpRequestOptions(proof)),
    operations.length > 1 ? `本次用户变更将按 ${operations.length} 个安全类别分别提交。验证成功后会依次执行。` : undefined,
  );
}

export async function updateAdminUsersStatus(userIds: number[], status: "active" | "disabled") {
  const failed: Array<{ userId: number; reason: unknown }> = [];
  await withStepUpProofs(
    userIds.map(() => "admin.user.status" as const),
    async (proof, index) => {
      const userId = userIds[index];
      try {
        await apiPost("/admin/users/update", { userId, status }, undefined, stepUpRequestOptions(proof));
      } catch (reason) {
        failed.push({ userId, reason });
      }
    },
    `将批量更新 ${userIds.length} 个用户的账号状态。`,
  );
  return { succeeded: userIds.length - failed.length, failed };
}

// ---------------------------------------------------------------------------
// 0.1.4 用户租户归属
// ---------------------------------------------------------------------------

export function fetchUserAttribution(userId: number): Promise<UserAttributionDetail> {
  return apiGet<UserAttributionDetail>(`/admin/users/${userId}/commercial-attribution`);
}

export function changeUserOwnerTenant(userId: number, input: ChangeOwnerTenantInput) {
  return apiPostWithStepUp(
    `/admin/users/${userId}/commercial-attribution/change-owner`,
    { ...input },
    "admin.user.attribution",
    `调整用户 ${userId} 的当前所属租户为 ${input.ownerTenantId}`,
  );
}
