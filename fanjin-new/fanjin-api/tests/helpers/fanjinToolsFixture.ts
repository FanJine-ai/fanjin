import knex from "knex";
import { randomUUID } from "node:crypto";
import { createToolService } from "@/tools/service";
import type { WorkbenchModelCapability, WorkbenchModelCatalog } from "@/lib/workbenchModelCatalog";

export async function createToolsFixture(creationGateway?: import("@/tools/creationService").CreationGateway) {
  const pgUrl = process.env.FANJIN_TOOLS_TEST_POSTGRES_URL;
  if (pgUrl && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(pgUrl).hostname)) throw new Error("Tools test PostgreSQL must use loopback");
  const schema = `tools_test_${randomUUID().replaceAll("-", "")}`;
  const admin = pgUrl ? knex({ client: "pg", connection: pgUrl }) : null;
  if (admin) await admin.schema.createSchema(schema);
  const db = pgUrl ? knex({ client: "pg", connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 8 } }) : knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  const tables: Record<string, { text: string[]; integers?: string[] }> = {
    o_api_key: { text: ["id", "scope", "workspaceId", "permissions", "modelAllowlist", "keyHash", "name", "keyPrefix", "ipAllowlist"], integers: ["ownerUserId", "disabled", "revokedAt", "expiresAt", "lastUsedAt", "updateTime", "quotaLimit", "quotaUsed", "quotaReserved", "rateLimitPerMinute"] },
    o_user: { text: ["status", "role", "password", "currentWorkspaceId", "defaultWorkspaceId"], integers: ["id"] },
    o_workspace: { text: ["id", "status"], integers: ["ownerUserId"] },
    o_workspace_member: { text: ["workspaceId", "status", "role", "permissions"], integers: ["userId"] },
    o_project: { text: ["deletionState", "workspaceId", "name", "projectType", "mode", "intro", "type", "artStyle", "videoRatio", "privateToken"], integers: ["id", "revision", "createTime", "updatedAt"] },
    o_billing_account: { text: ["workspaceId", "balanceMicros", "creditLimitMicros", "reservedMicros", "currency", "status"] },
    o_workflow_graph: { text: ["name", "nodes", "edges", "groups", "viewport", "coverImageUrl"], integers: ["id", "projectId", "updateTime", "revision"] },
  };
  for (const [name, columns] of Object.entries(tables)) {
    await db.schema.createTable(name, (table) => {
      columns.text.forEach((column) => table.text(column));
      columns.integers?.forEach((column) => /(?:At|Time)$/.test(column) ? table.bigInteger(column) : table.integer(column));
    });
  }
  await db("o_user").insert({ id: 1, status: "active", role: "root", password: "fixture-private-password" });
  await db("o_workspace").insert([{ id: "ws-a", status: "active", ownerUserId: 1 }, { id: "ws-b", status: "active", ownerUserId: 2 }]);
  await db("o_workspace_member").insert({ workspaceId: "ws-a", userId: 1, status: "active", role: "owner", permissions: null });
  await db("o_api_key").insert({ id: "key-a", scope: "workspace", workspaceId: "ws-a", ownerUserId: 1, disabled: 0, revokedAt: 0, expiresAt: 0, permissions: '["*"]', modelAllowlist: null });
  await db("o_project").insert([
    { id: 1, workspaceId: "ws-a", name: "Project A", intro: "Synopsis", projectType: "video", mode: "canvas", privateToken: "never-return" },
    { id: 2, workspaceId: "ws-a", name: "Project A2", intro: "Synopsis", projectType: "video", mode: "canvas", privateToken: "never-return" },
    { id: 3, workspaceId: "ws-b", name: "Other tenant", intro: "Private", projectType: "video", mode: "canvas", privateToken: "never-return" },
  ]);
  await db("o_project").update({ deletionState: "active" });
  await db("o_billing_account").insert({ workspaceId: "ws-a", balanceMicros: "1234567890", creditLimitMicros: "3000000000", reservedMicros: "100000000", currency: "GU", status: "active" });
  await db("o_workflow_graph").insert([
    { id: 1, projectId: 1, name: "Canvas A", revision: 1, updateTime: 100, nodes: JSON.stringify([{ id: "n1", type: "image", position: { x: 12, y: 30 }, data: { label: "Draft", prompt: "private-prompt", url: "https://private.example/signed?key=secret" } }]), edges: "[]" },
    { id: 2, projectId: 3, name: "Other canvas", updateTime: 200, nodes: "[]", edges: "[]" },
  ]);
  const image: WorkbenchModelCapability = { id: "image-a", model: "image-upstream", label: "Image A", endpointType: "image_generation", capabilityStatus: "configured", canSubmit: true, aspectRatios: ["1:1", "16:9"], qualities: ["1K", "2K", "4K"], defaultQuality: "2K", source: { kind: "route" } };
  const video: WorkbenchModelCapability = { id: "video-a", model: "video-upstream", label: "Video A", endpointType: "video_generation", capabilityStatus: "unverified", canSubmit: false, aspectRatios: ["16:9"], resolutions: ["720p", "1080p"], duration: { min: 4, max: 30, step: 1, default: 5 }, source: { kind: "route" } };
  const models = [image, video];
  const catalog: WorkbenchModelCatalog = { catalogVersion: "test/v1", models, imageModels: [image], videoModels: [video] };
  const service = createToolService({ database: db, creationGateway, catalog: async (workspaceId) => {
    if (workspaceId !== "ws-a") throw new Error("unexpected workspace");
    return catalog;
  }, now: () => 1000 });
  const connection = { apiKeyId: "key-a", transport: "http" as const };
  return { db, service, connection, catalog, close: async () => { await db.destroy(); if (admin) { await admin.schema.dropSchema(schema, true); await admin.destroy(); } } };
}
