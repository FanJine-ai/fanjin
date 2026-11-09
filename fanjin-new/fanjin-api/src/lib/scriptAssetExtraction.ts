import { createHash } from "node:crypto";

import type { Knex } from "knex";

import { insertAndReturnId, isPostgresClient } from "@/lib/dbDialect";

export type ScriptAssetType = "role" | "scene" | "tool";

export interface ScriptAssetProposalItem {
  clientId: string;
  type: ScriptAssetType;
  name: string;
  describe: string;
  prompt: string;
  parentClientId: string | null;
  stateLabel: string | null;
  scriptIds: number[];
}

export interface ScriptAssetSnapshot {
  id: number;
  name: string;
  content: string;
  contentHash: string;
}

export interface StoredScriptAssetProposal {
  kind: "script_asset_extraction_proposal/v1";
  proposalId: string;
  projectId: number;
  model: string;
  claimEpoch: number;
  scriptIds: number[];
  scriptSnapshots: ScriptAssetSnapshot[];
  assets: ScriptAssetProposalItem[];
  proposalDigest: string;
  confirmed?: {
    confirmationDigest: string;
    result: ScriptAssetConfirmationResult;
  };
}

export interface ScriptAssetConfirmationInput {
  clientId: string;
  type: ScriptAssetType;
  name: string;
  describe: string;
  prompt: string;
  parentClientId?: string | null;
  stateLabel?: string | null;
}

export interface ScriptAssetConfirmationResult {
  proposalId: string;
  savedAssetIds: number[];
  parentAssetIds: number[];
  stateAssetIds: number[];
}

export class ScriptAssetExtractionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "ScriptAssetExtractionError";
  }
}

export type ScriptAssetExtractionBillingState = {
  state: "no_reservation" | "pending" | "manual_required" | "released" | "settled";
  billingKey: string;
  reservationId: string | null;
  reconcileJobId: string | null;
  requestId: string | null;
  provider: string | null;
  channelId: string | null;
  usageStatus: string | null;
  reconcileStatus: string | null;
  reconcileDecision: string | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function scriptAssetExtractionBillingIdentity(input: {
  workspaceId: string;
  actorUserId: number;
  commandId: string;
  attempt: number;
}) {
  const providerIdempotencyKey = `${input.commandId}:extract:v1:attempt:${Math.max(0, Number(input.attempt) || 0)}`;
  const billingKey = `relay-relay-chat:${sha256(
    `${input.workspaceId}:principal:${input.actorUserId}:${providerIdempotencyKey}`,
  )}`;
  return {
    providerIdempotencyKey,
    billingKey,
    reservationIdempotencyKey: `${billingKey}:reserve`,
  };
}

/**
 * Read-only reconciliation view for one exact provider attempt. This helper
 * deliberately never advances or retries the provider command: only a
 * terminal billing release can authorize a user-created new attempt.
 */
export async function readScriptAssetExtractionBillingState(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  actorUserId: number;
  commandId: string;
  attempt: number;
}): Promise<ScriptAssetExtractionBillingState> {
  const identity = scriptAssetExtractionBillingIdentity(input);
  const reservation = await input.database("o_billing_ledger")
    .where({
      workspaceId: input.workspaceId,
      type: "freeze",
      idempotencyKey: identity.reservationIdempotencyKey,
    })
    .first();
  if (!reservation) {
    return {
      state: "no_reservation",
      billingKey: identity.billingKey,
      reservationId: null,
      reconcileJobId: null,
      requestId: null,
      provider: null,
      channelId: null,
      usageStatus: null,
      reconcileStatus: null,
      reconcileDecision: null,
    };
  }
  const reservationId = String(reservation.id || "");
  const [usage, reconcileJob, release] = await Promise.all([
    reservation.relatedUsageId
      ? input.database("o_usage_record")
          .where({ id: String(reservation.relatedUsageId), workspaceId: input.workspaceId })
          .first()
      : Promise.resolve(null),
    input.database("o_billing_reconcile_job")
      .where({ workspaceId: input.workspaceId, reservationId })
      .orderBy("updateTime", "desc")
      .first(),
    input.database("o_billing_ledger")
      .where({
        workspaceId: input.workspaceId,
        type: "release",
        relatedLedgerId: reservationId,
      })
      .whereIn("idempotencyKey", [
        `${identity.billingKey}:release`,
        `${identity.billingKey}:manual:release`,
      ])
      .first(),
  ]);
  const remainingMicros = Number(reservation.remainingMicros || 0);
  const reconcileStatus = reconcileJob ? String(reconcileJob.status || "") || null : null;
  const reconcileDecision = reconcileJob ? String(reconcileJob.decision || "") || null : null;
  const usageStatus = usage ? String(usage.status || "") || null : null;
  let state: ScriptAssetExtractionBillingState["state"];
  if (remainingMicros > 0) {
    state = reconcileStatus === "manual_required" ? "manual_required" : "pending";
  } else if (
    release
    && usageStatus === "released"
    && (
      (release.idempotencyKey === `${identity.billingKey}:release`
        && (!reconcileJob || (reconcileStatus === "resolved" && reconcileDecision === "reservation_released")))
      || (release.idempotencyKey === `${identity.billingKey}:manual:release`
        && reconcileStatus === "resolved"
        && ["manual_release_confirmed", "platform_absorb_release"].includes(reconcileDecision || ""))
    )
  ) {
    state = "released";
  } else {
    state = "settled";
  }
  return {
    state,
    billingKey: identity.billingKey,
    reservationId,
    reconcileJobId: reconcileJob ? String(reconcileJob.id || "") || null : null,
    requestId: reservation.requestId == null ? null : String(reservation.requestId),
    provider: reconcileJob?.provider == null ? null : String(reconcileJob.provider),
    channelId: reconcileJob?.channelId == null ? null : String(reconcileJob.channelId),
    usageStatus,
    reconcileStatus,
    reconcileDecision,
  };
}

function compactText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function modelText(value: unknown, field: string, maxLength: number, required = false): string {
  if (value === undefined || value === null) {
    if (!required) return "";
    throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", `${field} 必须是非空字符串`);
  }
  if (typeof value !== "string") {
    throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", `${field} 必须是字符串`);
  }
  const normalized = value.trim().slice(0, maxLength);
  if (required && !normalized) {
    throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", `${field} 必须是非空字符串`);
  }
  return normalized;
}

function modelScriptIds(value: unknown, allowedIds: Set<number>, field: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", `${field} 必须是数组`);
  }
  const ids: number[] = [];
  for (const item of value) {
    if (!Number.isSafeInteger(item) || Number(item) <= 0 || !allowedIds.has(Number(item))) {
      throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", `${field} 包含无效剧本 ID`);
    }
    const id = Number(item);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizeType(value: unknown): ScriptAssetType | null {
  return value === "role" || value === "scene" || value === "tool" ? value : null;
}

function deriveStateLabel(baseName: string, stateName: string): string {
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutBase = stateName.replace(new RegExp(`^${escaped}[\\s·・_—-]*`), "").trim();
  return withoutBase || stateName;
}

function readModelAssets(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScriptAssetExtractionError(
      422,
      "script_asset_model_output_invalid",
      "模型返回的资产提案缺少 assets 数组",
    );
  }
  const assets = (value as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) {
    throw new ScriptAssetExtractionError(
      422,
      "script_asset_model_output_invalid",
      "模型返回的资产提案缺少 assets 数组",
    );
  }
  return assets;
}

export function scriptContentHash(content: string): string {
  return sha256(content);
}

export function buildScriptAssetExtractionPrompt(scripts: ScriptAssetSnapshot[]): string {
  const source = scripts.map((script) => ({
    scriptId: script.id,
    title: script.name,
    content: script.content,
  }));
  return [
    "你是影视制作项目的视觉资产管理员。请从给定剧本中提取后续分镜和图片生成时需要单独维护视觉一致性的角色、场景和道具。准确性优先于数量；无法确定是否属于资产时不要提取。",
    "【角色 role】只提取有明确身份、姓名、称谓，持续出现，参与剧情，或需要保持外观一致的人物。不要把旁白、作者、观众、群体概念、仅被提及但未出场的人物，以及没有独立视觉设计价值的泛称人物提取为角色。若“男人、女人、路人”等泛称人物实际出场并参与动作，可以提取，但名称应结合上下文形成可区分称谓，不要仅命名为“男人”或“女生”。",
    "【场景 scene】只提取故事实际发生、需要单独生成背景或在多个镜头中保持空间一致性的地点或空间。时间、天气、光线、气氛、镜头景别和动作不是场景；不要把同一空间的不同镜头描述拆成多个场景。",
    "【道具 tool】只提取被角色拿取、使用、携带、争夺、交付、特写展示，推动剧情，具有身份识别作用，或需要跨镜头保持一致的物品。普通家具和背景陈设默认不是道具，例如沙发、抱枕、窗帘、桌椅、灯具、普通杯子、装饰品；除非剧本明确表现其被使用、参与关键动作、成为剧情线索或需要特写。人物身体部位、服装外貌、光影、声音、情绪、动作、抽象概念和台词内容都不是道具。",
    "服装通常属于角色外观描述，不要单独提取为道具；只有作为独立物品被拿取、交付、展示或推动剧情时，才可作为道具。场景中的固定设施和陈设应写入场景 description，不要拆成道具。",
    "先在内部逐项判断候选对象是否满足定义，再输出最终结果。不要为了覆盖所有名词而过度提取；同一实体在多个剧本或段落出现时应合并，不要因为称呼、镜头或描述略有不同而重复创建。",
    "角色的长期或明确视觉阶段变化可以放入 states，例如显著换装、年龄阶段、受伤前后或跨时间线造型。不要把短暂情绪、普通动作、姿势、表情、镜头角度和光线变化创建为 states。场景和道具只有发生需要保持一致的显著外观变化时才可包含 states。",
    "name 使用简洁、稳定、可区分的实体名称，不包含动作、镜头语言和长句。description 只描述可见且有依据的外观信息；原文没有的信息不要臆造。prompt 应适合生成单个资产设定图，不要添加与资产无关的人物、物品或场景。",
    "只返回一个 JSON 对象，不要 Markdown。格式：",
    '{"assets":[{"type":"role|scene|tool","name":"基础资产名称","description":"视觉描述","prompt":"图片生成提示词","scriptIds":[1],"states":[{"name":"状态资产名称","description":"状态视觉描述","prompt":"状态提示词","scriptIds":[1]}]}]}',
    "每个 scriptId 必须来自输入，并且只关联该资产实际出现或被明确引用的剧本；不要虚构数据库 ID。没有符合条件的资产时返回 {\"assets\":[]}。",
    `剧本：${JSON.stringify(source)}`,
  ].join("\n");
}

export function normalizeScriptAssetModelOutput(
  value: unknown,
  scripts: ScriptAssetSnapshot[],
): ScriptAssetProposalItem[] {
  const allowedIds = new Set(scripts.map((script) => script.id));
  const fallbackScriptIds = [...allowedIds];
  const rawAssets = readModelAssets(value);
  if (!rawAssets.length) return [];
  if (rawAssets.length > 100) {
    throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", "模型返回的基础资产数量过多");
  }

  const result: ScriptAssetProposalItem[] = [];
  rawAssets.forEach((raw, assetIndex) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", "模型返回了无效的资产条目");
    }
    const row = raw as Record<string, unknown>;
    const type = normalizeType(row.type);
    const name = modelText(row.name, "资产 name", 200, true);
    if (!type || !name) {
      throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", "模型返回的资产缺少有效类型或名称");
    }
    const clientId = `asset-${assetIndex + 1}`;
    const scriptIds = modelScriptIds(row.scriptIds, allowedIds, "资产 scriptIds");
    result.push({
      clientId,
      type,
      name,
      describe: modelText(row.describe ?? row.description, "资产 description", 5_000),
      prompt: modelText(row.prompt, "资产 prompt", 8_000),
      parentClientId: null,
      stateLabel: null,
      scriptIds: scriptIds.length ? scriptIds : fallbackScriptIds,
    });

    if (row.states !== undefined && row.states !== null && !Array.isArray(row.states)) {
      throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", `资产“${name}”的 states 必须是数组`);
    }
    const rawStates = Array.isArray(row.states) ? row.states : [];
    if (rawStates.length > 20) {
      throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", `资产“${name}”的状态数量过多`);
    }
    rawStates.forEach((rawState, stateIndex) => {
      if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
        throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", `资产“${name}”包含无效状态`);
      }
      const state = rawState as Record<string, unknown>;
      const stateName = modelText(state.name, `资产“${name}”的状态 name`, 200, true);
      if (!stateName) {
        throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", `资产“${name}”的状态缺少名称`);
      }
      const stateScriptIds = modelScriptIds(state.scriptIds, allowedIds, `资产“${name}”的状态 scriptIds`);
      result.push({
        clientId: `${clientId}-state-${stateIndex + 1}`,
        type,
        name: stateName,
        describe: modelText(state.describe ?? state.description, `资产“${name}”的状态 description`, 5_000),
        prompt: modelText(state.prompt, `资产“${name}”的状态 prompt`, 8_000),
        parentClientId: clientId,
        stateLabel: modelText(state.stateLabel, `资产“${name}”的状态 stateLabel`, 100) || deriveStateLabel(name, stateName),
        scriptIds: stateScriptIds.length ? stateScriptIds : (scriptIds.length ? scriptIds : fallbackScriptIds),
      });
    });
  });
  if (result.length > 200) {
    throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", "模型返回的资产与状态总数过多");
  }
  return result;
}

export function buildStoredScriptAssetProposal(input: {
  proposalId: string;
  projectId: number;
  model: string;
  claimEpoch: number;
  scripts: ScriptAssetSnapshot[];
  assets: ScriptAssetProposalItem[];
}): StoredScriptAssetProposal {
  const proposalDigest = sha256(JSON.stringify(input.assets));
  return {
    kind: "script_asset_extraction_proposal/v1",
    proposalId: input.proposalId,
    projectId: input.projectId,
    model: input.model,
    claimEpoch: input.claimEpoch,
    scriptIds: input.scripts.map((script) => script.id),
    scriptSnapshots: input.scripts,
    assets: input.assets,
    proposalDigest,
  };
}

export function publicScriptAssetProposal(proposal: StoredScriptAssetProposal) {
  return {
    proposalId: proposal.proposalId,
    projectId: proposal.projectId,
    scriptIds: proposal.scriptIds,
    assets: proposal.assets.map(({ scriptIds: _scriptIds, ...asset }) => asset),
  };
}

export function parseStoredScriptAssetProposal(value: unknown): StoredScriptAssetProposal {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as StoredScriptAssetProposal
    : null;
  if (
    !row
    || row.kind !== "script_asset_extraction_proposal/v1"
    || !row.proposalId
    || !Number.isSafeInteger(row.projectId)
    || !Array.isArray(row.scriptSnapshots)
    || !Array.isArray(row.assets)
  ) {
    throw new ScriptAssetExtractionError(409, "script_asset_proposal_invalid", "资产提取提案不存在或已损坏");
  }
  return row;
}

export type RecoverableScriptAssetExtraction =
  | { state: "completed"; proposal: StoredScriptAssetProposal }
  | { state: "provider_succeeded"; proposal: StoredScriptAssetProposal; reservationId: string }
  | { state: "dispatching"; reservationId: string }
  | { state: "preparing"; reservationId: string };

const ACTIVE_EXTRACTION_PREPARATION_LEASE_MS = 2 * 60 * 1_000;

function snapshotsMatch(
  expected: ScriptAssetSnapshot[],
  actual: ScriptAssetSnapshot[],
): boolean {
  const expectedIds = expected.map((script) => script.id).sort((a, b) => a - b);
  const expectedById = new Map(expected.map((script) => [script.id, script]));
  const actualIds = actual.map((script) => script.id).sort((a, b) => a - b);
  return actualIds.length === expectedIds.length
    && actualIds.every((id, index) => id === expectedIds[index])
    && actual.length === expected.length
    && actual.every((snapshot) => {
      const expectedSnapshot = expectedById.get(snapshot.id);
      return expectedSnapshot?.contentHash === snapshot.contentHash
        && expectedSnapshot.name === snapshot.name;
    });
}

export async function findRecoverableScriptAssetProposal(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  requestedModel: string | null;
  scripts: ScriptAssetSnapshot[];
  requestHash: string;
}): Promise<RecoverableScriptAssetExtraction | null> {
  const rows = await input.database("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      resourceType: "project",
      resourceId: String(input.projectId),
      requestHash: input.requestHash,
    })
    .whereIn("status", ["completed", "checkpointed"])
    .where("scopeKey", "like", `script:asset-extraction:proposal:${input.workspaceId}:%`)
    .orderBy("updatedAt", "desc")
    .limit(50)
    .select("id", "status", "responseBody", "createdAt", "updatedAt");
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row.responseBody || "null"));
      if (String(row.status) === "completed") {
        const proposal = parseStoredScriptAssetProposal(parsed);
        if (
          proposal.proposalId !== String(row.id)
          ||
          proposal.confirmed
          || proposal.projectId !== input.projectId
          || (input.requestedModel && proposal.model !== input.requestedModel)
          || !snapshotsMatch(input.scripts, proposal.scriptSnapshots)
        ) continue;
        return { state: "completed", proposal };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const checkpoint = parsed as {
        phase?: unknown;
        projectId?: unknown;
        requestedModel?: unknown;
        scripts?: unknown;
        storedProposal?: unknown;
      };
      if (
        Number(checkpoint.projectId) !== input.projectId
        || (String(checkpoint.requestedModel || "").trim() || null) !== input.requestedModel
        || !Array.isArray(checkpoint.scripts)
        || !snapshotsMatch(input.scripts, checkpoint.scripts as ScriptAssetSnapshot[])
      ) continue;
      if (checkpoint.phase === "dispatching") {
        return { state: "dispatching", reservationId: String(row.id) };
      }
      if (checkpoint.phase === "provider_succeeded") {
        const proposal = parseStoredScriptAssetProposal(checkpoint.storedProposal);
        if (proposal.confirmed) continue;
        return {
          state: "provider_succeeded",
          proposal,
          reservationId: String(row.id),
        };
      }
      if (
        checkpoint.phase === "preparing"
        && Date.now() - Number(row.updatedAt || 0) <= ACTIVE_EXTRACTION_PREPARATION_LEASE_MS
      ) {
        return { state: "preparing", reservationId: String(row.id) };
      }
    } catch {
      // Completed error responses and older checkpoint formats are not
      // recoverable proposals; keep searching without exposing their body.
    }
  }
  return null;
}

function normalizedConfirmation(
  proposal: StoredScriptAssetProposal,
  input: ScriptAssetConfirmationInput[],
): Array<ScriptAssetConfirmationInput & { parentClientId: string | null; stateLabel: string | null }> {
  const proposedById = new Map(proposal.assets.map((item) => [item.clientId, item]));
  const seen = new Set<string>();
  const selected = input.map((item) => {
    const clientId = compactText(item.clientId, 120);
    const proposed = proposedById.get(clientId);
    const type = normalizeType(item.type);
    const name = compactText(item.name, 200);
    if (!proposed || !clientId || seen.has(clientId) || !type || !name) {
      throw new ScriptAssetExtractionError(400, "script_asset_confirmation_invalid", "确认内容包含未知、重复或无效的资产");
    }
    const parentClientId = compactText(item.parentClientId, 120) || null;
    if (type !== proposed.type || parentClientId !== proposed.parentClientId) {
      throw new ScriptAssetExtractionError(
        400,
        "script_asset_confirmation_invalid",
        "资产类型与基础资产关系不能在确认时修改",
      );
    }
    seen.add(clientId);
    return {
      clientId,
      type,
      name,
      describe: compactText(item.describe, 5_000),
      prompt: compactText(item.prompt, 8_000),
      parentClientId,
      stateLabel: compactText(item.stateLabel, 100) || null,
    };
  });
  if (!selected.length) {
    throw new ScriptAssetExtractionError(400, "script_asset_confirmation_invalid", "请至少选择一个要保存的资产");
  }
  const byId = new Map(selected.map((item) => [item.clientId, item]));
  for (const item of selected) {
    if (!item.parentClientId) continue;
    const parent = byId.get(item.parentClientId);
    if (
      !parent
      || parent.clientId === item.clientId
      || parent.parentClientId
      || parent.type !== item.type
    ) {
      throw new ScriptAssetExtractionError(400, "script_asset_confirmation_invalid", "状态资产必须引用同类型且已勾选的基础资产");
    }
  }
  return selected.sort((left, right) => left.clientId.localeCompare(right.clientId));
}

function canonicalAssetName(value: unknown): string {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

async function findReusableAsset(input: {
  transaction: Knex.Transaction;
  projectId: number;
  type: ScriptAssetType;
  name: string;
  parentAssetId: number | null;
  stateLabel?: string | null;
}): Promise<number | null> {
  let query = input.transaction("o_assets")
    .where({ projectId: input.projectId, type: input.type })
    .andWhere((builder) => builder.whereNull("deletionState").orWhere("deletionState", "active"));
  query = input.parentAssetId == null
    ? query.whereNull("assetsId")
    : query.where("assetsId", input.parentAssetId);
  const rows = await query.select("id", "name", "remark");
  const match = rows.find((row) => {
    if (canonicalAssetName(row.name) !== canonicalAssetName(input.name)) return false;
    if (input.parentAssetId == null) return true;
    let stateLabel: string | undefined;
    try { stateLabel = JSON.parse(String(row.remark || "{}"))?.stateLabel; } catch { /* Legacy remarks are plain text. */ }
    return !stateLabel || canonicalAssetName(stateLabel) === canonicalAssetName(input.stateLabel || input.name);
  });
  return match ? Number(match.id) : null;
}

export async function confirmScriptAssetProposal(input: {
  transaction: Knex.Transaction;
  workspaceId: string;
  projectId: number;
  proposalId: string;
  assets: ScriptAssetConfirmationInput[];
}): Promise<ScriptAssetConfirmationResult> {
  let proposalQuery = input.transaction("o_agent_idempotency")
    .where({
      id: input.proposalId,
      workspaceId: input.workspaceId,
      status: "completed",
    })
    .andWhere((builder) => builder
      .where("scopeKey", "like", `script:asset-extraction:proposal:${input.workspaceId}:%`)
      .orWhere("scopeKey", "like", `script:asset-extraction:batch-proposal:${input.workspaceId}:%`))
    .select("id", "responseBody")
    .first();
  if (isPostgresClient(input.transaction)) proposalQuery = proposalQuery.forUpdate();
  const proposalRow = await proposalQuery;
  if (!proposalRow) {
    throw new ScriptAssetExtractionError(404, "script_asset_proposal_not_found", "资产提取提案不存在或无权访问");
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(String(proposalRow.responseBody || "null"));
  } catch {
    throw new ScriptAssetExtractionError(409, "script_asset_proposal_invalid", "资产提取提案已损坏");
  }
  const proposal = parseStoredScriptAssetProposal(parsedBody);
  if (proposal.projectId !== input.projectId || proposal.proposalId !== input.proposalId) {
    throw new ScriptAssetExtractionError(404, "script_asset_proposal_not_found", "资产提取提案不属于当前项目");
  }
  const selected = normalizedConfirmation(proposal, input.assets);
  const confirmationDigest = sha256(JSON.stringify(selected));
  if (proposal.confirmed) {
    if (proposal.confirmed.confirmationDigest !== confirmationDigest) {
      throw new ScriptAssetExtractionError(409, "script_asset_proposal_already_confirmed", "该提案已用另一组内容确认，不能重复修改保存");
    }
    return proposal.confirmed.result;
  }

  const currentScripts = await input.transaction("o_script")
    .where({ projectId: input.projectId })
    .whereIn("id", proposal.scriptIds)
    .select("id", "name", "content");
  const currentById = new Map(currentScripts.map((row) => [Number(row.id), {
    name: String(row.name || `剧本 ${Number(row.id)}`),
    content: String(row.content || ""),
  }]));
  const stale = proposal.scriptSnapshots.some((snapshot) => {
    const current = currentById.get(snapshot.id);
    return !current
      || current.name !== snapshot.name
      || scriptContentHash(current.content) !== snapshot.contentHash;
  });
  if (stale || currentScripts.length !== proposal.scriptSnapshots.length) {
    throw new ScriptAssetExtractionError(409, "script_asset_proposal_stale", "剧本内容已变化或不存在，请重新提取资产");
  }

  const proposedById = new Map(proposal.assets.map((item) => [item.clientId, item]));
  const assetIdByClientId = new Map<string, number>();
  const parentAssetIds: number[] = [];
  const stateAssetIds: number[] = [];
  const ordered = [
    ...selected.filter((item) => !item.parentClientId),
    ...selected.filter((item) => item.parentClientId),
  ];
  for (const item of ordered) {
    const parentAssetId = item.parentClientId
      ? assetIdByClientId.get(item.parentClientId) ?? null
      : null;
    if (item.parentClientId && !parentAssetId) {
      throw new ScriptAssetExtractionError(400, "script_asset_confirmation_invalid", "状态资产引用的基础资产尚未保存");
    }
    let assetId = await findReusableAsset({
      transaction: input.transaction,
      projectId: input.projectId,
      type: item.type,
      name: item.name,
      parentAssetId,
      stateLabel: item.stateLabel,
    });
    const original = proposedById.get(item.clientId)!;
    if (!assetId) {
      assetId = await insertAndReturnId(input.transaction, "o_assets", {
        projectId: input.projectId,
        scriptId: original.scriptIds[0] ?? proposal.scriptIds[0] ?? null,
        type: item.type,
        name: item.name,
        describe: item.describe,
        prompt: item.prompt,
        assetsId: parentAssetId,
        deletionState: "active",
        ...(item.parentClientId
          ? { remark: JSON.stringify({ source: "script_asset_extraction", stateLabel: item.stateLabel || item.name }) }
          : {}),
      });
    }
    assetIdByClientId.set(item.clientId, assetId);
    (item.parentClientId ? stateAssetIds : parentAssetIds).push(assetId);

    const scriptIds = original.scriptIds.length ? original.scriptIds : proposal.scriptIds;
    const existingLinks = await input.transaction("o_scriptAssets")
      .where({ assetId })
      .whereIn("scriptId", scriptIds)
      .select("scriptId");
    const linkedIds = new Set(existingLinks.map((row) => Number(row.scriptId)));
    const missing = scriptIds.filter((scriptId) => !linkedIds.has(scriptId));
    for (let offset = 0; offset < missing.length; offset += 250) {
      await input.transaction("o_scriptAssets").insert(missing.slice(offset, offset + 250).map((scriptId) => ({ scriptId, assetId })));
    }
  }

  const result: ScriptAssetConfirmationResult = {
    proposalId: proposal.proposalId,
    savedAssetIds: ordered.map((item) => assetIdByClientId.get(item.clientId)!),
    parentAssetIds,
    stateAssetIds,
  };
  proposal.confirmed = { confirmationDigest, result };
  const updated = await input.transaction("o_agent_idempotency")
    .where({ id: input.proposalId, workspaceId: input.workspaceId, status: "completed" })
    .update({ responseBody: JSON.stringify(proposal), updatedAt: Date.now() });
  if (Number(updated) !== 1) {
    throw new ScriptAssetExtractionError(409, "script_asset_proposal_conflict", "资产提取提案状态已变化，请重试");
  }
  return result;
}
