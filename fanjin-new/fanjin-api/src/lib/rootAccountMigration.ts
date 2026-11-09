import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { hashPassword } from "@/lib/passwordHash";

const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_WORKSPACE_NAME = "Default Workspace";
const DEFAULT_ROOT_PASSWORD = "admin123";

function initialRootPassword(): string {
  const configured = process.env.FANJIN_ROOT_PASSWORD;
  if (configured) return configured;
  if (process.env.FANJIN_ALLOW_DEFAULT_ROOT_PASSWORD !== "1") {
    // 安全加固：不再仅在生产环境拦截。任何环境回落到固定弱口令都必须
    // 显式选择 FANJIN_ALLOW_DEFAULT_ROOT_PASSWORD=1，否则首次启动直接失败。
    throw new Error("首次启动必须设置 FANJIN_ROOT_PASSWORD（或显式设置 FANJIN_ALLOW_DEFAULT_ROOT_PASSWORD=1 使用开发默认口令）");
  }
  return DEFAULT_ROOT_PASSWORD;
}

export async function migrateRootAccount(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    const timestamp = Date.now();
    const userCountRow = await trx<any>("o_user").count({ count: "id" }).first();
    const userCount = Number(userCountRow?.count || 0);

    if (userCount > 0) {
      // This helper runs on every legacy fixDB startup, so an existing
      // installation must be validation-only. Authority repair or root
      // promotion requires a separate, audited break-glass migration.
      const workspace = await trx<any>("o_workspace")
        .where("id", DEFAULT_WORKSPACE_ID)
        .forShare()
        .first();
      if (!workspace) return;
      const owner = await trx<any>("o_user")
        .where({ id: Number(workspace.ownerUserId || 0) })
        .forShare()
        .first();
      const members = await trx<any>("o_workspace_member")
        .where({ workspaceId: DEFAULT_WORKSPACE_ID })
        .orderBy("userId", "asc")
        .forShare()
        .select("*");
      const ownerMembers = members.filter(
        (row: any) => String(row.role || "").toLowerCase() === "owner",
      );
      const authoritative = ownerMembers.find(
        (row: any) => Number(row.userId) === Number(workspace.ownerUserId),
      );
      if (
        !owner
        || ownerMembers.length !== 1
        || !authoritative
        || authoritative.status !== "active"
        || (
          authoritative.permissions !== null
          && authoritative.permissions !== undefined
        )
      ) {
        throw new Error("DEFAULT_WORKSPACE_OWNER_INVARIANT_INVALID");
      }
      return;
    }

    const rootPassword = initialRootPassword();
    await trx<any>("o_user").insert({
      id: 1,
      name: "root",
      email: null,
      displayName: "Root",
      password: await hashPassword(rootPassword),
      passwordChangedAt: timestamp,
      role: "root",
      status: "active",
      currentWorkspaceId: DEFAULT_WORKSPACE_ID,
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastLoginAt: null,
    });

    const workspace = await trx<any>("o_workspace")
      .where("id", DEFAULT_WORKSPACE_ID)
      .forUpdate()
      .first();
    if (!workspace) {
      await trx<any>("o_workspace").insert({
        id: DEFAULT_WORKSPACE_ID,
        name: DEFAULT_WORKSPACE_NAME,
        slug: "default",
        ownerUserId: 1,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    await trx<any>("o_workspace_member").insert({
      id: uuid(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: 1,
      role: "owner",
      status: "active",
      permissions: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
}
