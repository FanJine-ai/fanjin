import type { CommercialTenant } from "@/lib/commercialTenant";
import { preferredVolcanoPortraitChannel } from "@/lib/portraitProviderChannel";
import { registerPortraitAsset } from "@/lib/portraitAssetRegistration";
import { publicModelFields } from "@/lib/minimaxH3PublicIdentity";
import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { EXTERNAL_TOOL_TABLE as TABLE } from "@/lib/migrations/externalTools";
import { declarePortraitAdmission } from "@/lib/portraitAdmissionWorkflow";
import { retryPortraitAdmissionChecks } from "@/lib/portraitAdmissionRetry";
import { PORTRAIT_DECLARATION_VERSION } from "@/lib/portraitAdmissionStore";
import { startPortraitLivenessAuthorization } from "@/lib/portraitProviderRuntime";
import { toolPortraitStatus } from "./portraitStatus";
import { ToolError, guAmount, ledgerAmount, moneyAmount } from "./contracts";
import { readTaskBilling } from "./taskBilling";
import type { GenerationRequest } from "./creationContracts";
import { stableJson } from "./serialization";
import { VideoGenerationNotStartedError } from "./videoDispatchEvidence";
export { stableJson } from "./serialization";
export type ToolIdentity = { commercialTenant?: CommercialTenant; source?: "api" | "cli" | "mcp"; workspaceId: string; userId: number; keyId: string; modelAllowlist: string[]; permissions: string[]; memberPermissions: string[] };
export type CreationGateway = {
  projectCreate(identity: ToolIdentity, name: string, db: Knex.Transaction): Promise<Record<string, unknown>>;
  quote(identity: ToolIdentity, request: GenerationRequest): Promise<{ maximumCostMicros: number; pricingDigest: string }>;
  generate(identity: ToolIdentity, request: GenerationRequest, maximum: number, taskId: string): Promise<Record<string, any>>;
  /** Read-only recovery after the relay was persisted but its tool receipt was lost. */
  recoverGeneration?(identity: ToolIdentity, request: GenerationRequest, taskId: string): Promise<Record<string, any> | null>;
  inspect(identity: ToolIdentity, relayTaskId: string): Promise<Record<string, any>>;
  /** Cancels only a relay that is still preparing references and has not dispatched. */
  cancelPreparation?(identity: ToolIdentity, relayTaskId: string): Promise<Record<string, any>>;
  archive(identity: ToolIdentity, projectId: number, result: Record<string, any>): Promise<Record<string, any>>;
  prepareCanvasOutput?(identity: ToolIdentity, input: Record<string, any>): Promise<Record<string, any>>;
  validateCanvasAsset?(identity: ToolIdentity, projectId: number, asset: Record<string, any>, transaction: Knex.Transaction): Promise<void>;
  attachToCanvas?(identity: ToolIdentity, input: Record<string, any>, transaction: Knex.Transaction): Promise<Record<string, any>>;
  assetsList(identity: ToolIdentity, input: Record<string, any>): Promise<Record<string, any>>;
  assetGet(identity: ToolIdentity, input: Record<string, any>): Promise<Record<string, any>>;
  prepareUpload(identity: ToolIdentity, input: Record<string, any>, transaction?: Knex.Transaction): Promise<Record<string, any>>;
  /** Only adapters with durable, idempotent preparation may resume an interrupted operation. */
  recoverUploadPreparation?(identity: ToolIdentity, input: Record<string, any>, transaction?: Knex.Transaction): Promise<Record<string, any>>;
  uploadStatus(identity: ToolIdentity, input: Record<string, any>): Promise<Record<string, any>>;
  completeUpload(identity: ToolIdentity, input: Record<string, any>): Promise<Record<string, any>>;
  writeUpload(identity: ToolIdentity, input: Record<string, any>, stream: Readable): Promise<Record<string, any>>;
  rename?(identity: ToolIdentity, input: Record<string, any>, transaction: Knex.Transaction): Promise<Record<string, any>>;
  download(identity: ToolIdentity, input: Record<string, any>): Promise<{ stream: Readable; sizeBytes: number; mimeType: string }>;
};
const digest = (v: unknown) => createHash("sha256").update(stableJson(v)).digest("hex");
const parse = (s: string | null) => s ? JSON.parse(s) : {};
const scope = (i: ToolIdentity) => ({ workspaceId: i.workspaceId, keyId: i.keyId, userId: i.userId });
const permit = (ps: string[], p: string) => ps.some(x => x === "*" || x === p || x.endsWith(":*") && p.startsWith(x.slice(0, -1)));
const need = (v: unknown, code: string, message: string, status = 409) => { if (!v) throw new ToolError(code, message, status); };
export function createCreationService(db: Knex, gateway: CreationGateway, identityFor: (keyId: string) => Promise<ToolIdentity>, now = Date.now) {
  async function project(i: ToolIdentity, id: number) {
    need(await db("o_project").where({ id, workspaceId: i.workspaceId, deletionState: "active" }).first(), "PROJECT_NOT_FOUND", "项目不存在或无权访问", 404);
  }
  async function row(i: ToolIdentity, id: string, kind: string, tx: Knex | Knex.Transaction = db) {
    const r = await tx(TABLE).where({ ...scope(i), id, kind }).first();
    need(r, "RESOURCE_NOT_FOUND", "记录不存在或无权访问", 404);
    if (r.projectId) await project(i, Number(r.projectId));
    return r;
  }
  function fresh(r: any) { need(Number(r.expiresAt) > now(), "AUTHORIZATION_EXPIRED", "报价或授权已过期，请重新报价", 410); }
  async function insert(i: ToolIdentity, kind: string, key: string, request: any, projectId: number | null, result: any, status: string, expiresAt: number | null = null, tx: Knex | Knex.Transaction = db) {
    const id = randomUUID(), hash = digest(request), timestamp = now();
    await tx(TABLE).insert({ id, ...scope(i), projectId, kind, idempotencyKey: key, requestHash: hash, requestJson: stableJson({ ...request, _source: i.source || "api" }), resultJson: result === null ? null : stableJson(result), status, expiresAt, createdAt: timestamp, updatedAt: timestamp }).onConflict(["workspaceId", "keyId", "kind", "idempotencyKey"]).ignore();
    const r = await tx(TABLE).where({ ...scope(i), kind, idempotencyKey: key }).first();
    need(r && r.requestHash === hash, "IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同请求");
    return { row: r, created: r.id === id };
  }
  async function existing(i: ToolIdentity, kind: string, input: any) {
    const { idempotencyKey, ...request } = input;
    const r = await db(TABLE).where({ ...scope(i), kind, idempotencyKey }).first();
    if (r) {
      const original = parse(r.requestJson);
      // Direct MCP submissions record their generated approval for auditing,
      // although that approval is absent from the client's replayed request.
      let directReplay = kind === "fanjin_generation_submit" && !input.approvalId
        && original.quoteId === input.quoteId && original.approvalMode === "key_owner" && original.budgetGu === input.budgetGu && stableJson(original.targetCanvas ?? null) === stableJson(input.targetCanvas ?? null);
      if (!directReplay && kind === "fanjin_generation_submit" && !input.approvalId
        && original.quoteId === input.quoteId && original.approvalId && !original.approvalMode
        && original.budgetGu === input.budgetGu && stableJson(original.targetCanvas ?? null) === stableJson(input.targetCanvas ?? null)) {
        const approval = await db(TABLE).where({ ...scope(i), id: original.approvalId,
          kind: "fanjin_approval_request", idempotencyKey: `auto-approve:${input.idempotencyKey}` }).first();
        directReplay = Boolean(approval && parse(approval.requestJson).confirmedBy === "mcp-cli-key-owner"
          && parse(approval.requestJson).quoteId === input.quoteId);
      }
      need(directReplay || r.requestHash === digest(request), "IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同请求");
    }
    return r;
  }
  function quoteView(r: any) {
    return { quoteId: r.id, request: publicModelFields(parse(r.requestJson).request), maximum: guAmount(ledgerAmount(parse(r.resultJson).maximumCostMicros)), maximumPrice: moneyAmount(ledgerAmount(parse(r.resultJson).maximumCostMicros)), expiresAt: Number(r.expiresAt), status: Number(r.expiresAt) > now() ? r.status : "expired" };
  }
  function approvalView(r: any) {
    return { approvalId: r.id, quoteId: parse(r.requestJson).quoteId, status: ["pending", "approved"].includes(r.status) && Number(r.expiresAt) <= now() ? "expired" : r.status, expiresAt: Number(r.expiresAt), confirmationPath: `/#/tools/approvals/${r.id}` };
  }
  function taskView(r: any) {
    const output = parse(r.resultJson), request = parse(r.requestJson);
    const terminal = ["succeeded", "failed", "cancelled"].includes(r.status);
    const recovering = ["recovering", "needs_reconciliation"].includes(r.status);
    const preparing = !terminal && output.executionPhase === "preparing_materials";
    return { taskId: r.id, projectId: Number(r.projectId), executionStatus: preparing ? "preparing" : recovering || r.status === "dispatching" ? "running" : ["generated", "archiving"].includes(r.status) ? "succeeded" : r.status === "checking" ? "running" : r.status,
      executionPhase: terminal ? null : recovering ? "recovering_result" : output.executionPhase || null,
      statusMessage: terminal ? null : recovering ? "正在自动找回原任务结果，无需核账或重新提交。" : output.statusMessage || null,
      deliveryReady: r.status === "succeeded",
      nextAction: r.status === "succeeded" ? "use_assets" : terminal ? "inspect_failure" : "wait",
      billingTool: "fanjin_task_billing",
      canvasDelivery: output.canvasDelivery || null,
      canCancel: !terminal && (r.status === "queued" || preparing && output.canCancel === true),
      storageStatus: r.status === "succeeded" ? "ready" : r.status === "failed" ? "failed" : "pending",
      billingStatus: output.billingStatus || (preparing || r.status === "queued" || r.status === "cancelled" ? "not_started" : "updating"),
      assets: r.status === "succeeded" ? output.assets || [] : [], errorCode: recovering ? null : r.errorCode || output.error?.code || null,
      errorMessage: recovering ? null : output.error?.message || null,
      draft: output.draft ? { ...output.draft, ...(output.draft.renderMode === "draft" && output.draft.expiresAt != null && Number(output.draft.expiresAt) <= now() ? { canFinalize: false, unavailableReason: "样片已超过 7 天，请重新生成样片" } : {}) } : null,
      quoteId: request.quoteId, createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt), pollAfterMs: terminal ? null : 2000 };
  }
  async function currentTaskView(i: ToolIdentity, r: any) {
    // A terminal generation can have its reservation resolved later. Reads must
    // not keep presenting the terminal operation's obsolete billing snapshot.
    if (r.relayTaskId && ["succeeded", "failed", "needs_reconciliation"].includes(r.status)) {
      try {
        const latest = await gateway.inspect(i, r.relayTaskId);
        // A legacy billing/recovery failure may outlive its original provider
        // receipt. Resume only delivery from that receipt, never paid dispatch.
        // CAS protects a concurrent worker or user cancellation. Stored output
        // still passes archive/lineage checks before deliveryReady becomes true.
        if (r.status !== "succeeded" && latest.status === "succeeded") {
          await db(TABLE).where({ id: r.id, status: r.status, updatedAt: r.updatedAt })
            .update(recoveryPatch({ ...latest, relayTaskId: r.relayTaskId }));
          return taskView(await row(i, r.id, "fanjin_generation_submit"));
        }
        if (["failed", "cancelled"].includes(latest.status) || (r.status === "succeeded" && latest.status === "succeeded")) {
          return taskView({ ...r, status: latest.status, errorCode: latest.error?.code || null,
            resultJson: stableJson({ ...parse(r.resultJson), ...latest,
              assets: latest.assets?.length ? latest.assets : parse(r.resultJson).assets }) });
        }
      } catch { /* Keep the durable state if the read fails; never resubmit. */ }
    }
    return taskView(r);
  }
  async function attachOutput(i: ToolIdentity, r: any, target: Record<string, any>, assets: any[], idempotencyKey: string) {
    need(i.workspaceId === r.workspaceId && i.keyId === r.keyId && i.userId === Number(r.userId), "PERMISSION_DENIED", "任务身份已变化", 403);
    need(permit(i.permissions, "project:write") && permit(i.memberPermissions, "project:write"), "PERMISSION_DENIED", "没有画布写入权限", 403);
    const asset = assets[target.assetIndex ?? 0];
    need(asset && gateway.attachToCanvas, "OUTPUT_UNAVAILABLE", "作品尚未保存或画布回填不可用", 409);
    // Storage resolution may use the shared connection pool; do it before the
    // atomic journal/canvas transaction. The adapter revalidates access in tx.
    const preparedAsset = gateway.prepareCanvasOutput
      ? await gateway.prepareCanvasOutput(i, { projectId: Number(r.projectId), asset }) : asset;
    return db.transaction(async tx => {
      const request = { projectId: Number(r.projectId), taskId: r.id, ...target };
      const saved = await insert(i, "fanjin_canvas_attach", idempotencyKey, request, Number(r.projectId), null, "attaching", null, tx);
      if (!saved.created) return parse(saved.row.resultJson);
      const result = await gateway.attachToCanvas!(i, { ...request, asset: preparedAsset }, tx);
      await tx(TABLE).where({ id: saved.row.id }).update({ status: "succeeded", resultJson: stableJson(result), updatedAt: now() });
      return result;
    });
  }
  async function upload(i: ToolIdentity, input: any) {
    const record = await db(TABLE).where({ ...scope(i), kind: "fanjin_upload_prepare", projectId: input.projectId, status: "succeeded", uploadId: input.uploadId }).first();
    need(record, "UPLOAD_NOT_FOUND", "上传会话不存在或无权访问", 404);
    await project(i, input.projectId);
  }
  async function execute(i: ToolIdentity, name: string, input: any): Promise<Record<string, any>> {
    if (input.projectId) await project(i, input.projectId);
    if (name === "fanjin_project_create") {
      return db.transaction(async tx => {
        const saved = await insert(i, name, input.idempotencyKey, { name: input.name }, null, null, "creating", null, tx);
        if (!saved.created) return parse(saved.row.resultJson);
        const result = await gateway.projectCreate(i, input.name, tx);
        await tx(TABLE).where({ id: saved.row.id }).update({ resultJson: stableJson(result), status: "succeeded", projectId: Number(result.projectId) });
        return result;
      });
    }
    if (name === "fanjin_assets_list") return gateway.assetsList(i, input);
    if (name === "fanjin_asset_get") return { asset: await gateway.assetGet(i, input) };
    if (name === "fanjin_asset_download") {
      const asset = await gateway.assetGet(i, input);
      need(asset.storageKey && asset.status === "active", "ASSET_NOT_STORED", "作品尚未保存在受控存储中");
      return { assetId: asset.assetId, assetVersionId: asset.assetVersionId, sizeBytes: asset.sizeBytes, contentHash: asset.contentHash,
        downloadPath: `/api/tools/v1/assets/${asset.assetId}/versions/${asset.assetVersionId}/content?projectId=${input.projectId}`, authentication: "workspace_api_key", expiresAt: null };
    }
    if (name === "fanjin_upload_prepare") {
      const { idempotencyKey, ...request } = input;
      const saved = await insert(i, name, idempotencyKey, request, input.projectId, null, "preparing");
      return db.transaction(async tx => {
        // Serialize initial preparation and recovery, including rotating the upload resume grant.
        const current = await tx(TABLE).where({ id: saved.row.id }).forUpdate().first();
        if (current.status === "succeeded") return parse(current.resultJson);
        need(current.status !== "cancelled", "UPLOAD_PREPARATION_CANCELLED", "此上传准备已结束，请查询已保存的素材", 410);
        need(saved.created || gateway.recoverUploadPreparation, "OPERATION_NEEDS_RECONCILIATION", "上传准备结果待核对，请保留原幂等键");
        const result = await (saved.created ? gateway.prepareUpload : gateway.recoverUploadPreparation!)(i, input, tx);
        await tx(TABLE).where({ id: current.id }).update({ resultJson: stableJson(result), uploadId: result.uploadId, status: "succeeded", updatedAt: now() });
        return result;
      });
    }
    if (name === "fanjin_upload_get" || name === "fanjin_upload_complete") {
      await upload(i, input);
      return name === "fanjin_upload_get" ? gateway.uploadStatus(i, input) : { asset: await gateway.completeUpload(i, input) };
    }
    if (name === "fanjin_generation_quote") {
      await project(i, input.request.projectId);
      const previous = await existing(i, name, input);
      if (previous) return quoteView(previous);
      const pricing = await gateway.quote(i, input.request);
      need(Number.isSafeInteger(pricing.maximumCostMicros) && pricing.maximumCostMicros > 0, "PRICING_UNAVAILABLE", "无法获得有效的最高扣费金额");
      const saved = await insert(i, name, input.idempotencyKey, { request: input.request }, input.request.projectId, pricing, "quoted", now() + 15 * 60_000);
      return quoteView(saved.row);
    }
    if (name === "fanjin_approval_request") {
      const q = await row(i, input.quoteId, "fanjin_generation_quote"); fresh(q);
      const saved = await insert(i, name, input.idempotencyKey, { quoteId: q.id }, Number(q.projectId), null, "pending", Number(q.expiresAt));
      return { ...approvalView(saved.row), quote: quoteView(q) };
    }
    if (name === "fanjin_approval_confirm") {
      // Key owner may confirm their own quote from MCP/CLI without opening the web UI.
      const q = await row(i, input.quoteId, "fanjin_generation_quote"); fresh(q);
      const decision = input.decision === "rejected" ? "rejected" : "approved";
      return await db.transaction(async tx => {
        const replay = await tx(TABLE).where({ ...scope(i), kind: "fanjin_approval_request", idempotencyKey: input.idempotencyKey }).first();
        if (replay) return { ...approvalView(replay), quote: quoteView(q) };
        const saved = await insert(i, "fanjin_approval_request", input.idempotencyKey, { quoteId: q.id, confirmedBy: "mcp-cli-key-owner" }, Number(q.projectId), null, "pending", Number(q.expiresAt), tx);
        const updated = await tx(TABLE)
          .where({ id: saved.row.id, status: "pending" })
          .where("expiresAt", ">", now())
          .update({ status: decision, updatedAt: now() });
        need(updated === 1 || saved.row.status === decision, "APPROVAL_STATE_CONFLICT", "授权状态已改变");
        return { ...approvalView(await tx(TABLE).where({ id: saved.row.id }).first()), quote: quoteView(q) };
      });
    }
    if (name === "fanjin_approval_get") return approvalView(await row(i, input.approvalId, "fanjin_approval_request"));
    if (name === "fanjin_generation_submit") {
      const previous = await existing(i, name, input);
      if (previous) return taskView(previous);
      try {
        const q = await row(i, input.quoteId, "fanjin_generation_quote"); fresh(q);
        if (input.budgetGu !== undefined) {
          const [whole, fractional = ""] = input.budgetGu.split(".");
          const budget = BigInt(whole) * 100_000_000n + BigInt(fractional.padEnd(8, "0"));
          need(ledgerAmount(parse(q.resultJson).maximumCostMicros) <= budget, "BUDGET_EXCEEDED", "报价超过已授权预算，尚未提交生成");
        }
        if (input.targetCanvas) need(permit(i.permissions, "project:write") && permit(i.memberPermissions, "project:write"), "PERMISSION_DENIED", "没有画布写入权限", 403);
        // MCP/CLI direct pass: the key owner may submit without a web approval.
        // A provided approvalId still uses the signed-in web confirmation.
        let a: any;
        if (input.approvalId) {
          a = await row(i, input.approvalId, "fanjin_approval_request"); fresh(a);
          need(a.status === "approved" && parse(a.requestJson).quoteId === q.id, "APPROVAL_REQUIRED", "需要所属用户批准此报价", 403);
        } else {
          const confirm = await execute(i, "fanjin_approval_confirm", {
            quoteId: input.quoteId,
            decision: "approved",
            idempotencyKey: `auto-approve:${input.idempotencyKey}`,
          });
          a = await row(i, String(confirm.approvalId), "fanjin_approval_request");
          need(a.status === "approved", "APPROVAL_REQUIRED", "报价确认未生效", 403);
        }
        const current = await gateway.quote(i, parse(q.requestJson).request);
        need(stableJson(current) === stableJson(parse(q.resultJson)), "QUOTE_CHANGED", "模型价格或能力已变化，请重新报价");
        return await db.transaction(async tx => {
          const replay = await tx(TABLE).where({ ...scope(i), kind: name, idempotencyKey: input.idempotencyKey }).first();
          const taskRequest = { quoteId: q.id, approvalId: a.id, ...(input.targetCanvas ? { targetCanvas: input.targetCanvas } : {}), ...(input.budgetGu !== undefined ? { budgetGu: input.budgetGu } : {}), ...(!input.approvalId ? { approvalMode: "key_owner" } : {}) };
          if (replay) { need(replay.requestHash === digest(taskRequest), "IDEMPOTENCY_CONFLICT", "幂等键冲突"); return taskView(replay); }
          const consumed = await tx(TABLE).where({ id: a.id, status: "approved" }).where("expiresAt", ">", now()).update({ status: "consumed", updatedAt: now() });
          need(consumed === 1, "APPROVAL_CONSUMED", "授权已使用或过期");
          // Also consume the quote: a second approval cannot authorize the same logical quote again.
          const quoteConsumed = await tx(TABLE).where({ id: q.id, status: "quoted" }).where("expiresAt", ">", now()).update({ status: "consumed", updatedAt: now() });
          need(quoteConsumed === 1, "QUOTE_CONSUMED", "该报价已提交");
          const saved = await insert(i, name, input.idempotencyKey, taskRequest, Number(q.projectId), null, "queued", Number(q.expiresAt), tx);
          return taskView(saved.row);
        });
      } catch (error) {
        // PostgreSQL concurrent transactions can observe the approval consumption
        // before their first task lookup. The committed same-key result is a replay.
        const replay = await existing(i, name, input);
        if (replay) return taskView(replay);
        throw error;
      }
    }
    if (name === "fanjin_task_get" || name === "fanjin_task_cancel") {
      let r = await row(i, input.taskId, "fanjin_generation_submit");
      if (name === "fanjin_task_cancel") {
        if (r.status !== "cancelled") {
          const cancelled = await db(TABLE).where({ id: r.id, status: "queued" }).update({ status: "cancelled", updatedAt: now() });
          if (!cancelled) {
            // The relay owns the dispatch boundary. Its cancellation must be
            // revision/lease fenced; an old tool snapshot is never sufficient.
            r = await row(i, input.taskId, "fanjin_generation_submit");
            need(r.relayTaskId && ["running", "checking"].includes(r.status) && gateway.cancelPreparation,
              "CANCELLATION_UNAVAILABLE", "任务已派发，无法保证取消；请继续查询");
            const result = await gateway.cancelPreparation!(i, r.relayTaskId);
            need(result.status === "cancelled", "CANCELLATION_UNAVAILABLE", "任务已开始生成，暂时无法取消；请继续查询");
            await db(TABLE).where({ id: r.id, relayTaskId: r.relayTaskId }).whereIn("status", ["running", "checking"])
              .update({ status: "cancelled", resultJson: stableJson(result), errorCode: null, updatedAt: now() });
          }
        }
        r = await row(i, input.taskId, "fanjin_generation_submit");
      }
      return currentTaskView(i, r);
    }
    if (name === "fanjin_task_recover") {
      const r = await db(TABLE).where({ ...scope(i), kind: "fanjin_generation_submit", idempotencyKey: input.idempotencyKey }).first();
      need(r, "TASK_NOT_FOUND", "原幂等键没有已接收的任务", 404); await project(i, Number(r.projectId)); return currentTaskView(i, r);
    }
    if (name === "fanjin_canvas_attach") {
      const r = await row(i, input.taskId, "fanjin_generation_submit");
      need(Number(r.projectId) === input.projectId, "PROJECT_MISMATCH", "作品不属于目标项目", 404);
      need(r.status === "succeeded", "OUTPUT_UNAVAILABLE", "作品尚未保存，请继续等待", 409);
      need(input.canvasId, "CANVAS_REQUIRED", "请指定 canvasId 或在连接地址绑定画布");
      return attachOutput(i, r, { canvasId: input.canvasId, nodeId: input.nodeId, expectedRevision: input.expectedRevision, assetIndex: input.assetIndex }, parse(r.resultJson).assets || [], input.idempotencyKey);
    }
    if (name === "fanjin_task_billing") {
      const r = await row(i, input.taskId, "fanjin_generation_submit");
      const q = await row(i, parse(r.requestJson).quoteId, "fanjin_generation_quote");
      return readTaskBilling(db, i, r, ledgerAmount(parse(q.resultJson).maximumCostMicros), now());
    }
    if (name === "fanjin_task_wait") {
      const deadline = performance.now() + input.waitMs;
      while (true) {
        const live = await identityFor(i.keyId);
        need(live.userId === i.userId && live.workspaceId === i.workspaceId
          && permit(live.permissions, "generation:read") && permit(live.memberPermissions, "project:read"),
        "PERMISSION_DENIED", "任务查询权限已变化", 403);
        const task = await currentTaskView(i, await row(i, input.taskId, "fanjin_generation_submit"));
        if (task.deliveryReady || ["failed", "cancelled"].includes(task.executionStatus) || performance.now() >= deadline) return task;
        await delay(Math.min(task.pollAfterMs || 2000, Math.max(1, deadline - performance.now())));
      }
    }
    if (name === "fanjin_tasks_list" || name === "fanjin_history_list") {
      const s = digest([scope(i), input.projectId]); let after: { t: number; id: string } | undefined;
      if (input.cursor) { try { const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); need(c.s === s && Number.isSafeInteger(c.t) && typeof c.id === "string", "INVALID_CURSOR", "无效游标"); after = c; } catch { throw new ToolError("INVALID_CURSOR", "无效游标"); } }
      const query = db(TABLE).where({ ...scope(i), kind: "fanjin_generation_submit", projectId: input.projectId });
      if (after) { const a = after; query.andWhere(b => b.where("createdAt", "<", a.t).orWhere(c => c.where("createdAt", a.t).where("id", "<", a.id))); }
      const rows = await query.orderBy("createdAt", "desc").orderBy("id", "desc").limit(input.limit + 1);
      const selected = rows.slice(0, input.limit), last = selected.at(-1);
      return { tasks: await Promise.all(selected.map(r => currentTaskView(i, r))), nextCursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ s, t: Number(last.createdAt), id: last.id })).toString("base64url") : null };
    }
    if (name === "fanjin_asset_rename") {
      return db.transaction(async tx => {
        const { idempotencyKey, ...request } = input;
        const saved = await insert(i, name, idempotencyKey, request, input.projectId, null, "renaming", null, tx);
        if (!saved.created) return parse(saved.row.resultJson);
        need(gateway.rename, "TOOL_UNAVAILABLE", "重命名未配置", 503);
        const result = await gateway.rename!(i, input, tx);
        await tx(TABLE).where({ id: saved.row.id }).update({ status: "succeeded", resultJson: stableJson(result) }); return result;
      });
    }
    if (name === "fanjin_portrait_asset_register") {
      return db.transaction(async tx => {
        const { idempotencyKey, ...request } = input;
        const saved = await insert(i, name, idempotencyKey, request, input.projectId, null, "registering", null, tx);
        if (!saved.created) return parse(saved.row.resultJson);
        const { admission, registration } = await registerPortraitAsset({
          database: tx, workspaceId: i.workspaceId, projectId: input.projectId,
          assetVersionId: input.assetVersionId, actorUserId: i.userId,
          expectedRevision: input.expectedRevision ?? null, model: input.model, now: now(),
        });
        const result = {
          registration,
          portraitAdmission: await toolPortraitStatus({ database: tx, workspaceId: i.workspaceId,
            projectId: input.projectId, assetVersionId: input.assetVersionId, actorUserId: i.userId }, admission.mediaType),
        };
        await tx(TABLE).where({ id: saved.row.id }).update({ status: "succeeded", resultJson: stableJson(result) });
        return result;
      });
    }
    if (name === "fanjin_portrait_admission_retry") {
      return db.transaction(async tx => {
        const { idempotencyKey, ...request } = input;
        const saved = await insert(i, name, idempotencyKey, request, input.projectId, null, "retrying", null, tx);
        if (!saved.created) return parse(saved.row.resultJson);
        const admission = await retryPortraitAdmissionChecks({
          database: tx,
          workspaceId: i.workspaceId,
          projectId: input.projectId,
          assetVersionId: input.assetVersionId,
          expectedRevision: input.expectedRevision ?? null,
          now: now(),
        });
        const result = { portraitAdmission: await toolPortraitStatus({ database: tx, workspaceId: i.workspaceId, projectId: input.projectId, assetVersionId: input.assetVersionId }, admission.mediaType) };
        await tx(TABLE).where({ id: saved.row.id }).update({ status: "succeeded", resultJson: stableJson(result) });
        return result;
      });
    }
    if (name === "fanjin_portrait_admission_declare") {
      return db.transaction(async tx => {
        const { idempotencyKey, termsAccepted: _terms, ...request } = input;
        const saved = await insert(i, name, idempotencyKey, request, input.projectId, null, "declaring", null, tx);
        if (!saved.created) return parse(saved.row.resultJson);
        const admission = await declarePortraitAdmission({
          database: tx,
          workspaceId: i.workspaceId,
          projectId: input.projectId,
          assetVersionId: input.assetVersionId,
          actorUserId: i.userId,
          choice: input.choice,
          preferredProviderChannelId: await preferredVolcanoPortraitChannel({ database: tx, workspaceId: i.workspaceId }),
          termsVersion: PORTRAIT_DECLARATION_VERSION,
          termsAccepted: true,
          // The named declaration from the key owner is the rights attestation.
          rightsConfirmed: true,
          expectedRevision: input.expectedRevision ?? null,
          now: now(),
        });
        const result = {
          portraitAdmission: await toolPortraitStatus({ database: tx, workspaceId: i.workspaceId, projectId: input.projectId, assetVersionId: input.assetVersionId }, admission.mediaType),
          declarationVersion: PORTRAIT_DECLARATION_VERSION,
        };
        await tx(TABLE).where({ id: saved.row.id }).update({ status: "succeeded", resultJson: stableJson(result) });
        return result;
      });
    }
    if (name === "fanjin_portrait_admission_authorize") {
      return db.transaction(async tx => {
        const { idempotencyKey, rightsConfirmed: _rights, ...request } = input;
        const saved = await insert(i, name, idempotencyKey, request, input.projectId, null, "authorizing", null, tx);
        if (!saved.created) return parse(saved.row.resultJson);
        const auth = await startPortraitLivenessAuthorization({
          database: tx,
          workspaceId: i.workspaceId,
          projectId: input.projectId,
          assetVersionId: input.assetVersionId,
          admissionId: null,
          actorUserId: i.userId,
          expectedRevision: input.expectedRevision ?? null,
          identityLabel: input.identityLabel,
          rightsConfirmed: true,
        });
        const result = {
          authorizationUrl: auth.authorizationUrl,
          expiresAt: auth.expiresAt,
          note: "请在浏览器打开授权链接并由用户完成验证；工具不能代替用户完成授权。",
        };
        await tx(TABLE).where({ id: saved.row.id }).update({ status: "succeeded", resultJson: stableJson(result) });
        return result;
      });
    }
    throw new ToolError("TOOL_NOT_FOUND", "工具不存在", 404);
  }
  async function approvalForUser(userId: number, approvalId: string) {
    const a = await db(TABLE).where({ id: approvalId, kind: "fanjin_approval_request", userId }).first();
    need(a, "RESOURCE_NOT_FOUND", "授权请求不存在", 404);
    const i = await identityFor(a.keyId); need(i.userId === userId, "PERMISSION_DENIED", "密钥所属用户已变化", 403);
    need(permit(i.permissions, "generation:create") && permit(i.memberPermissions, "generation:create"), "PERMISSION_DENIED", "当前用户或密钥不能提交生成", 403);
    const q = await row(i, parse(a.requestJson).quoteId, "fanjin_generation_quote");
    return { a, q, i };
  }
  async function recoverDispatch(r: any) {
    const i = await identityFor(r.keyId);
    need(i.userId === Number(r.userId) && i.workspaceId === r.workspaceId, "PERMISSION_DENIED", "任务主体已变化", 403);
    const q = await row(i, parse(r.requestJson).quoteId, "fanjin_generation_quote");
    if (r.relayTaskId) return { ...await gateway.inspect(i, r.relayTaskId), relayTaskId: r.relayTaskId };
    return gateway.recoverGeneration?.(i, parse(q.requestJson).request, r.id) ?? null;
  }
  const recoveryPatch = (result: Record<string, any>) => ({
    status: result.status === "succeeded" ? "generated" : ["failed", "cancelled"].includes(result.status) ? result.status : "running",
    relayTaskId: result.relayTaskId, resultJson: stableJson(result), errorCode: result.error?.code || null,
    claimedBy: null, updatedAt: now(),
  });
  const recoveryReadUnavailable = (error: unknown) => !(error instanceof ToolError
    && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
  const recoveryWaitingPatch = (r: any) => ({ status: "recovering", errorCode: null, claimedBy: null, updatedAt: now(),
    resultJson: stableJson({ ...parse(r.resultJson), billingStatus: "updating", canCancel: false,
      statusMessage: "正在恢复已受理任务，状态查询将自动重试，无需重新提交。" }) });
  const resultUnavailablePatch = (r: any, code = "RESULT_UNAVAILABLE") => ({ status: "failed", errorCode: code, claimedBy: null, updatedAt: now(),
    resultJson: stableJson({ ...parse(r.resultJson), canCancel: false,
      billingStatus: parse(r.resultJson).billingStatus || "updating",
      error: { code, message: code === "RESULT_UNAVAILABLE"
        ? "暂未找回原任务结果。可用任务编号查询账单，平台未自动重投生成。"
        : "原任务查询权限或资源已不可用。平台未自动重投生成。" } }) });
  return {
    execute,
    async review(userId: number, approvalId: string) { const { a, q, i } = await approvalForUser(userId, approvalId); return { ...approvalView(a), workspaceId: i.workspaceId, quote: quoteView(q) }; },
    async decide(userId: number, approvalId: string, decision: "approved" | "rejected", quoteId: string) {
      const { a, q } = await approvalForUser(userId, approvalId); fresh(a); fresh(q);
      need(q.id === quoteId, "QUOTE_MISMATCH", "确认的报价不匹配");
      if (a.status !== decision) need(await db(TABLE).where({ id: a.id, status: "pending" }).where("expiresAt", ">", now()).update({ status: decision, updatedAt: now() }), "APPROVAL_STATE_CONFLICT", "授权状态已改变");
      return approvalView(await db(TABLE).where({ id: a.id }).first());
    },
    async writeUpload(i: ToolIdentity, input: any, stream: Readable) { await upload(i, input); return gateway.writeUpload(i, input, stream); },
    async download(i: ToolIdentity, input: any) { await project(i, input.projectId); return gateway.download(i, input); },
    async tick(shouldContinue: () => boolean = () => true) {
      // A read interrupted by restart is safe to resume. Only an unknown
      // side-effecting dispatch/archive must be reconciled instead of replayed.
      await db(TABLE).where({ kind: "fanjin_generation_submit", status: "checking" }).where("updatedAt", "<", now() - 15 * 60_000)
        .update({ status: "running", errorCode: null, claimedBy: null, updatedAt: now() });
      // Old reconciliation rows are recovery work, not a user approval step.
      // Recover only the original receipt; never call generate on this path.
      const interrupted = await db(TABLE).where({ kind: "fanjin_generation_submit" })
        .andWhere(query => query.whereIn("status", ["dispatching", "archiving"]).where("updatedAt", "<", now() - 15 * 60_000)
          .orWhere(q => q.whereIn("status", ["recovering", "needs_reconciliation"])
            .andWhere(lease => lease.whereNull("claimedBy").orWhere("updatedAt", "<", now() - 15 * 60_000))))
        .orderBy("updatedAt").limit(4);
      for (const r of interrupted) {
        if (!shouldContinue()) break;
        const claimedBy = randomUUID();
        if (!await db(TABLE).where({ id: r.id, status: r.status, updatedAt: r.updatedAt })
          .update({ status: "recovering", claimedBy, updatedAt: now() })) continue;
        const update = (patch: any) => db(TABLE).where({ id: r.id, status: "recovering", claimedBy }).update(patch);
        try {
          if (r.status === "archiving" || parse(r.resultJson).images) {
            // Archival is idempotent and never dispatches a paid generation.
            await update({ status: "generated", errorCode: null, claimedBy: null, updatedAt: now() });
            continue;
          }
          const result = await recoverDispatch(r);
          if (result?.relayTaskId) { await update(recoveryPatch(result)); continue; }
        } catch (error) {
          if (!recoveryReadUnavailable(error)) {
            await update(resultUnavailablePatch(r, "RESULT_ACCESS_UNAVAILABLE"));
            continue;
          }
        }
        await update(now() - Number(r.createdAt) >= 24 * 60 * 60_000
          ? resultUnavailablePatch(r) : recoveryWaitingPatch(r));
      }
      const rows = await db(TABLE).where({ kind: "fanjin_generation_submit" }).whereIn("status", ["queued", "running", "generated"]).orderBy("updatedAt").limit(4);
      for (const r of rows) {
        if (!shouldContinue()) break;
        const claimedBy = randomUUID(), phase = r.status === "queued" ? "dispatching" : r.status === "running" ? "checking" : "archiving";
        if (!await db(TABLE).where({ id: r.id, status: r.status, updatedAt: r.updatedAt }).update({ status: phase, claimedBy, updatedAt: now() })) continue;
        const heartbeat = setInterval(() => { void db(TABLE).where({ id: r.id, claimedBy, status: phase }).update({ updatedAt: now() }).catch(() => {}); }, 10_000);
        heartbeat.unref();
        let started = false;
        const patch = (v: any) => db(TABLE).where({ id: r.id, claimedBy, status: phase }).update({ ...v, updatedAt: now() });
        try {
          const i = await identityFor(r.keyId); need(i.userId === Number(r.userId) && i.workspaceId === r.workspaceId, "PERMISSION_DENIED", "任务主体已变化", 403);
          need(permit(i.permissions, "generation:create") && permit(i.memberPermissions, "generation:create"), "PERMISSION_DENIED", "生成权限已撤销", 403);
          await project(i, Number(r.projectId));
          if (r.status === "queued") {
            // Expiry gates accepting an authorization, not completing an
            // already accepted durable task after queueing/restart.
            const q = await row(i, parse(r.requestJson).quoteId, "fanjin_generation_quote"), request = parse(q.requestJson).request;
            const approved = parse(q.resultJson), pricing = await gateway.quote(i, request);
            need(Number.isSafeInteger(pricing.maximumCostMicros) && pricing.maximumCostMicros > 0
              && pricing.maximumCostMicros <= approved.maximumCostMicros, "QUOTE_CHANGED", "当前价格超过已确认预算，请重新报价确认");
            started = true;
            const result = await gateway.generate(i, request, approved.maximumCostMicros, r.id);
            await patch({ status: result.relayTaskId ? "running" : "generated", relayTaskId: result.relayTaskId || null, resultJson: stableJson(result) });
          } else if (r.status === "running") {
            const result = await gateway.inspect(i, r.relayTaskId);
            await patch({ status: result.status === "succeeded" ? "generated" : result.status, resultJson: stableJson(result) });
          } else {
            started = true; const result = await gateway.archive(i, Number(r.projectId), parse(r.resultJson));
            const target = parse(r.requestJson).targetCanvas;
            if (target) {
              try { result.canvasDelivery = await attachOutput(await identityFor(r.keyId), r, target, result.assets || [], `task-output:${r.id}`); }
              catch (error) { result.canvasDelivery = { status: "needs_attention", code: error instanceof ToolError ? error.code : "CANVAS_ATTACH_UNAVAILABLE", message: "作品已保存；画布回填未完成，请重新读取画布后回填。" }; }
            }
            await patch({ status: "succeeded", errorCode: null, resultJson: stableJson(result) });
          }
        } catch (error: any) {
          if (r.status === "queued" && started && gateway.recoverGeneration && !(error instanceof VideoGenerationNotStartedError)) {
            try {
              const recovered = await recoverDispatch(r);
              if (recovered?.relayTaskId) { await patch(recoveryPatch(recovered)); continue; }
            } catch (recoveryError) {
              if (recoveryReadUnavailable(recoveryError)) { await patch(recoveryWaitingPatch(r)); continue; }
              await patch(resultUnavailablePatch(r, "RESULT_ACCESS_UNAVAILABLE")); continue;
            }
          }
          if (r.status === "running" && !(error instanceof ToolError && ["PERMISSION_DENIED", "KEY_UNAVAILABLE", "PROJECT_NOT_FOUND", "TASK_NOT_FOUND"].includes(error.code))) {
            // Polling is read-only. A temporary status outage is not proof of
            // billing ambiguity and must not strand an accepted generation.
            await patch({ status: "running", errorCode: null, resultJson: stableJson({ ...parse(r.resultJson),
              statusMessage: "任务状态暂时无法更新，正在自动重试，无需重新提交。" }) });
            continue;
          }
          const storagePending = r.status === "generated" && recoveryReadUnavailable(error) && now() - Number(r.createdAt) < 24 * 60 * 60_000
            || r.status === "generated" && error instanceof ToolError && error.code === "ASSET_NOT_STORED" && now() - Number(r.createdAt) < 24 * 60 * 60_000;
          const notStarted = r.status === "queued" && (!started || error instanceof VideoGenerationNotStartedError);
          const safeCode = typeof error?.code === "string" && /^[A-Za-z][A-Za-z0-9_-]{2,99}$/u.test(error.code)
            ? error.code : "GENERATION_REQUIRES_REVIEW";
          const previous = parse(r.resultJson);
          if (!storagePending && !notStarted) {
            await patch(now() - Number(r.createdAt) >= 24 * 60 * 60_000 ? resultUnavailablePatch(r) : recoveryWaitingPatch(r));
            continue;
          }
          await patch({ status: storagePending ? "generated" : "failed", errorCode: safeCode,
            ...(!storagePending ? { resultJson: stableJson({ ...previous,
              billingStatus: notStarted ? "not_started" : previous.billingStatus || "pending_reconciliation",
              error: { code: safeCode, message: notStarted
                ? error instanceof ToolError || error instanceof VideoGenerationNotStartedError
                  ? error.message
                  : "生成在提交上游前失败，本次未冻结或扣费。请检查素材、权限和参数。"
                : "正在自动找回原任务结果，无需重新提交。" },
            }) } : {}),
          });
        } finally { clearInterval(heartbeat); }
      }
    },
  };
}
export type CreationService = ReturnType<typeof createCreationService>;
