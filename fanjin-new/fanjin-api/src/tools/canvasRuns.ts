import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { EXTERNAL_TOOL_TABLE as TABLE } from "@/lib/migrations/externalTools";
import { ToolError, guAmount } from "./contracts";
import { generationRequestSchema } from "./creationContracts";
import type { ToolIdentity } from "./creationService";
import { stableJson } from "./serialization";
import { planCanvasGroupExecution } from "../../../../contracts/canvas/groupExecution";

const KIND = "fanjin_canvas_run_start";
const scope = (i: ToolIdentity) => ({ workspaceId: i.workspaceId, keyId: i.keyId, userId: i.userId });
const parse = (value: any) => typeof value === "string" ? JSON.parse(value) : value;
const hash = (value: any) => createHash("sha256").update(stableJson(value)).digest("hex");
const atoms = (gu: string) => { const [a, b = ""] = gu.split("."); return BigInt(a) * 100_000_000n + BigInt(b.padEnd(8, "0")); };
const permit = (ps: string[], p: string) => ps.some(x => x === "*" || x === p || x.endsWith(":*") && p.startsWith(x.slice(0, -1)));
const need = (ok: unknown, code: string, message: string, status = 409) => { if (!ok) throw new ToolError(code, message, status); };
type Call = (keyId: string, name: string, input: any) => Promise<Record<string, any>>;
type RunState = { version: number; intent: "run" | "pause" | "cancel"; revision: number; budgetGu: string; error?: { code: string; message: string } | null; steps: any[] };
export function createCanvasRuns(db: Knex, call: Call, identityFor: (keyId: string) => Promise<ToolIdentity>, now = Date.now) {
  async function canvas(i: ToolIdentity, request: any) {
    need(await db("o_project").where({ id: request.projectId, workspaceId: i.workspaceId, deletionState: "active" }).first(), "PROJECT_NOT_FOUND", "项目不存在或无权访问", 404);
    const c = await db("o_workflow_graph").where({ id: request.canvasId, projectId: request.projectId }).first();
    need(c, "CANVAS_NOT_FOUND", "画布不存在", 404); return c;
  }
  function writePermission(i: ToolIdentity) {
    for (const p of ["generation:create", "generation:quote", "generation:read", "project:read", "project:write"]) {
      need(permit(i.permissions, p), "PERMISSION_DENIED", "整组执行缺少生成、报价或画布权限", 403);
    }
    need(permit(i.memberPermissions, "generation:create") && permit(i.memberPermissions, "project:write"), "PERMISSION_DENIED", "成员没有整组执行权限", 403);
  }
  async function row(i: ToolIdentity, runId: string) {
    const r = await db(TABLE).where({ id: runId, kind: KIND, ...scope(i) }).first();
    need(r, "RUN_NOT_FOUND", "任务不存在或无权访问", 404);
    await canvas(i, parse(r.requestJson)); return r;
  }
  function view(r: any) {
    const s: RunState = parse(r.resultJson), request = parse(r.requestJson);
    const committed = s.steps.reduce((total, step) => total + BigInt(step.maximumMicros || "0"), 0n);
    return { runId: r.id, projectId: Number(r.projectId), canvasId: request.canvasId, status: r.status,
      version: s.version, expectedRevision: s.revision, intent: s.intent, budget: guAmount(atoms(s.budgetGu)),
      acceptedMaximum: guAmount(committed), budgetNote: "已受理/准备提交节点的最高报价合计，不代表实际扣费；逐任务查账。",
      error: s.error || null, steps: s.steps.map(step => ({ nodeId: step.nodeId, status: step.status,
        taskId: step.taskId || null, quoteId: step.quote?.quoteId || null, maximum: guAmount(BigInt(step.maximumMicros || "0")), nextQuoteMaximum: step.quote?.maximum || null,
        assets: step.assets || [], error: step.error || null, canvasDelivery: step.canvasDelivery || null })),
      createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt),
    };
  }
  async function execute(i: ToolIdentity, name: string, input: any): Promise<Record<string, any>> {
    if (name === "fanjin_canvas_runs_list") {
      need(await db("o_project").where({ id: input.projectId, workspaceId: i.workspaceId, deletionState: "active" }).first(), "PROJECT_NOT_FOUND", "项目不存在", 404);
      const rows = await db(TABLE).where({ kind: KIND, ...scope(i), projectId: input.projectId }).orderBy("createdAt", "desc").limit(500);
      return { runs: rows.filter(r => !input.canvasId || parse(r.requestJson).canvasId === input.canvasId).slice(0, input.limit).map(view) };
    }
    if (name === "fanjin_canvas_run_get") return view(await row(i, input.runId));
    writePermission(i);
    if (name === KIND) {
      const { idempotencyKey, ...request } = input;
      const prior = await db(TABLE).where({ kind: KIND, ...scope(i), idempotencyKey }).first();
      if (prior) { need(prior.requestHash === hash(request), "IDEMPOTENCY_CONFLICT", "同一键不能启动不同节点任务"); return view(await row(i, prior.id)); }
      const c = await canvas(i, request);
      need(Number(c.revision || 1) === request.expectedRevision, "CANVAS_REVISION_CONFLICT", "请重新读取画布后提交");
      const nodes: any[] = parse(c.nodes), steps: any[] = request.steps;
      need(new Set(steps.map(s => s.nodeId)).size === steps.length, "DUPLICATE_NODE", "一个节点只能出现在一组任务中一次", 400);
      const selected = steps.map(step => {
        const node = nodes.find(n => n.id === step.nodeId), data = node?.data || node;
        need(node && node.type === step.request.type && step.request.projectId === request.projectId, "NODE_REQUEST_MISMATCH", "请求的项目或类型与画布节点不符", 400);
        need(!data.isGenerating && !["running", "queued", "processing", "preparing", "submitting"].includes(data.taskStatus), "NODE_BUSY", "节点已有正在执行的任务");
        need(step.outputReferences.every((r: any) => steps.some(s => s.nodeId === r.nodeId)), "DEPENDENCY_NOT_FOUND", "输出引用必须指向本组节点", 400);
        need(!step.outputReferences.length || step.request.renderMode !== "finalize", "INVALID_DEPENDENCY", "样片转正式继承原参数，不能添加输出参考", 400);
        return { id: node.id, x: Number(node.x ?? node.position?.x) || 0, y: Number(node.y ?? node.position?.y) || 0 };
      });
      const edges = [...(parse(c.edges || "[]") as any[]).map(e => ({ fromNodeId: e.fromNodeId ?? e.source, toNodeId: e.toNodeId ?? e.target })),
        ...steps.flatMap(s => s.outputReferences.map((r: any) => ({ fromNodeId: r.nodeId, toNodeId: s.nodeId })))];
      const plan = planCanvasGroupExecution(selected, edges);
      need(!plan.cycleNodeIds.length, "DEPENDENCY_CYCLE", "节点存在循环依赖", 400);
      const state: RunState = { version: 1, intent: "run", revision: request.expectedRevision, budgetGu: request.budgetGu,
        steps: plan.orderedNodes.map(n => ({ nodeId: n.id, status: "pending" })) };
      const runId = randomUUID();
      return db.transaction(async tx => {
      const lockedCanvas = await tx("o_workflow_graph").where({ id: request.canvasId, projectId: request.projectId }).forUpdate().first();
      need(lockedCanvas && Number(lockedCanvas.revision || 1) === request.expectedRevision, "CANVAS_REVISION_CONFLICT", "画布已修改，请重新读取后提交");
      const replay = await tx(TABLE).where({ kind: KIND, ...scope(i), idempotencyKey }).first();
      if (replay) { need(replay.requestHash === hash(request), "IDEMPOTENCY_CONFLICT", "幂等键冲突"); return view(replay); }
      const active = await tx(TABLE).where({ kind: KIND, workspaceId: i.workspaceId, projectId: request.projectId }).whereIn("status", ["running", "paused"]);
      need(!active.some(a => parse(a.requestJson).canvasId === request.canvasId), "CANVAS_RUN_BUSY", "此画布已有后台任务，请先查询或停止原任务");
      await tx(TABLE).insert({ id: runId, kind: KIND, ...scope(i), projectId: request.projectId, idempotencyKey,
        requestHash: hash(request), requestJson: stableJson(request), resultJson: stableJson(state), status: "running", createdAt: now(), updatedAt: now() })
        .onConflict(["workspaceId", "keyId", "kind", "idempotencyKey"]).ignore();
      const saved = await tx(TABLE).where({ kind: KIND, ...scope(i), idempotencyKey }).first();
      need(saved.requestHash === hash(request), "IDEMPOTENCY_CONFLICT", "同一键不能启动不同节点任务"); return view(saved);
      });
    }
    await row(i, input.runId);
    return db.transaction(async tx => {
      const r = await tx(TABLE).where({ id: input.runId, kind: KIND, ...scope(i) }).forUpdate().first();
      const s: RunState = parse(r.resultJson);
      need(s.version === input.expectedVersion, "RUN_VERSION_CONFLICT", "任务已更新，请重新查询");
      need(!["succeeded", "cancelled", "failed"].includes(r.status), "RUN_TERMINAL", "已结束的组不能重投，请为新的生成建立新任务");
      if (input.action === "resume") {
        need(r.status === "paused", "RUN_NOT_PAUSED", "仅暂停的任务可以继续");
        if (input.budgetGu !== undefined) {
          need(atoms(input.budgetGu) >= s.steps.reduce((n, step) => n + BigInt(step.maximumMicros || "0"), 0n), "BUDGET_EXCEEDED", "新预算低于已受理的最高报价");
          s.budgetGu = input.budgetGu;
        }
        if (input.expectedRevision !== undefined) s.revision = input.expectedRevision;
        s.error = null;
      } else need(input.budgetGu === undefined && input.expectedRevision === undefined, "INVALID_ARGUMENTS", "仅继续操作可以修改预算和画布版本", 400);
      s.intent = input.action === "resume" ? "run" : input.action; s.version++;
      const status = s.intent === "run" ? "running" : s.intent === "pause" ? "paused" : "cancelled";
      await tx(TABLE).where({ id: r.id }).update({ resultJson: stableJson(s), status, updatedAt: now() });
      return view({ ...r, resultJson: stableJson(s), status, updatedAt: now() });
    });
  }

  async function tick(shouldContinue = () => true) {
    const rows = await db(TABLE).where({ kind: KIND, status: "running" })
      .andWhere(q => q.whereNull("claimedBy").orWhere("updatedAt", "<", now() - 120_000)).orderBy("updatedAt").limit(4);
    for (const r of rows) {
      if (!shouldContinue()) break;
      const lease = randomUUID();
      if (!await db(TABLE).where({ id: r.id, status: r.status, updatedAt: r.updatedAt }).where(q => q.whereNull("claimedBy").orWhere("updatedAt", "<", now() - 120_000)).update({ claimedBy: lease, updatedAt: now() })) continue;
      const heartbeat = setInterval(() => { void db(TABLE).where({ id: r.id, claimedBy: lease }).update({ updatedAt: now() }).catch(() => {}); }, 10_000);
      heartbeat.unref();
      // Merge under lock to preserve a concurrent pause/cancel. A lost lease
      // cannot checkpoint or advance; child submission has its own stable key.
      async function patch(change: (state: RunState) => void, status?: string) {
        return db.transaction(async tx => {
          const current = await tx(TABLE).where({ id: r.id, claimedBy: lease }).forUpdate().first();
          need(current, "RUN_LEASE_LOST", "任务已由另一个执行器接管");
          const state: RunState = parse(current.resultJson); change(state); state.version++;
          const nextStatus = state.intent === "cancel" ? "cancelled" : state.intent === "pause" ? "paused" : status || current.status;
          await tx(TABLE).where({ id: r.id, claimedBy: lease }).update({ resultJson: stableJson(state), status: nextStatus, updatedAt: now() });
          return state;
        });
      }
      try {
        const i = await identityFor(r.keyId); writePermission(i);
        need(i.userId === Number(r.userId) && i.workspaceId === r.workspaceId, "PERMISSION_DENIED", "任务所属身份已改变", 403);
        const request = parse(r.requestJson), c = await canvas(i, request);
        const latest = await db(TABLE).where({ id: r.id, claimedBy: lease }).first();
        need(latest, "RUN_LEASE_LOST", "执行器已接管");
        const state: RunState = parse(latest.resultJson);
        if (state.intent !== "run") continue;
        const index = state.steps.findIndex(s => s.status !== "delivered");
        if (index < 0) { await patch(s => { s.error = null; }, "succeeded"); continue; }
        const step = state.steps[index], spec = request.steps.find((s: any) => s.nodeId === step.nodeId);
        const childKey = `run:${r.id}:${index}`;
        // Receipt lookup is first on every recovery, before quote expiry or any
        // attempt to submit. Never create a second child for this step.
        const receipt = await db(TABLE).where({ ...scope(i), kind: "fanjin_generation_submit", idempotencyKey: childKey }).first();
        if (receipt) {
          const task = await call(i.keyId, "fanjin_task_get", { taskId: receipt.id });
          await patch(s => { Object.assign(s.steps[index], { taskId: receipt.id, status: task.deliveryReady ? "saved" : task.executionStatus, assets: task.assets, canvasDelivery: task.canvasDelivery }); });
          if (["failed", "cancelled"].includes(task.executionStatus)) {
            await patch(s => { s.steps[index].error = { code: task.errorCode, message: task.errorMessage }; s.error = { code: "CHILD_FAILED", message: "节点未完成，整组已停止；已保存作品和原任务编号保留，不自动重投" }; }, "failed"); continue;
          }
          if (!task.deliveryReady) continue;
          let delivery = task.canvasDelivery;
          if (delivery?.status !== "attached") {
            delivery = await call(i.keyId, "fanjin_canvas_attach", { projectId: request.projectId, canvasId: request.canvasId,
              taskId: receipt.id, nodeId: step.nodeId, expectedRevision: state.revision, idempotencyKey: `${childKey}:attach:${state.revision}` });
          }
          need(Number.isSafeInteger(Number(delivery.revision)), "CANVAS_DELIVERY_UNAVAILABLE", "作品已保存，回填尚未完成");
          await patch(s => { s.steps[index].status = "delivered"; s.steps[index].canvasDelivery = delivery; s.revision = Number(delivery.revision); });
          continue;
        }
        need(Number(c.revision || 1) === state.revision, "CANVAS_REVISION_CONFLICT", "画布已修改，尚未提交下一节点；查询后用新版本继续");
        if (!step.quote || Number(step.quote.expiresAt) <= now()) {
          const resolved = structuredClone(spec.request);
          for (const ref of spec.outputReferences) {
            const dependency = state.steps.find(s => s.nodeId === ref.nodeId);
            const asset = dependency?.status === "delivered" ? dependency.assets?.[ref.assetIndex] : null;
            need(asset?.assetVersionId, "DEPENDENCY_OUTPUT_MISSING", "依赖节点的指定作品尚未保存");
            resolved.references.push({ assetVersionId: String(asset.assetVersionId), role: ref.role });
            if (ref.role === "source_video") resolved.sourceAssetVersionId = String(asset.assetVersionId);
          }
          const normalized = generationRequestSchema.parse(resolved);
          if (normalized.renderMode !== "finalize") await call(i.keyId, "fanjin_model_get", { modelId: normalized.modelId, type: normalized.type });
          const attempt = (step.quoteAttempt || 0) + 1;
          const quote = await call(i.keyId, "fanjin_generation_quote", { request: normalized, idempotencyKey: `${childKey}:q:${attempt}` });
          await patch(s => { Object.assign(s.steps[index], { quote, quoteAttempt: attempt, status: "quoted" }); });
          continue;
        }
        const maximum = BigInt(step.quote.maximum.guMicros);
        const ready = await patch(s => {
          const total = s.steps.reduce((sum, step, n) => sum + (n === index ? 0n : BigInt(step.maximumMicros || "0")), maximum);
          need(total <= atoms(s.budgetGu), "RUN_BUDGET_EXCEEDED", "下一节点报价超过整组剩余预算，尚未提交；可提高预算后继续");
          Object.assign(s.steps[index], { status: "submitting", maximumMicros: maximum.toString() });
        });
        if (ready.intent !== "run" || !shouldContinue()) continue;
        const task = await call(i.keyId, "fanjin_generation_submit", { quoteId: step.quote.quoteId, budgetGu: step.quote.maximum.gu,
          targetCanvas: { canvasId: request.canvasId, nodeId: step.nodeId, expectedRevision: state.revision }, idempotencyKey: childKey });
        await patch(s => { Object.assign(s.steps[index], { taskId: task.taskId, status: task.executionStatus }); });
      } catch (e) {
        if (!(e instanceof ToolError && e.code === "RUN_LEASE_LOST")) {
          await patch(s => {
            if (e instanceof ToolError && ["QUOTE_CHANGED", "AUTHORIZATION_EXPIRED"].includes(e.code)) {
              const step = s.steps.find(item => item.status !== "delivered");
              if (step && !step.taskId) { step.quote = null; step.maximumMicros = "0"; }
            }
            s.error = { code: e instanceof ToolError ? e.code : "RUN_TEMPORARILY_UNAVAILABLE", message: e instanceof ToolError ? e.message : "任务暂时无法继续，原任务与作品已保留；查询后继续" }; }, "paused").catch(() => {});
        }
      } finally {
        clearInterval(heartbeat);
        await db(TABLE).where({ id: r.id, claimedBy: lease }).update({ claimedBy: null, updatedAt: now() });
      }
    }
  }
  return { execute, tick };
}
