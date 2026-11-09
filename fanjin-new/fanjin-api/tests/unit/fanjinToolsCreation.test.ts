import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolsFixture } from "../helpers/fanjinToolsFixture";
import { upExternalTools, EXTERNAL_TOOL_TABLE as T } from "@/lib/migrations/externalTools";
import type { CreationGateway } from "@/tools/creationService";
import { createToolsHttpRouter, createFanjinMcpServer } from "@/tools/transport";
import express from "express";
import request from "supertest";
import { Readable } from "node:stream";
import { generationRequestSchema } from "@/tools/creationContracts";
import { VideoGenerationNotStartedError } from "@/tools/videoDispatchEvidence";
import { ToolError } from "@/tools/contracts";
let f: Awaited<ReturnType<typeof createToolsFixture>>;
const req = { projectId: 1, type: "video", modelId: "video-a", prompt: "海边的日出", aspectRatio: "16:9", resolution: "720p", duration: 5 };
let gateway: CreationGateway;
const run = (name: string, input: any = {}) => f.service.execute(f.connection, name, input);
const data = async (name: string, input: any = {}) => {
  const r = await run(name, input); expect(r.body.error, JSON.stringify(r.body)).toBeUndefined(); return r.body.data as any;
};
async function quoted() { return data("fanjin_generation_quote", { request: req, idempotencyKey: "quote-key-1" }); }
async function approved() {
  const q = await quoted(), a = await data("fanjin_approval_request", { quoteId: q.quoteId, idempotencyKey: "approval-1" });
  await f.service.creation!.decide(1, a.approvalId, "approved", q.quoteId); return { q, a };
}
async function submitted() { const { q, a } = await approved(); return data("fanjin_generation_submit", { quoteId: q.quoteId, approvalId: a.approvalId, idempotencyKey: "submit-1" }); }
beforeEach(async () => {
  gateway = {
    projectCreate: vi.fn(async (_i, name, tx) => { await tx("o_project").insert({ id: 4, workspaceId: "ws-a", name }); return { projectId: 4 }; }),
    quote: vi.fn(async () => ({ maximumCostMicros: 123456789, pricingDigest: "price-a" })),
    generate: vi.fn(async () => ({ relayTaskId: "relay-1", billingStatus: "reserved" })),
    inspect: vi.fn(async () => ({ status: "succeeded", billingStatus: "settled" })),
    archive: vi.fn(async () => ({ assets: [{ assetId: 12, assetVersionId: 15 }], billingStatus: "settled" })),
    assetsList: vi.fn(async () => ({ assets: [] })), assetGet: vi.fn(async () => ({ assetId: 12, assetVersionId: 15, storageKey: "safe-object", status: "active", sizeBytes: 3 })),
    prepareUpload: vi.fn(async () => ({ uploadId: "11111111-1111-4111-8111-111111111111", uploadMode: "proxy" })),
    uploadStatus: vi.fn(async () => ({ status: "uploaded" })), completeUpload: vi.fn(async () => ({ assetId: 12 })),
    writeUpload: vi.fn(async () => ({ sizeBytes: 3 })), download: vi.fn(async () => ({ stream: Readable.from("abc"), sizeBytes: 3, mimeType: "video/mp4" })),
  };
  f = await createToolsFixture(gateway); await f.db.transaction(upExternalTools);
});
afterEach(async () => { await f.close(); });
describe("external creative tools", () => {
  it("discovers creation tools with side effects represented correctly", async () => {
    const info = await data("fanjin_context_get"); expect(info.readOnly).toBe(false);
    expect(info.tools).toEqual(expect.arrayContaining(["fanjin_canvas_graph_edit", "fanjin_canvas_execution_plan", "fanjin_human_continue"]));
    expect(info.tools).toContain("fanjin_portrait_asset_register");
    expect(info.tools).not.toContain("fanjin_approval_approve");
    expect(info.workflows.portraitReferences).toMatchObject({
      workflow: "platform_managed_assets", statusTool: "fanjin_asset_get",
      registrationTool: "fanjin_portrait_asset_register",
      requiresPortraitRelay: false, referenceField: "references[].assetVersionId",
    });
    const server = await createFanjinMcpServer(f.service, { ...f.connection, transport: "mcp" }); await server.close();
  });
  it("creates one project for concurrent identical keys in the same transaction", async () => {
    const results = await Promise.all([data("fanjin_project_create", { name: "测试项目", idempotencyKey: "project-1" }), data("fanjin_project_create", { name: "测试项目", idempotencyKey: "project-1" })]);
    expect(results[0]).toEqual(results[1]); expect(gateway.projectCreate).toHaveBeenCalledTimes(1);
    expect((await run("fanjin_project_create", { name: "其他项目", idempotencyKey: "project-1" })).body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("persists a precise quote without dispatch or reservation", async () => {
    const q = await quoted(); expect(q.maximum).toEqual({ guMicros: "123456789", gu: "1.23456789" }); expect(gateway.generate).not.toHaveBeenCalled();
    expect(await quoted()).toEqual(q); expect(Number((await f.db(T).count({ n: "id" }).first())?.n)).toBe(1);
  });
  it("recovers interrupted upload preparation under its original key only through a durable adapter", async () => {
    const input = { projectId: 1, fileName: "scene.png", assetName: "场景", assetType: "image", mimeType: "image/png", sizeBytes: 3,
      contentHash: "a".repeat(64), idempotencyKey: "upload-recovery-key" };
    vi.mocked(gateway.prepareUpload).mockRejectedValueOnce(new Error("transient storage failure"));
    expect((await run("fanjin_upload_prepare", input)).status).toBe(500);
    expect((await run("fanjin_upload_prepare", input)).body.error?.code).toBe("OPERATION_NEEDS_RECONCILIATION");
    gateway.recoverUploadPreparation = vi.fn(async (_i, _input, tx) => {
      expect(tx?.isTransaction).toBe(true);
      return { uploadId: "11111111-1111-4111-8111-111111111111", uploadMode: "proxy" };
    });
    const recovered = await data("fanjin_upload_prepare", input);
    expect(await data("fanjin_upload_prepare", input)).toEqual(recovered);
    expect(gateway.recoverUploadPreparation).toHaveBeenCalledTimes(1);
    expect(await f.db(T).where({ kind: "fanjin_upload_prepare" })).toHaveLength(1);
    expect((await run("fanjin_upload_prepare", { ...input, sizeBytes: 4 })).body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    await f.db(T).where({ kind: "fanjin_upload_prepare" }).update({ status: "cancelled" });
    expect((await run("fanjin_upload_prepare", input)).body.error?.code).toBe("UPLOAD_PREPARATION_CANCELLED");
    expect(gateway.recoverUploadPreparation).toHaveBeenCalledTimes(1);
    expect(gateway.generate).not.toHaveBeenCalled();
  });
  it("rejects extra identity and provider fields", async () => {
    for (const extra of [{ workspaceId: "ws-b" }, { approved: true }, { provider: "fake" }, { channelId: "secret" }]) {
      expect((await run("fanjin_generation_quote", { request: { ...req, ...extra }, idempotencyKey: "quote-key-1" })).status).toBe(400);
    }
  });
  it("rejects cross-workspace quotes before calling the domain layer", async () => {
    expect((await run("fanjin_generation_quote", { request: { ...req, projectId: 3 }, idempotencyKey: "quote-key-1" })).status).toBe(404);
    expect(gateway.quote).not.toHaveBeenCalled();
  });
  it("requires explicit tool AND current member generation permission", async () => {
    await f.db("o_workspace_member").update({ role: "viewer" }); expect((await run("fanjin_generation_quote", { request: req, idempotencyKey: "quote-key-1" })).status).toBe(403);
    await f.db("o_workspace_member").update({ role: "owner" }); await f.db("o_api_key").update({ permissions: '["project:read"]' });
    expect((await run("fanjin_generation_quote", { request: req, idempotencyKey: "quote-key-1" })).status).toBe(403);
  });
  it("cannot self-approve from MCP or submit a pending approval", async () => {
    const q = await quoted(), a = await data("fanjin_approval_request", { quoteId: q.quoteId, idempotencyKey: "approval-1" });
    expect((await run("fanjin_approval_approve", { approvalId: a.approvalId })).status).toBe(404);
    expect((await run("fanjin_generation_submit", { quoteId: q.quoteId, approvalId: a.approvalId, idempotencyKey: "submit-1" })).body.error?.code).toBe("APPROVAL_REQUIRED");
    await expect(f.service.creation!.decide(99, a.approvalId, "approved", q.quoteId)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
  it("binds approval to the displayed quote and immutable request", async () => {
    const q = await quoted(), a = await data("fanjin_approval_request", { quoteId: q.quoteId, idempotencyKey: "approval-1" });
    await expect(f.service.creation!.decide(1, a.approvalId, "approved", "different-quote")).rejects.toMatchObject({ code: "QUOTE_MISMATCH" });
    expect((await run("fanjin_generation_quote", { request: { ...req, prompt: "不同" }, idempotencyKey: "quote-key-1" })).body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("rechecks key revocation in the human approval handler", async () => {
    const { a, q } = await approved(); await f.db("o_api_key").update({ revokedAt: 1 });
    await expect(f.service.creation!.decide(1, a.approvalId, "approved", q.quoteId)).rejects.toMatchObject({ code: "KEY_UNAVAILABLE" });
  });
  it("rejects expired authorization", async () => {
    const { a, q } = await approved(); await f.db(T).where({ id: a.approvalId }).update({ expiresAt: 1 });
    expect((await run("fanjin_generation_submit", { quoteId: q.quoteId, approvalId: a.approvalId, idempotencyKey: "submit-1" })).body.error?.code).toBe("AUTHORIZATION_EXPIRED");
  });
  it("rejects changed prices before queueing", async () => {
    const { q, a } = await approved(); vi.mocked(gateway.quote).mockResolvedValue({ maximumCostMicros: 999999999, pricingDigest: "changed" });
    expect((await run("fanjin_generation_submit", { quoteId: q.quoteId, approvalId: a.approvalId, idempotencyKey: "submit-1" })).body.error?.code).toBe("QUOTE_CHANGED");
    expect(gateway.generate).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent submits and consumes each quote once", async () => {
    const { q, a } = await approved(), input = { quoteId: q.quoteId, approvalId: a.approvalId, idempotencyKey: "submit-1" };
    const results = await Promise.all([data("fanjin_generation_submit", input), data("fanjin_generation_submit", input)]); expect(results[0].taskId).toBe(results[1].taskId);
    expect((await run("fanjin_generation_submit", { ...input, idempotencyKey: "submit-2" })).status).toBe(403);
    expect(gateway.generate).not.toHaveBeenCalled();
  });
  it("recovers a directly approved MCP submission with the original key", async () => {
    const q = await quoted(), input = { quoteId: q.quoteId, idempotencyKey: "direct-submit" };
    const first = await data("fanjin_generation_submit", input);
    expect(await data("fanjin_generation_submit", input)).toMatchObject({ taskId: first.taskId });
    // Receipts created before approvalMode existed can be verified against
    // their matching server-generated approval, without consuming it again.
    const stored = await f.db(T).where({ id: first.taskId }).first(), original = JSON.parse(stored.requestJson);
    delete original.approvalMode;
    await f.db(T).where({ id: first.taskId }).update({ requestJson: JSON.stringify(original), requestHash: "legacy-hash" });
    expect(await data("fanjin_generation_submit", input)).toMatchObject({ taskId: first.taskId });
    const other = await data("fanjin_generation_quote", { request: req, idempotencyKey: "other-quote" });
    expect((await run("fanjin_generation_submit", { ...input, quoteId: other.quoteId })).body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await f.db(T).where({ kind: "fanjin_generation_submit" })).toHaveLength(1);
    expect(gateway.generate).not.toHaveBeenCalled();
  });
  it("honors an accepted budget after quote expiry without accepting a higher price", async () => {
    const t = await submitted();
    await f.db(T).where({ id: t.taskId }).update({ expiresAt: 1 });
    await f.db(T).where({ kind: "fanjin_generation_quote" }).update({ expiresAt: 1 });
    vi.mocked(gateway.quote).mockResolvedValue({ maximumCostMicros: 100, pricingDigest: "lower-price" });
    await f.service.creation!.tick();
    expect(gateway.generate).toHaveBeenCalledWith(expect.anything(), expect.anything(), 123456789, t.taskId);
    expect((await data("fanjin_task_get", { taskId: t.taskId })).executionStatus).toBe("running");
  });
  it("stops an accepted task if its new price exceeds the stored budget", async () => {
    const t = await submitted();
    vi.mocked(gateway.quote).mockResolvedValue({ maximumCostMicros: 123456790, pricingDigest: "higher-price" });
    await f.service.creation!.tick();
    expect(gateway.generate).not.toHaveBeenCalled();
    expect(await data("fanjin_task_get", { taskId: t.taskId })).toMatchObject({ executionStatus: "failed", billingStatus: "not_started", errorCode: "QUOTE_CHANGED" });
  });
  it("keeps material preparation under the same task until the relay starts and completes generation", async () => {
    const preparing = { relayTaskId: "relay-1", billingStatus: "not_started", executionPhase: "preparing_materials", statusMessage: "正在登记参考素材，通过后自动生成", canCancel: true };
    vi.mocked(gateway.generate).mockResolvedValue(preparing);
    vi.mocked(gateway.inspect).mockResolvedValue({ ...preparing, status: "running" });
    const t = await submitted();
    await f.service.creation!.tick();
    for (let n = 0; n < 3; n++) {
      await f.service.creation!.tick();
      expect(await data("fanjin_task_get", { taskId: t.taskId })).toMatchObject({ executionStatus: "preparing", billingStatus: "not_started", canCancel: true });
    }
    expect((await data("fanjin_task_recover", { idempotencyKey: "submit-1" })).taskId).toBe(t.taskId);
    vi.mocked(gateway.inspect).mockResolvedValue({ status: "running", billingStatus: "reserved", executionPhase: null, canCancel: false });
    await f.service.creation!.tick();
    expect(await data("fanjin_task_get", { taskId: t.taskId })).toMatchObject({ executionStatus: "running", billingStatus: "reserved", canCancel: false });
    vi.mocked(gateway.inspect).mockResolvedValue({ status: "succeeded", billingStatus: "settled" });
    await f.service.creation!.tick(); await f.service.creation!.tick();
    expect(await data("fanjin_task_get", { taskId: t.taskId })).toMatchObject({ executionStatus: "succeeded", storageStatus: "ready" });
    expect(gateway.generate).toHaveBeenCalledTimes(1);
  });
  it("resumes material status polling after a transient outage or interrupted read without redispatch", async () => {
    const preparing = { relayTaskId: "relay-1", billingStatus: "not_started", executionPhase: "preparing_materials", canCancel: true };
    vi.mocked(gateway.generate).mockResolvedValue(preparing);
    vi.mocked(gateway.inspect).mockRejectedValueOnce(new Error("private network endpoint"));
    const t = await submitted(); await f.service.creation!.tick(); await f.service.creation!.tick();
    const pending = await data("fanjin_task_get", { taskId: t.taskId });
    expect(pending).toMatchObject({ executionStatus: "preparing", billingStatus: "not_started", errorCode: null });
    expect(JSON.stringify(pending)).not.toContain("private network endpoint");
    await f.db(T).where({ id: t.taskId }).update({ status: "checking", updatedAt: -1_000_000 });
    vi.mocked(gateway.inspect).mockResolvedValue({ ...preparing, status: "running" });
    await f.service.creation!.tick();
    expect((await data("fanjin_task_get", { taskId: t.taskId })).executionStatus).toBe("preparing");
    expect(gateway.generate).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost tool receipt from the existing relay without creating another generation", async () => {
    const t = await submitted();
    const preparing = { status: "running", relayTaskId: "existing-relay", billingStatus: "not_started", executionPhase: "preparing_materials", canCancel: true };
    gateway.recoverGeneration = vi.fn(async () => preparing);
    vi.mocked(gateway.inspect).mockResolvedValue(preparing);
    await f.db(T).where({ id: t.taskId }).update({ status: "dispatching", updatedAt: -1_000_000 });
    await f.service.creation!.tick();
    expect(gateway.recoverGeneration).toHaveBeenCalledWith(expect.anything(), expect.anything(), t.taskId);
    expect(await data("fanjin_task_get", { taskId: t.taskId })).toMatchObject({ executionStatus: "preparing", billingStatus: "not_started" });
    expect(gateway.generate).not.toHaveBeenCalled();
    expect((await f.db(T).where({ id: t.taskId }).first()).relayTaskId).toBe("existing-relay");
  });
  it("does not redispatch an interrupted operation without a unique existing relay", async () => {
    const t = await submitted();
    gateway.recoverGeneration = vi.fn(async () => null);
    await f.db(T).where({ id: t.taskId }).update({ status: "dispatching", updatedAt: -1_000_000 });
    await f.service.creation!.tick();
    expect((await data("fanjin_task_get", { taskId: t.taskId })).executionStatus).toBe("running");
    expect(gateway.generate).not.toHaveBeenCalled();
  });
  it("retries temporary receipt recovery failures without claiming reconciliation or redispatching", async () => {
    const t = await submitted();
    const preparing = { status: "running", relayTaskId: "existing-relay", billingStatus: "not_started", executionPhase: "preparing_materials", canCancel: true };
    gateway.recoverGeneration = vi.fn().mockRejectedValueOnce(new ToolError("BILLING_STATUS_UNAVAILABLE", "private diagnostic", 503)).mockResolvedValue(preparing);
    vi.mocked(gateway.inspect).mockResolvedValue(preparing);
    await f.db(T).where({ id: t.taskId }).update({ status: "dispatching", updatedAt: -1_000_000 });
    await f.service.creation!.tick();
    const recovering = await data("fanjin_task_get", { taskId: t.taskId });
    expect(recovering).toMatchObject({ executionStatus: "running", billingStatus: "updating", canCancel: false, errorCode: null });
    expect(JSON.stringify(recovering)).not.toContain("private diagnostic");
    expect((await f.db(T).where({ id: t.taskId }).first()).status).toBe("recovering");
    await f.service.creation!.tick();
    expect(await data("fanjin_task_get", { taskId: t.taskId })).toMatchObject({ executionStatus: "preparing", billingStatus: "not_started" });
    expect(gateway.generate).not.toHaveBeenCalled();
  });
  it("recovers an accepted generation immediately after the dispatch response is lost", async () => {
    const preparing = { status: "running", relayTaskId: "existing-relay", billingStatus: "not_started", executionPhase: "preparing_materials", canCancel: true };
    vi.mocked(gateway.generate).mockRejectedValue(new Error("connection lost after receipt persisted"));
    gateway.recoverGeneration = vi.fn().mockRejectedValueOnce(new Error("temporary status read failed")).mockResolvedValue(preparing);
    vi.mocked(gateway.inspect).mockResolvedValue(preparing);
    const t = await submitted(); await f.service.creation!.tick();
    expect(await data("fanjin_task_get", { taskId: t.taskId })).toMatchObject({ executionStatus: "running", billingStatus: "updating" });
    await f.service.creation!.tick();
    expect(await data("fanjin_task_get", { taskId: t.taskId })).toMatchObject({ executionStatus: "preparing", billingStatus: "not_started" });
    expect(gateway.generate).toHaveBeenCalledTimes(1);
    expect(gateway.recoverGeneration).toHaveBeenCalledTimes(2);
  });
  it("does not keep retrying receipt recovery after a definitive authority rejection", async () => {
    const t = await submitted();
    gateway.recoverGeneration = vi.fn().mockRejectedValue(new ToolError("MEMBERSHIP_REQUIRED", "成员权限已撤销", 403));
    await f.db(T).where({ id: t.taskId }).update({ status: "dispatching", updatedAt: -1_000_000 });
    await f.service.creation!.tick(); await f.service.creation!.tick();
    expect((await data("fanjin_task_get", { taskId: t.taskId })).executionStatus).toBe("failed");
    expect(gateway.recoverGeneration).toHaveBeenCalledTimes(1);
    expect(gateway.generate).not.toHaveBeenCalled();
  });
  it("cancels only a relay-confirmed preparation and stops polling it", async () => {
    vi.mocked(gateway.generate).mockResolvedValue({ relayTaskId: "relay-1", billingStatus: "not_started", executionPhase: "preparing_materials", canCancel: true });
    gateway.cancelPreparation = vi.fn(async () => ({ status: "cancelled", relayTaskId: "relay-1", billingStatus: "not_started" }));
    const t = await submitted(); await f.service.creation!.tick();
    expect(await data("fanjin_task_cancel", { taskId: t.taskId })).toMatchObject({ executionStatus: "cancelled", billingStatus: "not_started", canCancel: false });
    await f.service.creation!.tick();
    expect(gateway.cancelPreparation).toHaveBeenCalledTimes(1);
    expect(gateway.generate).toHaveBeenCalledTimes(1);
    expect(gateway.archive).not.toHaveBeenCalled();
  });
  it("does not claim cancellation when preparation has already crossed the relay dispatch boundary", async () => {
    vi.mocked(gateway.generate).mockResolvedValue({ relayTaskId: "relay-1", billingStatus: "not_started", executionPhase: "preparing_materials", canCancel: true });
    gateway.cancelPreparation = vi.fn(async () => ({ status: "running", billingStatus: "reserved" }));
    const t = await submitted(); await f.service.creation!.tick();
    expect((await run("fanjin_task_cancel", { taskId: t.taskId })).body.error?.code).toBe("CANCELLATION_UNAVAILABLE");
    expect((await f.db(T).where({ id: t.taskId }).first()).status).toBe("running");
  });
  it("runs a durable task through generation, storage and history exactly once", async () => {
    const t = await submitted(); await f.service.creation!.tick(); await f.service.creation!.tick(); await f.service.creation!.tick();
    const done = await data("fanjin_task_get", { taskId: t.taskId }); expect(done).toMatchObject({ executionStatus: "succeeded", storageStatus: "ready", billingStatus: "settled", assets: [{ assetId: 12 }] });
    expect(gateway.generate).toHaveBeenCalledTimes(1); expect(gateway.generate).toHaveBeenCalledWith(expect.objectContaining({ keyId: "key-a" }), expect.objectContaining({ projectId: 1 }), 123456789, t.taskId);
    expect((await data("fanjin_history_list", { projectId: 1 })).tasks[0].taskId).toBe(t.taskId);
    expect((await data("fanjin_task_recover", { idempotencyKey: "submit-1" })).taskId).toBe(t.taskId);
  });
  it("supports synchronous supplier images as durable async tool tasks", async () => {
    vi.mocked(gateway.generate).mockResolvedValue({ images: [{ b64_json: "aW1hZ2U=" }], billingStatus: "settled" });
    const t = await submitted(); await f.service.creation!.tick();
    expect((await data("fanjin_task_get", { taskId: t.taskId })).storageStatus).toBe("pending");
    await f.service.creation!.tick(); expect((await data("fanjin_task_get", { taskId: t.taskId })).storageStatus).toBe("ready");
  });
  it("retains provider refusal guidance in MCP task views without retrying or inventing a settlement", async () => {
    const error = { code: "PORTRAIT_UPSTREAM_REAL_PERSON_REJECTED", message: "生成平台拒绝了人物素材，请核对来源或申请复核。任务不会自动重投。" };
    vi.mocked(gateway.inspect).mockResolvedValue({ status: "failed", billingStatus: "pending_reconciliation", error });
    const t = await submitted();
    await f.service.creation!.tick(); await f.service.creation!.tick(); await f.service.creation!.tick();
    const expected = { taskId: t.taskId, executionStatus: "failed", billingStatus: "pending_reconciliation", errorCode: error.code, errorMessage: error.message, pollAfterMs: null };
    expect(await data("fanjin_task_get", { taskId: t.taskId })).toMatchObject(expected);
    expect(await data("fanjin_task_recover", { idempotencyKey: "submit-1" })).toMatchObject(expected);
    expect((await data("fanjin_history_list", { projectId: 1 })).tasks[0]).toMatchObject(expected);
    expect(gateway.generate).toHaveBeenCalledTimes(1);
    expect(gateway.archive).not.toHaveBeenCalled();
  });
  it("does not resubmit on supplier timeout or worker restart", async () => {
    vi.mocked(gateway.generate).mockRejectedValue(new Error("provider secret")); const t = await submitted();
    await f.service.creation!.tick(); await f.service.creation!.tick();
    const result = await data("fanjin_task_recover", { idempotencyKey: "submit-1" });
    expect(result.executionStatus).toBe("running"); expect(JSON.stringify(result)).not.toContain("provider secret"); expect(gateway.generate).toHaveBeenCalledTimes(1);
    await f.db(T).where({ id: t.taskId }).update({ status: "dispatching", updatedAt: -1_000_000 }); await f.service.creation!.tick();
    expect((await data("fanjin_task_get", { taskId: t.taskId })).executionStatus).toBe("running"); expect(gateway.generate).toHaveBeenCalledTimes(1);
  });
  it("retains a safe coded pre-dispatch failure for task recovery", async () => {
    vi.mocked(gateway.generate).mockRejectedValue(Object.assign(new Error("private provider detail"), {
      code: "portrait_admission_pending",
    }));
    const t = await submitted();
    await f.service.creation!.tick();
    const result = await data("fanjin_task_recover", { idempotencyKey: "submit-1" });
    expect(result).toMatchObject({ executionStatus: "running", executionPhase: "recovering_result", errorCode: null });
    expect(JSON.stringify(result)).not.toContain("private provider detail");
  });
  it("keeps the actionable safe pre-dispatch cause instead of asking for another declaration", async () => {
    vi.mocked(gateway.generate).mockRejectedValue(new VideoGenerationNotStartedError(new ToolError(
      "portrait_provider_media_invalid", "参考视频格式未被上游接受，请更换为 MP4", 422)));
    const t = await submitted(); await f.service.creation!.tick();
    expect(await data("fanjin_task_get", { taskId: t.taskId })).toMatchObject({ executionStatus: "failed", billingStatus: "not_started",
      errorCode: "portrait_provider_media_invalid", errorMessage: "参考视频格式未被上游接受，请更换为 MP4 本次未冻结或扣费。" });
    const unknown = new VideoGenerationNotStartedError(Object.assign(new Error("secret provider url"), { code: "PROVIDER_FAILURE" }));
    expect(unknown.message).not.toContain("secret");
  });
  it("checks permissions again immediately before dispatch", async () => {
    const t = await submitted(); await f.db("o_api_key").update({ permissions: '["generation:read"]' }); await f.service.creation!.tick();
    expect(gateway.generate).not.toHaveBeenCalled(); expect((await data("fanjin_task_get", { taskId: t.taskId })).executionStatus).toBe("failed");
  });
  it("stops claiming work when the worker drain starts", async () => {
    await submitted(); await f.service.creation!.tick(() => false); expect(gateway.generate).not.toHaveBeenCalled();
  });
  it("cancels queued tasks but refuses to pretend an active supplier task was cancelled", async () => {
    const t = await submitted(); expect((await data("fanjin_task_cancel", { taskId: t.taskId })).executionStatus).toBe("cancelled"); await f.service.creation!.tick(); expect(gateway.generate).not.toHaveBeenCalled();
    await f.db(T).where({ id: t.taskId }).update({ status: "running" }); expect((await run("fanjin_task_cancel", { taskId: t.taskId })).body.error?.code).toBe("CANCELLATION_UNAVAILABLE");
  });
  it("isolates task and upload IDs between keys owned by the same user", async () => {
    const t = await submitted(), key = await f.db("o_api_key").first(); await f.db("o_api_key").insert({ ...key, id: "other-key" });
    const r = await f.service.execute({ ...f.connection, apiKeyId: "other-key" }, "fanjin_task_get", { taskId: t.taskId }); expect(r.status).toBe(404);
    expect((await run("fanjin_upload_complete", { projectId: 1, uploadId: "11111111-1111-4111-8111-111111111111" })).status).toBe(404);
  });
  it("supports byte transfer over authenticated HTTP with an exact version", async () => {
    const app = express(); app.use(express.json()); app.use("/api/tools/v1", createToolsHttpRouter({ allowLocal: true, service: async () => f.service, authenticate: (req, _res, next) => { (req as any).apiKey = { id: "key-a" }; next(); } }));
    const downloaded = await request(app).get("/api/tools/v1/assets/12/versions/15/content?projectId=1"); expect(downloaded.status).toBe(200); expect(gateway.download).toHaveBeenCalledWith(expect.anything(), { assetId: 12, assetVersionId: 15, projectId: 1 });
    expect((await data("fanjin_asset_download", { assetId: 12, assetVersionId: 15, projectId: 1 })).downloadPath).toContain("/versions/15/");
    await f.db("o_api_key").update({ permissions: '["asset:read"]' }); expect((await request(app).get("/api/tools/v1/assets/12/versions/15/content?projectId=1")).status).toBe(403);
  });
});

it("accepts a 16-reference image contract and rejects overflow before quotation", () => {
  const imageRequest={...req,type:"image",duration:undefined,resolution:"1K",references:Array.from({length:16},(_,i)=>({assetVersionId:String(i+1),role:"subject"}))};
  const parsed = generationRequestSchema.parse(imageRequest);
  expect("references" in parsed ? parsed.references : []).toHaveLength(16);
  expect(generationRequestSchema.safeParse({...imageRequest,references:[...imageRequest.references,{assetVersionId:"17",role:"subject"}]}).success).toBe(false);
});
