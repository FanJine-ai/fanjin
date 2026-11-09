import { createHash } from "node:crypto";
import type { Knex } from "knex";

import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  beginDurableCommand,
  DurableCommandIdempotencyError,
} from "@/lib/durableCommandIdempotency";
import { db } from "@/utils/db";

export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_FORMAT =
  "fanjin-release-full-maintenance-private-validation-budget/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_AUTHORITY_FORMAT =
  "fanjin-release-full-maintenance-private-validation-budget-authority/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_HANDLE_FORMAT =
  "fanjin-release-full-maintenance-private-validation-budget-handle/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SLOT_BINDING_FORMAT =
  "fanjin-release-full-maintenance-private-validation-budget-slot-binding/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_FINAL_FORMAT =
  "fanjin-release-full-maintenance-private-validation-budget-final/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SCOPE =
  "release:private-validation-budget" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_RESOURCE_TYPE =
  "release_private_validation_budget" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_RELAY_EVIDENCE_KEY =
  "releaseFullMaintenancePrivateValidationBudget" as const;

export const releaseFullMaintenancePrivateValidationBudgetSlots = [
  "seedance",
  "portrait",
] as const;

export type ReleaseFullMaintenancePrivateValidationBudgetSlotName =
  (typeof releaseFullMaintenancePrivateValidationBudgetSlots)[number];

export type ReleaseFullMaintenancePrivateValidationBudgetSlotState =
  | "empty"
  | "claimed"
  | "gu_reserved"
  | "dispatch_started"
  | "settled"
  | "released_prebilling"
  | "released_predispatch"
  | "pending_reconcile"
  | "terminal_no_charge";

export type ReleaseFullMaintenancePrivateValidationBudgetStatus =
  | "open"
  | "pending_reconcile"
  | "settled"
  | "failed";

type BudgetDatabase = Knex | Knex.Transaction;

export class ReleaseFullMaintenancePrivateValidationBudgetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "ReleaseFullMaintenancePrivateValidationBudgetError";
  }
}

export interface ReleaseFullMaintenancePrivateValidationBudgetAuthority {
  deploymentId: string;
  contractSha256: string;
  releaseBindingSha256: string;
  validationPlanIntentSha256: string;
  validationPlanSha256: string;
  workspaceId: string;
  projectId: number;
  ownerAdminUserId: number;
  slotActors: Readonly<Record<ReleaseFullMaintenancePrivateValidationBudgetSlotName, number>>;
  currency: "GU";
  maximumProviderTasks: 2;
  maximumGuMicros: number;
  authorizedExpiresAt: number;
}

export interface ReleaseFullMaintenancePrivateValidationBudgetHandle {
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_HANDLE_FORMAT;
  budgetId: string;
  deploymentId: string;
  releaseBindingSha256: string;
  workspaceId: string;
  projectId: number;
  ownerAdminUserId: number;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
  authoritySha256: string;
  handleSha256: string;
}

export interface ReleaseFullMaintenancePrivateValidationBudgetSlotBinding {
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SLOT_BINDING_FORMAT;
  budgetId: string;
  deploymentId: string;
  releaseBindingSha256: string;
  workspaceId: string;
  projectId: number;
  ownerAdminUserId: number;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
  authoritySha256: string;
  slot: ReleaseFullMaintenancePrivateValidationBudgetSlotName;
  slotId: string;
  actorUserId: number;
  claimKeySha256: string;
  claimRequestSha256: string;
  bindingSha256: string;
}

export interface ReleaseFullMaintenancePrivateValidationBudgetSlotCheckpoint {
  slot: ReleaseFullMaintenancePrivateValidationBudgetSlotName;
  slotId: string;
  actorUserId: number;
  claimKeySha256: string | null;
  claimRequestSha256: string | null;
  state: ReleaseFullMaintenancePrivateValidationBudgetSlotState;
  requestId: string | null;
  provider: string | null;
  channelId: string | null;
  model: string | null;
  pricingEvidenceSha256: string | null;
  taskId: string | null;
  reservationId: string | null;
  usageRecordId: string | null;
  providerTaskIdSha256: string | null;
  reservedGuMicros: number;
  actualGuMicros: number | null;
  dispatchStartedAt: number | null;
  terminalAt: number | null;
  evidenceSha256: string | null;
}

export interface ReleaseFullMaintenancePrivateValidationBudgetCheckpoint {
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_FORMAT;
  deploymentId: string;
  contractSha256: string;
  releaseBindingSha256: string;
  validationPlanIntentSha256: string;
  validationPlanSha256: string;
  workspaceId: string;
  projectId: number;
  ownerAdminUserId: number;
  currency: "GU";
  maximumProviderTasks: 2;
  maximumGuMicros: number;
  authorizedExpiresAt: number;
  authoritySha256: string;
  revision: number;
  status: ReleaseFullMaintenancePrivateValidationBudgetStatus;
  slots: Readonly<Record<
    ReleaseFullMaintenancePrivateValidationBudgetSlotName,
    ReleaseFullMaintenancePrivateValidationBudgetSlotCheckpoint
  >>;
  checkpointSha256: string;
}

export interface ReleaseFullMaintenancePrivateValidationBudgetDispatchBoundary {
  workspaceId: string;
  reservationId: string;
  usageRecordId: string;
  requestId: string | null;
  provider: string | null;
  channelId: string | null;
  reconcileJobId: string;
  dispatchStartedAt: number;
  dispatchWatchdogAt: number;
}

export interface ReleaseFullMaintenancePrivateValidationBudgetSettlement {
  usage: {
    id: string;
    taskId: string | null;
    workspaceId: string | null;
    provider: string | null;
    channelId: string | null;
    endpointType: string;
    costMicros: number;
    currency: string;
    status: string;
  };
  reservation: {
    id: string;
    workspaceId: string;
    type: string;
    amountMicros: number;
    remainingMicros: number;
    requestId: string | null;
    usageRecordId: string | null;
    taskId: string | null;
  };
  captureLedger: { id: string; amountMicros: number } | null;
  releaseLedger: { id: string; amountMicros: number } | null;
  overageLedger: { id: string; amountMicros: number } | null;
  idempotent: boolean;
}

export interface ReleaseFullMaintenancePrivateValidationBudgetFinalEvidence {
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_FINAL_FORMAT;
  budgetId: string;
  deploymentId: string;
  releaseBindingSha256: string;
  validationPlanSha256: string;
  workspaceId: string;
  projectId: number;
  maximumProviderTasks: 2;
  maximumGuMicros: number;
  providerTaskCount: 2;
  totalReservedGuMicros: number;
  totalActualGuMicros: number;
  checkpointSha256: string;
  slots: readonly Readonly<{
    slot: ReleaseFullMaintenancePrivateValidationBudgetSlotName;
    taskId: string;
    requestId: string;
    providerTaskIdSha256: string;
    reservationId: string;
    usageRecordId: string;
    reservedGuMicros: number;
    actualGuMicros: number;
    terminalLedgerIds: readonly string[];
    reconcileJobId: string;
    evidenceSha256: string;
  }>[];
  evidenceSha256: string;
}

function budgetError(code: string, message: string, status = 409): never {
  throw new ReleaseFullMaintenancePrivateValidationBudgetError(code, message, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) budgetError("private_validation_budget_invalid", `${label} 不是对象`, 500);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    budgetError("private_validation_budget_invalid", `${label} 字段不精确`, 500);
  }
}

function boundedText(value: unknown, label: string, maximum = 512): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    budgetError("private_validation_budget_invalid", `${label} 无效`, 500);
  }
  return normalized;
}

function nullableBoundedText(value: unknown, label: string, maximum = 512): string | null {
  if (value === null) return null;
  return boundedText(value, label, maximum);
}

function positiveSafeInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    budgetError("private_validation_budget_invalid", `${label} 必须为正安全整数`, 500);
  }
  return normalized;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    budgetError("private_validation_budget_invalid", `${label} 必须为非负安全整数`, 500);
  }
  return normalized;
}

function nullablePositiveSafeInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  return positiveSafeInteger(value, label);
}

function nullableNonNegativeSafeInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  return nonNegativeSafeInteger(value, label);
}

function sha256(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    budgetError("private_validation_budget_invalid", `${label} 不是 SHA-256`, 500);
  }
  return normalized;
}

function nullableSha256(value: unknown, label: string): string | null {
  if (value === null) return null;
  return sha256(value, label);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function releaseFullMaintenancePrivateValidationBudgetSha256(value: unknown): string {
  return hashIdempotencyRequest(value);
}

const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SETTLEMENT_FORMAT =
  "fanjin-release-full-maintenance-private-validation-budget-settlement/v1" as const;

function privateValidationBudgetSettlementEvidenceSha256(input: {
  bindingSha256: string;
  taskId: string;
  requestId: string;
  providerTaskIdSha256: string;
  reservationId: string;
  usageRecordId: string;
  reservedGuMicros: number;
  actualGuMicros: number;
  terminalLedgerIds: readonly string[];
  reconcileJobId: string;
}): string {
  return releaseFullMaintenancePrivateValidationBudgetSha256({
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SETTLEMENT_FORMAT,
    bindingSha256: input.bindingSha256,
    taskId: input.taskId,
    requestId: input.requestId,
    providerTaskIdSha256: input.providerTaskIdSha256,
    reservationId: input.reservationId,
    usageRecordId: input.usageRecordId,
    reservedGuMicros: input.reservedGuMicros,
    actualGuMicros: input.actualGuMicros,
    terminalLedgerIds: [...input.terminalLedgerIds],
    reconcileJobId: input.reconcileJobId,
  });
}

function canonicalSlotId(
  releaseBindingSha256: string,
  slot: ReleaseFullMaintenancePrivateValidationBudgetSlotName,
): string {
  return sha256Text(
    `fanjin-release-full-maintenance-private-validation-budget-slot/v1\0${releaseBindingSha256}\0${slot}`,
  );
}

function slotState(value: unknown): ReleaseFullMaintenancePrivateValidationBudgetSlotState {
  const normalized = String(value || "") as ReleaseFullMaintenancePrivateValidationBudgetSlotState;
  if (![
    "empty",
    "claimed",
    "gu_reserved",
    "dispatch_started",
    "settled",
    "released_prebilling",
    "released_predispatch",
    "pending_reconcile",
    "terminal_no_charge",
  ].includes(normalized)) {
    budgetError("private_validation_budget_invalid", "预算槽状态无效", 500);
  }
  return normalized;
}

function budgetStatus(value: unknown): ReleaseFullMaintenancePrivateValidationBudgetStatus {
  const normalized = String(value || "") as ReleaseFullMaintenancePrivateValidationBudgetStatus;
  if (!["open", "pending_reconcile", "settled", "failed"].includes(normalized)) {
    budgetError("private_validation_budget_invalid", "预算状态无效", 500);
  }
  return normalized;
}

function parseSlotCheckpoint(
  value: unknown,
  expectedSlot: ReleaseFullMaintenancePrivateValidationBudgetSlotName,
  releaseBindingSha256: string,
): ReleaseFullMaintenancePrivateValidationBudgetSlotCheckpoint {
  const candidate = record(value, `${expectedSlot} slot`);
  exactKeys(candidate, [
    "slot",
    "slotId",
    "actorUserId",
    "claimKeySha256",
    "claimRequestSha256",
    "state",
    "requestId",
    "provider",
    "channelId",
    "model",
    "pricingEvidenceSha256",
    "taskId",
    "reservationId",
    "usageRecordId",
    "providerTaskIdSha256",
    "reservedGuMicros",
    "actualGuMicros",
    "dispatchStartedAt",
    "terminalAt",
    "evidenceSha256",
  ], `${expectedSlot} slot`);
  if (candidate.slot !== expectedSlot) {
    budgetError("private_validation_budget_invalid", `${expectedSlot} slot 名称不匹配`, 500);
  }
  const parsed: ReleaseFullMaintenancePrivateValidationBudgetSlotCheckpoint = {
    slot: expectedSlot,
    slotId: sha256(candidate.slotId, `${expectedSlot}.slotId`),
    actorUserId: positiveSafeInteger(candidate.actorUserId, `${expectedSlot}.actorUserId`),
    claimKeySha256: nullableSha256(candidate.claimKeySha256, `${expectedSlot}.claimKeySha256`),
    claimRequestSha256: nullableSha256(candidate.claimRequestSha256, `${expectedSlot}.claimRequestSha256`),
    state: slotState(candidate.state),
    requestId: nullableBoundedText(candidate.requestId, `${expectedSlot}.requestId`),
    provider: nullableBoundedText(candidate.provider, `${expectedSlot}.provider`, 100),
    channelId: nullableBoundedText(candidate.channelId, `${expectedSlot}.channelId`, 200),
    model: nullableBoundedText(candidate.model, `${expectedSlot}.model`, 200),
    pricingEvidenceSha256: nullableSha256(candidate.pricingEvidenceSha256, `${expectedSlot}.pricingEvidenceSha256`),
    taskId: nullableBoundedText(candidate.taskId, `${expectedSlot}.taskId`, 200),
    reservationId: nullableBoundedText(candidate.reservationId, `${expectedSlot}.reservationId`, 200),
    usageRecordId: nullableBoundedText(candidate.usageRecordId, `${expectedSlot}.usageRecordId`, 200),
    providerTaskIdSha256: nullableSha256(candidate.providerTaskIdSha256, `${expectedSlot}.providerTaskIdSha256`),
    reservedGuMicros: nonNegativeSafeInteger(candidate.reservedGuMicros, `${expectedSlot}.reservedGuMicros`),
    actualGuMicros: nullableNonNegativeSafeInteger(candidate.actualGuMicros, `${expectedSlot}.actualGuMicros`),
    dispatchStartedAt: nullablePositiveSafeInteger(candidate.dispatchStartedAt, `${expectedSlot}.dispatchStartedAt`),
    terminalAt: nullablePositiveSafeInteger(candidate.terminalAt, `${expectedSlot}.terminalAt`),
    evidenceSha256: nullableSha256(candidate.evidenceSha256, `${expectedSlot}.evidenceSha256`),
  };
  if (parsed.slotId !== canonicalSlotId(releaseBindingSha256, expectedSlot)) {
    budgetError("private_validation_budget_invalid", `${expectedSlot} slotId 不匹配`, 500);
  }
  const isEmpty = parsed.state === "empty";
  if (
    (isEmpty && (
      parsed.claimKeySha256 !== null
      || parsed.claimRequestSha256 !== null
      || parsed.requestId !== null
      || parsed.provider !== null
      || parsed.channelId !== null
      || parsed.model !== null
      || parsed.pricingEvidenceSha256 !== null
      || parsed.taskId !== null
      || parsed.reservationId !== null
      || parsed.usageRecordId !== null
      || parsed.providerTaskIdSha256 !== null
      || parsed.reservedGuMicros !== 0
      || parsed.actualGuMicros !== null
      || parsed.dispatchStartedAt !== null
      || parsed.terminalAt !== null
      || parsed.evidenceSha256 !== null
    ))
    || (!isEmpty && (!parsed.claimKeySha256 || !parsed.claimRequestSha256))
    || (parsed.state === "claimed" && (
      parsed.requestId !== null
      || parsed.provider !== null
      || parsed.channelId !== null
      || parsed.model !== null
      || parsed.pricingEvidenceSha256 !== null
      || parsed.taskId !== null
      || parsed.reservationId !== null
      || parsed.usageRecordId !== null
      || parsed.providerTaskIdSha256 !== null
      || parsed.reservedGuMicros !== 0
      || parsed.actualGuMicros !== null
      || parsed.dispatchStartedAt !== null
      || parsed.terminalAt !== null
      || parsed.evidenceSha256 !== null
    ))
    || (["gu_reserved", "dispatch_started", "settled", "released_prebilling", "released_predispatch", "pending_reconcile", "terminal_no_charge"]
      .includes(parsed.state) && (
        !parsed.requestId
        || !parsed.provider
        || !parsed.channelId
        || !parsed.model
        || !parsed.pricingEvidenceSha256
        || parsed.reservedGuMicros <= 0
      ))
    || (parsed.state === "gu_reserved" && (
      parsed.taskId !== null
      || parsed.reservationId !== null
      || parsed.usageRecordId !== null
      || parsed.providerTaskIdSha256 !== null
      || parsed.actualGuMicros !== null
      || parsed.dispatchStartedAt !== null
      || parsed.terminalAt !== null
      || parsed.evidenceSha256 !== null
    ))
    || (["dispatch_started", "settled", "pending_reconcile", "terminal_no_charge"]
      .includes(parsed.state) && (
        !parsed.taskId
        || !parsed.reservationId
        || !parsed.usageRecordId
        || !parsed.dispatchStartedAt
      ))
    || (parsed.state === "released_prebilling" && (
      !parsed.taskId
      || parsed.reservationId !== null
      || parsed.usageRecordId !== null
      || parsed.providerTaskIdSha256 !== null
      || parsed.dispatchStartedAt !== null
    ))
    || (parsed.state === "dispatch_started" && (
      parsed.providerTaskIdSha256 !== null
      || parsed.actualGuMicros !== null
      || parsed.terminalAt !== null
      || parsed.evidenceSha256 !== null
    ))
    || (parsed.state === "released_predispatch" && (
      !parsed.taskId
      || !parsed.reservationId
      || !parsed.usageRecordId
      || parsed.providerTaskIdSha256 !== null
      || parsed.dispatchStartedAt !== null
    ))
    || (parsed.state === "settled" && (
      parsed.actualGuMicros === null
      || !parsed.providerTaskIdSha256
      || !parsed.terminalAt
      || !parsed.evidenceSha256
    ))
    || (["released_prebilling", "released_predispatch", "terminal_no_charge"].includes(parsed.state)
      && (parsed.actualGuMicros !== 0 || !parsed.terminalAt || !parsed.evidenceSha256))
    || (parsed.state === "pending_reconcile" && (
      parsed.actualGuMicros === null
      || !parsed.terminalAt
      || !parsed.evidenceSha256
    ))
    || (parsed.actualGuMicros !== null && parsed.actualGuMicros > parsed.reservedGuMicros)
  ) {
    budgetError("private_validation_budget_invalid", `${expectedSlot} slot 状态字段组合无效`, 500);
  }
  return parsed;
}

const CHECKPOINT_KEYS = [
  "format",
  "deploymentId",
  "contractSha256",
  "releaseBindingSha256",
  "validationPlanIntentSha256",
  "validationPlanSha256",
  "workspaceId",
  "projectId",
  "ownerAdminUserId",
  "currency",
  "maximumProviderTasks",
  "maximumGuMicros",
  "authorizedExpiresAt",
  "authoritySha256",
  "revision",
  "status",
  "slots",
  "checkpointSha256",
] as const;

function checkpointPayload(
  checkpoint: Omit<ReleaseFullMaintenancePrivateValidationBudgetCheckpoint, "checkpointSha256">,
): Omit<ReleaseFullMaintenancePrivateValidationBudgetCheckpoint, "checkpointSha256"> {
  return checkpoint;
}

function sealCheckpoint(
  checkpoint: Omit<ReleaseFullMaintenancePrivateValidationBudgetCheckpoint, "checkpointSha256">,
): ReleaseFullMaintenancePrivateValidationBudgetCheckpoint {
  return {
    ...checkpoint,
    checkpointSha256: releaseFullMaintenancePrivateValidationBudgetSha256(checkpointPayload(checkpoint)),
  };
}

export function assertReleaseFullMaintenancePrivateValidationBudgetCheckpoint(
  value: unknown,
): ReleaseFullMaintenancePrivateValidationBudgetCheckpoint {
  const candidate = record(value, "private validation budget checkpoint");
  exactKeys(candidate, CHECKPOINT_KEYS, "private validation budget checkpoint");
  if (candidate.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_FORMAT) {
    budgetError("private_validation_budget_invalid", "预算 checkpoint format 无效", 500);
  }
  const releaseBindingSha256 = sha256(candidate.releaseBindingSha256, "releaseBindingSha256");
  const rawSlots = record(candidate.slots, "budget slots");
  exactKeys(rawSlots, releaseFullMaintenancePrivateValidationBudgetSlots, "budget slots");
  const parsedWithoutHash: Omit<ReleaseFullMaintenancePrivateValidationBudgetCheckpoint, "checkpointSha256"> = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_FORMAT,
    deploymentId: boundedText(candidate.deploymentId, "deploymentId", 200),
    contractSha256: sha256(candidate.contractSha256, "contractSha256"),
    releaseBindingSha256,
    validationPlanIntentSha256: sha256(candidate.validationPlanIntentSha256, "validationPlanIntentSha256"),
    validationPlanSha256: sha256(candidate.validationPlanSha256, "validationPlanSha256"),
    workspaceId: boundedText(candidate.workspaceId, "workspaceId", 200),
    projectId: positiveSafeInteger(candidate.projectId, "projectId"),
    ownerAdminUserId: positiveSafeInteger(candidate.ownerAdminUserId, "ownerAdminUserId"),
    currency: candidate.currency === "GU" ? "GU" : budgetError("private_validation_budget_invalid", "预算币种必须为 GU", 500),
    maximumProviderTasks: candidate.maximumProviderTasks === 2 ? 2 : budgetError("private_validation_budget_invalid", "预算任务数必须精确为 2", 500),
    maximumGuMicros: positiveSafeInteger(candidate.maximumGuMicros, "maximumGuMicros"),
    authorizedExpiresAt: positiveSafeInteger(candidate.authorizedExpiresAt, "authorizedExpiresAt"),
    authoritySha256: sha256(candidate.authoritySha256, "authoritySha256"),
    revision: nonNegativeSafeInteger(candidate.revision, "revision"),
    status: budgetStatus(candidate.status),
    slots: {
      seedance: parseSlotCheckpoint(rawSlots.seedance, "seedance", releaseBindingSha256),
      portrait: parseSlotCheckpoint(rawSlots.portrait, "portrait", releaseBindingSha256),
    },
  };
  const expectedHash = releaseFullMaintenancePrivateValidationBudgetSha256(parsedWithoutHash);
  if (sha256(candidate.checkpointSha256, "checkpointSha256") !== expectedHash) {
    budgetError("private_validation_budget_tampered", "预算 checkpoint 摘要不匹配", 500);
  }
  const derivedStatus = deriveBudgetStatus(parsedWithoutHash.slots);
  if (parsedWithoutHash.status !== derivedStatus) {
    budgetError("private_validation_budget_invalid", "预算顶层状态与槽状态不一致", 500);
  }
  const totalReserved = Object.values(parsedWithoutHash.slots)
    .reduce((sum, slot) => sum + slot.reservedGuMicros, 0);
  if (!Number.isSafeInteger(totalReserved) || totalReserved > parsedWithoutHash.maximumGuMicros) {
    budgetError("private_validation_budget_exceeded", "预算 checkpoint 已超过 GU 上限", 500);
  }
  return { ...parsedWithoutHash, checkpointSha256: expectedHash };
}

function deriveBudgetStatus(
  slots: Readonly<Record<
    ReleaseFullMaintenancePrivateValidationBudgetSlotName,
    ReleaseFullMaintenancePrivateValidationBudgetSlotCheckpoint
  >>,
): ReleaseFullMaintenancePrivateValidationBudgetStatus {
  const states = Object.values(slots).map((slot) => slot.state);
  if (states.includes("pending_reconcile")) return "pending_reconcile";
  if (
    states.includes("released_prebilling")
    || states.includes("released_predispatch")
    || states.includes("terminal_no_charge")
  ) return "failed";
  if (states.every((state) => state === "settled")) return "settled";
  return "open";
}

function initialSlot(
  releaseBindingSha256: string,
  slot: ReleaseFullMaintenancePrivateValidationBudgetSlotName,
  actorUserId: number,
): ReleaseFullMaintenancePrivateValidationBudgetSlotCheckpoint {
  return {
    slot,
    slotId: canonicalSlotId(releaseBindingSha256, slot),
    actorUserId,
    claimKeySha256: null,
    claimRequestSha256: null,
    state: "empty",
    requestId: null,
    provider: null,
    channelId: null,
    model: null,
    pricingEvidenceSha256: null,
    taskId: null,
    reservationId: null,
    usageRecordId: null,
    providerTaskIdSha256: null,
    reservedGuMicros: 0,
    actualGuMicros: null,
    dispatchStartedAt: null,
    terminalAt: null,
    evidenceSha256: null,
  };
}

function normalizeAuthority(
  input: ReleaseFullMaintenancePrivateValidationBudgetAuthority,
): ReleaseFullMaintenancePrivateValidationBudgetAuthority {
  const slots = record(input.slotActors, "slotActors");
  exactKeys(slots, releaseFullMaintenancePrivateValidationBudgetSlots, "slotActors");
  if (input.currency !== "GU" || input.maximumProviderTasks !== 2) {
    budgetError("private_validation_budget_invalid", "预算必须绑定 GU 和精确两个供应商任务", 400);
  }
  return {
    deploymentId: boundedText(input.deploymentId, "deploymentId", 200),
    contractSha256: sha256(input.contractSha256, "contractSha256"),
    releaseBindingSha256: sha256(input.releaseBindingSha256, "releaseBindingSha256"),
    validationPlanIntentSha256: sha256(input.validationPlanIntentSha256, "validationPlanIntentSha256"),
    validationPlanSha256: sha256(input.validationPlanSha256, "validationPlanSha256"),
    workspaceId: boundedText(input.workspaceId, "workspaceId", 200),
    projectId: positiveSafeInteger(input.projectId, "projectId"),
    ownerAdminUserId: positiveSafeInteger(input.ownerAdminUserId, "ownerAdminUserId"),
    slotActors: {
      seedance: positiveSafeInteger(slots.seedance, "slotActors.seedance"),
      portrait: positiveSafeInteger(slots.portrait, "slotActors.portrait"),
    },
    currency: "GU",
    maximumProviderTasks: 2,
    maximumGuMicros: positiveSafeInteger(input.maximumGuMicros, "maximumGuMicros"),
    authorizedExpiresAt: positiveSafeInteger(input.authorizedExpiresAt, "authorizedExpiresAt"),
  };
}

function authorityRequest(authority: ReleaseFullMaintenancePrivateValidationBudgetAuthority) {
  return {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_AUTHORITY_FORMAT,
    ...authority,
  } as const;
}

function handlePayload(
  input: Omit<ReleaseFullMaintenancePrivateValidationBudgetHandle, "handleSha256">,
) {
  return input;
}

function createHandle(input: {
  budgetId: string;
  checkpoint: ReleaseFullMaintenancePrivateValidationBudgetCheckpoint;
  requestHash: string;
}): ReleaseFullMaintenancePrivateValidationBudgetHandle {
  const payload: Omit<ReleaseFullMaintenancePrivateValidationBudgetHandle, "handleSha256"> = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_HANDLE_FORMAT,
    budgetId: input.budgetId,
    deploymentId: input.checkpoint.deploymentId,
    releaseBindingSha256: input.checkpoint.releaseBindingSha256,
    workspaceId: input.checkpoint.workspaceId,
    projectId: input.checkpoint.projectId,
    ownerAdminUserId: input.checkpoint.ownerAdminUserId,
    scopeKey: `${RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SCOPE}:${input.checkpoint.workspaceId}:${input.checkpoint.ownerAdminUserId}`,
    idempotencyKey: input.checkpoint.releaseBindingSha256,
    requestHash: input.requestHash,
    authoritySha256: input.checkpoint.authoritySha256,
  };
  return {
    ...payload,
    handleSha256: releaseFullMaintenancePrivateValidationBudgetSha256(handlePayload(payload)),
  };
}

export function assertReleaseFullMaintenancePrivateValidationBudgetHandle(
  value: unknown,
): ReleaseFullMaintenancePrivateValidationBudgetHandle {
  const candidate = record(value, "budget handle");
  exactKeys(candidate, [
    "format",
    "budgetId",
    "deploymentId",
    "releaseBindingSha256",
    "workspaceId",
    "projectId",
    "ownerAdminUserId",
    "scopeKey",
    "idempotencyKey",
    "requestHash",
    "authoritySha256",
    "handleSha256",
  ], "budget handle");
  if (candidate.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_HANDLE_FORMAT) {
    budgetError("private_validation_budget_handle_invalid", "预算 handle format 无效", 500);
  }
  const payload: Omit<ReleaseFullMaintenancePrivateValidationBudgetHandle, "handleSha256"> = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_HANDLE_FORMAT,
    budgetId: boundedText(candidate.budgetId, "budgetId", 200),
    deploymentId: boundedText(candidate.deploymentId, "deploymentId", 200),
    releaseBindingSha256: sha256(candidate.releaseBindingSha256, "releaseBindingSha256"),
    workspaceId: boundedText(candidate.workspaceId, "workspaceId", 200),
    projectId: positiveSafeInteger(candidate.projectId, "projectId"),
    ownerAdminUserId: positiveSafeInteger(candidate.ownerAdminUserId, "ownerAdminUserId"),
    scopeKey: boundedText(candidate.scopeKey, "scopeKey", 512),
    idempotencyKey: boundedText(candidate.idempotencyKey, "idempotencyKey", 200),
    requestHash: sha256(candidate.requestHash, "requestHash"),
    authoritySha256: sha256(candidate.authoritySha256, "authoritySha256"),
  };
  if (
    payload.scopeKey !== `${RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SCOPE}:${payload.workspaceId}:${payload.ownerAdminUserId}`
    || payload.idempotencyKey !== payload.releaseBindingSha256
  ) {
    budgetError("private_validation_budget_handle_invalid", "预算 handle authority 不匹配", 500);
  }
  const expected = releaseFullMaintenancePrivateValidationBudgetSha256(payload);
  if (sha256(candidate.handleSha256, "handleSha256") !== expected) {
    budgetError("private_validation_budget_handle_invalid", "预算 handle 摘要不匹配", 500);
  }
  return { ...payload, handleSha256: expected };
}

function bindingPayload(
  input: Omit<ReleaseFullMaintenancePrivateValidationBudgetSlotBinding, "bindingSha256">,
) {
  return input;
}

function bindingFrom(
  handle: ReleaseFullMaintenancePrivateValidationBudgetHandle,
  slot: ReleaseFullMaintenancePrivateValidationBudgetSlotCheckpoint,
): ReleaseFullMaintenancePrivateValidationBudgetSlotBinding {
  if (!slot.claimKeySha256 || !slot.claimRequestSha256) {
    budgetError("private_validation_budget_slot_unclaimed", "预算槽尚未认领", 409);
  }
  const payload: Omit<ReleaseFullMaintenancePrivateValidationBudgetSlotBinding, "bindingSha256"> = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SLOT_BINDING_FORMAT,
    budgetId: handle.budgetId,
    deploymentId: handle.deploymentId,
    releaseBindingSha256: handle.releaseBindingSha256,
    workspaceId: handle.workspaceId,
    projectId: handle.projectId,
    ownerAdminUserId: handle.ownerAdminUserId,
    scopeKey: handle.scopeKey,
    idempotencyKey: handle.idempotencyKey,
    requestHash: handle.requestHash,
    authoritySha256: handle.authoritySha256,
    slot: slot.slot,
    slotId: slot.slotId,
    actorUserId: slot.actorUserId,
    claimKeySha256: slot.claimKeySha256,
    claimRequestSha256: slot.claimRequestSha256,
  };
  return {
    ...payload,
    bindingSha256: releaseFullMaintenancePrivateValidationBudgetSha256(bindingPayload(payload)),
  };
}

export function assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(
  value: unknown,
): ReleaseFullMaintenancePrivateValidationBudgetSlotBinding {
  const candidate = record(value, "budget slot binding");
  exactKeys(candidate, [
    "format",
    "budgetId",
    "deploymentId",
    "releaseBindingSha256",
    "workspaceId",
    "projectId",
    "ownerAdminUserId",
    "scopeKey",
    "idempotencyKey",
    "requestHash",
    "authoritySha256",
    "slot",
    "slotId",
    "actorUserId",
    "claimKeySha256",
    "claimRequestSha256",
    "bindingSha256",
  ], "budget slot binding");
  if (candidate.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SLOT_BINDING_FORMAT) {
    budgetError("private_validation_budget_binding_invalid", "预算槽 binding format 无效", 500);
  }
  const slot = String(candidate.slot || "") as ReleaseFullMaintenancePrivateValidationBudgetSlotName;
  if (!releaseFullMaintenancePrivateValidationBudgetSlots.includes(slot)) {
    budgetError("private_validation_budget_binding_invalid", "预算槽 binding 名称无效", 500);
  }
  const payload: Omit<ReleaseFullMaintenancePrivateValidationBudgetSlotBinding, "bindingSha256"> = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SLOT_BINDING_FORMAT,
    budgetId: boundedText(candidate.budgetId, "budgetId", 200),
    deploymentId: boundedText(candidate.deploymentId, "deploymentId", 200),
    releaseBindingSha256: sha256(candidate.releaseBindingSha256, "releaseBindingSha256"),
    workspaceId: boundedText(candidate.workspaceId, "workspaceId", 200),
    projectId: positiveSafeInteger(candidate.projectId, "projectId"),
    ownerAdminUserId: positiveSafeInteger(candidate.ownerAdminUserId, "ownerAdminUserId"),
    scopeKey: boundedText(candidate.scopeKey, "scopeKey", 512),
    idempotencyKey: boundedText(candidate.idempotencyKey, "idempotencyKey", 200),
    requestHash: sha256(candidate.requestHash, "requestHash"),
    authoritySha256: sha256(candidate.authoritySha256, "authoritySha256"),
    slot,
    slotId: sha256(candidate.slotId, "slotId"),
    actorUserId: positiveSafeInteger(candidate.actorUserId, "actorUserId"),
    claimKeySha256: sha256(candidate.claimKeySha256, "claimKeySha256"),
    claimRequestSha256: sha256(candidate.claimRequestSha256, "claimRequestSha256"),
  };
  if (
    payload.scopeKey !== `${RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SCOPE}:${payload.workspaceId}:${payload.ownerAdminUserId}`
    || payload.idempotencyKey !== payload.releaseBindingSha256
    || payload.slotId !== canonicalSlotId(payload.releaseBindingSha256, payload.slot)
  ) {
    budgetError("private_validation_budget_binding_invalid", "预算槽 binding authority 不匹配", 500);
  }
  const expected = releaseFullMaintenancePrivateValidationBudgetSha256(payload);
  if (sha256(candidate.bindingSha256, "bindingSha256") !== expected) {
    budgetError("private_validation_budget_binding_invalid", "预算槽 binding 摘要不匹配", 500);
  }
  return { ...payload, bindingSha256: expected };
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string" || !value.trim()) {
    budgetError("private_validation_budget_invalid", `${label} 缺失`, 500);
  }
  try {
    return JSON.parse(value);
  } catch {
    budgetError("private_validation_budget_invalid", `${label} JSON 无效`, 500);
  }
}

function isTransaction(database: BudgetDatabase): database is Knex.Transaction {
  return Boolean((database as Knex.Transaction).isTransaction);
}

async function inTransaction<T>(
  database: BudgetDatabase,
  callback: (transaction: Knex.Transaction) => Promise<T>,
): Promise<T> {
  if (isTransaction(database)) return await callback(database);
  return await database.transaction(callback);
}

type BudgetRow = Record<string, unknown>;

async function lockedBudgetRow(
  transaction: Knex.Transaction,
  handleValue: ReleaseFullMaintenancePrivateValidationBudgetHandle,
): Promise<{ handle: ReleaseFullMaintenancePrivateValidationBudgetHandle; row: BudgetRow; checkpoint: ReleaseFullMaintenancePrivateValidationBudgetCheckpoint }> {
  const handle = assertReleaseFullMaintenancePrivateValidationBudgetHandle(handleValue);
  const row = await transaction("o_agent_idempotency")
    .where({
      id: handle.budgetId,
      workspaceId: handle.workspaceId,
      actorUserId: handle.ownerAdminUserId,
      scopeKey: handle.scopeKey,
      idempotencyKey: handle.idempotencyKey,
      requestHash: handle.requestHash,
      resourceType: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_RESOURCE_TYPE,
      resourceId: handle.deploymentId,
      status: "checkpointed",
    })
    .forUpdate()
    .first() as BudgetRow | undefined;
  if (!row) budgetError("private_validation_budget_not_found", "预算 checkpoint 不存在或 authority 已变化", 409);
  if (row.responseStatus !== null && row.responseStatus !== undefined) {
    budgetError("private_validation_budget_invalid", "预算 checkpoint 出现终态响应", 500);
  }
  const checkpoint = assertReleaseFullMaintenancePrivateValidationBudgetCheckpoint(
    parseJson(row.responseBody, "budget responseBody"),
  );
  if (
    checkpoint.deploymentId !== handle.deploymentId
    || checkpoint.releaseBindingSha256 !== handle.releaseBindingSha256
    || checkpoint.workspaceId !== handle.workspaceId
    || checkpoint.projectId !== handle.projectId
    || checkpoint.ownerAdminUserId !== handle.ownerAdminUserId
    || checkpoint.authoritySha256 !== handle.authoritySha256
  ) {
    budgetError("private_validation_budget_authority_changed", "预算 checkpoint 与 handle authority 不匹配", 409);
  }
  return { handle, row, checkpoint };
}

async function persistCheckpoint(
  transaction: Knex.Transaction,
  row: BudgetRow,
  previous: ReleaseFullMaintenancePrivateValidationBudgetCheckpoint,
  next: ReleaseFullMaintenancePrivateValidationBudgetCheckpoint,
): Promise<void> {
  if (next.checkpointSha256 === previous.checkpointSha256) return;
  const updatedAt = Math.max(Date.now(), Number(row.updatedAt || 0) + 1);
  const affected = await transaction("o_agent_idempotency")
    .where({
      id: row.id,
      status: "checkpointed",
      requestHash: row.requestHash,
      updatedAt: row.updatedAt,
    })
    .update({
      responseStatus: null,
      responseBody: JSON.stringify(next),
      updatedAt,
    });
  if (Number(affected || 0) !== 1) {
    budgetError("private_validation_budget_concurrent_change", "预算 checkpoint 并发状态已变化", 409);
  }
}

function replaceSlot(
  checkpoint: ReleaseFullMaintenancePrivateValidationBudgetCheckpoint,
  slotName: ReleaseFullMaintenancePrivateValidationBudgetSlotName,
  slot: ReleaseFullMaintenancePrivateValidationBudgetSlotCheckpoint,
): ReleaseFullMaintenancePrivateValidationBudgetCheckpoint {
  const { checkpointSha256: _previousCheckpointSha256, ...checkpointWithoutHash } = checkpoint;
  const slots = { ...checkpoint.slots, [slotName]: slot };
  return sealCheckpoint({
    ...checkpointWithoutHash,
    slots,
    revision: checkpoint.revision + 1,
    status: deriveBudgetStatus(slots),
  });
}

function ensureOpenAndUnexpired(
  checkpoint: ReleaseFullMaintenancePrivateValidationBudgetCheckpoint,
  now: number,
): void {
  if (checkpoint.status !== "open") {
    budgetError("private_validation_budget_closed", "预算已进入终态或待核账状态", 409);
  }
  if (!Number.isSafeInteger(now) || now < 1 || now >= checkpoint.authorizedExpiresAt) {
    budgetError("private_validation_budget_expired", "预算授权已过期", 409);
  }
}

function handleFromBinding(
  binding: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
): ReleaseFullMaintenancePrivateValidationBudgetHandle {
  return assertReleaseFullMaintenancePrivateValidationBudgetHandle({
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_HANDLE_FORMAT,
    budgetId: binding.budgetId,
    deploymentId: binding.deploymentId,
    releaseBindingSha256: binding.releaseBindingSha256,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    ownerAdminUserId: binding.ownerAdminUserId,
    scopeKey: binding.scopeKey,
    idempotencyKey: binding.idempotencyKey,
    requestHash: binding.requestHash,
    authoritySha256: binding.authoritySha256,
    handleSha256: releaseFullMaintenancePrivateValidationBudgetSha256({
      format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_HANDLE_FORMAT,
      budgetId: binding.budgetId,
      deploymentId: binding.deploymentId,
      releaseBindingSha256: binding.releaseBindingSha256,
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
      ownerAdminUserId: binding.ownerAdminUserId,
      scopeKey: binding.scopeKey,
      idempotencyKey: binding.idempotencyKey,
      requestHash: binding.requestHash,
      authoritySha256: binding.authoritySha256,
    }),
  });
}

function assertBindingMatchesSlot(
  bindingValue: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
  checkpoint: ReleaseFullMaintenancePrivateValidationBudgetCheckpoint,
): { binding: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding; slot: ReleaseFullMaintenancePrivateValidationBudgetSlotCheckpoint } {
  const binding = assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(bindingValue);
  const slot = checkpoint.slots[binding.slot];
  if (
    binding.releaseBindingSha256 !== checkpoint.releaseBindingSha256
    || binding.workspaceId !== checkpoint.workspaceId
    || binding.projectId !== checkpoint.projectId
    || binding.ownerAdminUserId !== checkpoint.ownerAdminUserId
    || binding.authoritySha256 !== checkpoint.authoritySha256
    || binding.slotId !== slot.slotId
    || binding.actorUserId !== slot.actorUserId
    || binding.claimKeySha256 !== slot.claimKeySha256
    || binding.claimRequestSha256 !== slot.claimRequestSha256
  ) {
    budgetError("private_validation_budget_binding_conflict", "预算槽 binding 与 checkpoint 不匹配", 409);
  }
  return { binding, slot };
}

export async function createReleaseFullMaintenancePrivateValidationBudget(
  input: ReleaseFullMaintenancePrivateValidationBudgetAuthority & {
    database?: BudgetDatabase;
    now?: number;
  },
): Promise<ReleaseFullMaintenancePrivateValidationBudgetHandle> {
  const database = input.database ?? db;
  const now = input.now ?? Date.now();
  const authority = normalizeAuthority(input);
  if (!Number.isSafeInteger(now) || now < 1 || now >= authority.authorizedExpiresAt) {
    budgetError("private_validation_budget_expired", "不能创建已过期的验证预算", 409);
  }
  const request = authorityRequest(authority);
  const authoritySha256 = releaseFullMaintenancePrivateValidationBudgetSha256(request);
  const initial = sealCheckpoint({
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_FORMAT,
    deploymentId: authority.deploymentId,
    contractSha256: authority.contractSha256,
    releaseBindingSha256: authority.releaseBindingSha256,
    validationPlanIntentSha256: authority.validationPlanIntentSha256,
    validationPlanSha256: authority.validationPlanSha256,
    workspaceId: authority.workspaceId,
    projectId: authority.projectId,
    ownerAdminUserId: authority.ownerAdminUserId,
    currency: "GU",
    maximumProviderTasks: 2,
    maximumGuMicros: authority.maximumGuMicros,
    authorizedExpiresAt: authority.authorizedExpiresAt,
    authoritySha256,
    revision: 0,
    status: "open",
    slots: {
      seedance: initialSlot(authority.releaseBindingSha256, "seedance", authority.slotActors.seedance),
      portrait: initialSlot(authority.releaseBindingSha256, "portrait", authority.slotActors.portrait),
    },
  });
  let reservation;
  try {
    reservation = await beginDurableCommand<never>({
      database,
      workspaceId: authority.workspaceId,
      actorUserId: authority.ownerAdminUserId,
      scope: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_SCOPE,
      idempotencyKey: authority.releaseBindingSha256,
      request,
      now,
      initialCheckpoint: initial,
      resourceType: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_RESOURCE_TYPE,
      resourceId: authority.deploymentId,
    });
  } catch (error) {
    if (error instanceof DurableCommandIdempotencyError) {
      budgetError(error.code, error.message, error.status);
    }
    throw error;
  }
  if (reservation.kind !== "resume") {
    budgetError("private_validation_budget_invalid", "预算 checkpoint 未能建立可恢复 authority", 500);
  }
  const checkpoint = assertReleaseFullMaintenancePrivateValidationBudgetCheckpoint(reservation.checkpoint);
  if (checkpoint.authoritySha256 !== authoritySha256) {
    budgetError("private_validation_budget_authority_changed", "既有预算 authority 与本次请求不一致", 409);
  }
  return createHandle({
    budgetId: reservation.id,
    checkpoint,
    requestHash: hashIdempotencyRequest(request),
  });
}

export async function claimReleaseFullMaintenancePrivateValidationBudgetSlot(input: {
  handle: ReleaseFullMaintenancePrivateValidationBudgetHandle;
  slot: ReleaseFullMaintenancePrivateValidationBudgetSlotName;
  actorUserId: number;
  claimKey: string;
  claimRequestSha256: string;
  database?: BudgetDatabase;
  now?: number;
}): Promise<ReleaseFullMaintenancePrivateValidationBudgetSlotBinding> {
  const database = input.database ?? db;
  const now = input.now ?? Date.now();
  const claimKeySha256 = sha256Text(boundedText(input.claimKey, "claimKey", 512));
  const claimRequestSha256 = sha256(input.claimRequestSha256, "claimRequestSha256");
  const actorUserId = positiveSafeInteger(input.actorUserId, "actorUserId");
  if (!releaseFullMaintenancePrivateValidationBudgetSlots.includes(input.slot)) {
    budgetError("private_validation_budget_slot_invalid", "预算只允许 seedance/portrait 两个固定槽", 409);
  }
  return await inTransaction(database, async (transaction) => {
    const locked = await lockedBudgetRow(transaction, input.handle);
    const current = locked.checkpoint.slots[input.slot];
    if (current.actorUserId !== actorUserId) {
      budgetError("private_validation_budget_actor_mismatch", "预算槽操作账号不匹配", 403);
    }
    let checkpoint = locked.checkpoint;
    if (current.state === "empty") {
      ensureOpenAndUnexpired(locked.checkpoint, now);
      checkpoint = replaceSlot(locked.checkpoint, input.slot, {
        ...current,
        claimKeySha256,
        claimRequestSha256,
        state: "claimed",
      });
      await persistCheckpoint(transaction, locked.row, locked.checkpoint, checkpoint);
    } else if (
      current.claimKeySha256 !== claimKeySha256
      || current.claimRequestSha256 !== claimRequestSha256
    ) {
      budgetError("private_validation_budget_slot_conflict", "预算槽已被不同请求占用", 409);
    }
    return bindingFrom(locked.handle, checkpoint.slots[input.slot]);
  });
}

export async function reserveReleaseFullMaintenancePrivateValidationBudgetSlotGu(input: {
  binding: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding;
  requestId: string;
  provider: string;
  channelId: string;
  model: string;
  reservationGuMicros: number;
  pricingEvidenceSha256: string;
  database?: BudgetDatabase;
  now?: number;
}): Promise<ReleaseFullMaintenancePrivateValidationBudgetSlotBinding> {
  const binding = assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(input.binding);
  const database = input.database ?? db;
  const now = input.now ?? Date.now();
  const facts = {
    requestId: boundedText(input.requestId, "requestId", 512),
    provider: boundedText(input.provider, "provider", 100),
    channelId: boundedText(input.channelId, "channelId", 200),
    model: boundedText(input.model, "model", 200),
    reservationGuMicros: positiveSafeInteger(input.reservationGuMicros, "reservationGuMicros"),
    pricingEvidenceSha256: sha256(input.pricingEvidenceSha256, "pricingEvidenceSha256"),
  };
  return await inTransaction(database, async (transaction) => {
    const locked = await lockedBudgetRow(transaction, handleFromBinding(binding));
    const matched = assertBindingMatchesSlot(binding, locked.checkpoint);
    const current = matched.slot;
    if (current.state === "claimed") {
      ensureOpenAndUnexpired(locked.checkpoint, now);
      const total = Object.values(locked.checkpoint.slots)
        .reduce((sum, slot) => sum + slot.reservedGuMicros, 0);
      if (
        !Number.isSafeInteger(total + facts.reservationGuMicros)
        || total + facts.reservationGuMicros > locked.checkpoint.maximumGuMicros
      ) {
        budgetError("private_validation_budget_gu_exceeded", "验证任务预估 GU 超过 Root MFA 授权上限", 409);
      }
      const checkpoint = replaceSlot(locked.checkpoint, binding.slot, {
        ...current,
        state: "gu_reserved",
        requestId: facts.requestId,
        provider: facts.provider,
        channelId: facts.channelId,
        model: facts.model,
        pricingEvidenceSha256: facts.pricingEvidenceSha256,
        reservedGuMicros: facts.reservationGuMicros,
      });
      await persistCheckpoint(transaction, locked.row, locked.checkpoint, checkpoint);
      return bindingFrom(locked.handle, checkpoint.slots[binding.slot]);
    }
    if (
      current.requestId !== facts.requestId
      || current.provider !== facts.provider
      || current.channelId !== facts.channelId
      || current.model !== facts.model
      || current.pricingEvidenceSha256 !== facts.pricingEvidenceSha256
      || current.reservedGuMicros !== facts.reservationGuMicros
    ) {
      budgetError("private_validation_budget_gu_conflict", "预算槽 GU 或定价事实已变化", 409);
    }
    if (!["gu_reserved", "dispatch_started", "settled", "pending_reconcile"].includes(current.state)) {
      budgetError("private_validation_budget_slot_closed", "预算槽已关闭，禁止重新预占", 409);
    }
    return bindingFrom(locked.handle, current);
  });
}

function parseStoredBinding(task: Record<string, unknown>): ReleaseFullMaintenancePrivateValidationBudgetSlotBinding {
  const resultPayload = typeof task.resultPayload === "string"
    ? record(parseJson(task.resultPayload, "relay resultPayload"), "relay resultPayload")
    : record(task.resultPayload, "relay resultPayload");
  const internal = record(resultPayload.internal, "relay resultPayload.internal");
  return assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(
    internal[RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_RELAY_EVIDENCE_KEY],
  );
}

function sameBinding(
  left: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
  right: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
): boolean {
  return left.bindingSha256 === right.bindingSha256;
}

export async function markReleaseFullMaintenancePrivateValidationBudgetDispatchInTransaction(
  transaction: Knex.Transaction,
  input: {
    binding: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding;
    taskId: string;
    boundary: ReleaseFullMaintenancePrivateValidationBudgetDispatchBoundary;
    now?: number;
  },
): Promise<void> {
  const binding = assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(input.binding);
  const taskId = boundedText(input.taskId, "taskId", 200);
  const now = input.now ?? Date.now();
  const locked = await lockedBudgetRow(transaction, handleFromBinding(binding));
  ensureOpenAndUnexpired(locked.checkpoint, now);
  const matched = assertBindingMatchesSlot(binding, locked.checkpoint);
  const slot = matched.slot;
  if (slot.state !== "gu_reserved") {
    budgetError("private_validation_budget_dispatch_conflict", "预算槽不是可派发的 GU 预占状态", 409);
  }
  const boundary = input.boundary;
  if (
    boundary.workspaceId !== locked.checkpoint.workspaceId
    || !boundary.requestId
    || boundary.requestId !== slot.requestId
    || boundary.provider !== slot.provider
    || boundary.channelId !== slot.channelId
  ) {
    budgetError("private_validation_budget_dispatch_conflict", "billing dispatch boundary 与预算槽不匹配", 409);
  }
  const [task, freeze, usage, watchdogRows] = await Promise.all([
    transaction("o_relay_task").where({ id: taskId }).first(),
    transaction("o_billing_ledger").where({
      id: boundary.reservationId,
      workspaceId: boundary.workspaceId,
      type: "freeze",
    }).first(),
    transaction("o_usage_record").where({
      id: boundary.usageRecordId,
      workspaceId: boundary.workspaceId,
      taskId,
      endpointType: "video_generation",
    }).first(),
    transaction("o_billing_reconcile_job").where({
      workspaceId: boundary.workspaceId,
      reservationId: boundary.reservationId,
    }),
  ]);
  const watchdog = watchdogRows.length === 1
    ? watchdogRows[0] as Record<string, unknown>
    : null;
  if (!task || !freeze || !usage || !watchdog) {
    budgetError("private_validation_budget_dispatch_evidence_missing", "派发前 task/freeze/usage/watchdog 证据不完整", 409);
  }
  const storedBinding = parseStoredBinding(task as Record<string, unknown>);
  if (
    !sameBinding(storedBinding, binding)
    || String(task.workspaceId || "") !== binding.workspaceId
    || Number(task.projectId) !== binding.projectId
    || String(task.requestId || "") !== slot.requestId
    || String(task.endpointType || "") !== "video_generation"
    || String(task.provider || "") !== slot.provider
    || String(task.channelId || "") !== slot.channelId
    || String(task.model || "") !== slot.model
    || String(freeze.relatedTaskId || freeze.taskId || "") !== taskId
    || String(freeze.relatedUsageId || "") !== boundary.usageRecordId
    || String(freeze.requestId || "") !== slot.requestId
    || String(freeze.currency || "") !== "GU"
    || Number(freeze.amountMicros) !== slot.reservedGuMicros
    || Number(freeze.remainingMicros) !== slot.reservedGuMicros
    || String(usage.status || "") !== "reserved"
    || String(usage.currency || "") !== "GU"
    || Number(usage.costMicros) !== slot.reservedGuMicros
    || String(usage.provider || "") !== slot.provider
    || String(usage.channelId || "") !== slot.channelId
    || String(watchdog.id || "") !== boundary.reconcileJobId
    || String(watchdog.dedupeKey || "") !== `reservation:${boundary.reservationId}`
    || String(watchdog.usageRecordId || "") !== boundary.usageRecordId
    || String(watchdog.requestId || "") !== slot.requestId
    || String(watchdog.endpointType || "") !== "video_generation"
    || String(watchdog.provider || "") !== slot.provider
    || String(watchdog.channelId || "") !== slot.channelId
    || String(watchdog.status || "") !== "pending"
    || String(watchdog.reason || "") !== "dispatch_watchdog"
  ) {
    budgetError("private_validation_budget_dispatch_evidence_mismatch", "派发前 task/freeze/usage 事实与预算槽不一致", 409);
  }
  const providerBoundCount = Object.values(locked.checkpoint.slots)
    .filter((candidate) => ["dispatch_started", "settled", "pending_reconcile", "terminal_no_charge"].includes(candidate.state))
    .length;
  if (providerBoundCount + 1 > locked.checkpoint.maximumProviderTasks) {
    budgetError("private_validation_budget_task_exceeded", "供应商任务数量超过预算上限", 409);
  }
  const checkpoint = replaceSlot(locked.checkpoint, binding.slot, {
    ...slot,
    state: "dispatch_started",
    taskId,
    reservationId: boundary.reservationId,
    usageRecordId: boundary.usageRecordId,
    dispatchStartedAt: positiveSafeInteger(boundary.dispatchStartedAt, "dispatchStartedAt"),
  });
  await persistCheckpoint(transaction, locked.row, locked.checkpoint, checkpoint);
}

export async function settleReleaseFullMaintenancePrivateValidationBudgetSlotInTransaction(
  transaction: Knex.Transaction,
  input: {
    binding: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding;
    taskId: string;
    settlement: ReleaseFullMaintenancePrivateValidationBudgetSettlement;
    now?: number;
  },
): Promise<void> {
  const binding = assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(input.binding);
  const taskId = boundedText(input.taskId, "taskId", 200);
  const locked = await lockedBudgetRow(transaction, handleFromBinding(binding));
  const matched = assertBindingMatchesSlot(binding, locked.checkpoint);
  const slot = matched.slot;
  const settlement = input.settlement;
  if (settlement.overageLedger) {
    budgetError("private_validation_budget_overage_forbidden", "私有验证预算禁止超预扣结算", 409);
  }
  if (
    settlement.reservation.id !== slot.reservationId
    || settlement.reservation.workspaceId !== binding.workspaceId
    || settlement.reservation.type !== "freeze"
    || settlement.reservation.taskId !== taskId
    || settlement.reservation.usageRecordId !== slot.usageRecordId
    || settlement.reservation.requestId !== slot.requestId
    || settlement.reservation.amountMicros !== slot.reservedGuMicros
    || settlement.reservation.remainingMicros !== 0
    || settlement.usage.id !== slot.usageRecordId
    || settlement.usage.taskId !== taskId
    || settlement.usage.workspaceId !== binding.workspaceId
    || settlement.usage.endpointType !== "video_generation"
    || settlement.usage.currency !== "GU"
    || !["charged", "free"].includes(settlement.usage.status)
    || settlement.usage.provider !== slot.provider
    || settlement.usage.channelId !== slot.channelId
    || !Number.isSafeInteger(settlement.usage.costMicros)
    || settlement.usage.costMicros < 0
    || settlement.usage.costMicros > slot.reservedGuMicros
  ) {
    budgetError("private_validation_budget_settlement_mismatch", "计费结算与预算槽不一致", 409);
  }
  const [task, watchdogRows, terminalRows] = await Promise.all([
    transaction("o_relay_task").where({ id: taskId }).first(),
    transaction("o_billing_reconcile_job").where({
      workspaceId: binding.workspaceId,
      reservationId: slot.reservationId,
    }),
    transaction("o_billing_ledger")
      .where({ workspaceId: binding.workspaceId, relatedLedgerId: slot.reservationId })
      .whereIn("type", ["deduct", "release"])
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc"),
  ]);
  const watchdog = watchdogRows.length === 1
    ? watchdogRows[0] as Record<string, unknown>
    : null;
  const providerTaskId = String(task?.providerTaskId || "").trim();
  if (!task || !watchdog || !providerTaskId || terminalRows.length < 1) {
    budgetError("private_validation_budget_settlement_evidence_missing", "结算缺少 provider/watchdog/terminal ledger 证据", 409);
  }
  const storedBinding = parseStoredBinding(task as Record<string, unknown>);
  const actualGuMicros = settlement.usage.costMicros;
  const releasedGuMicros = slot.reservedGuMicros - actualGuMicros;
  const captureRows = terminalRows.filter((row: Record<string, unknown>) => row.type === "deduct");
  const releaseRows = terminalRows.filter((row: Record<string, unknown>) => row.type === "release");
  const captureLedgerMatches = actualGuMicros === 0
    ? settlement.captureLedger === null && captureRows.length === 0
    : settlement.captureLedger !== null
      && settlement.captureLedger.amountMicros === actualGuMicros
      && captureRows.length === 1
      && String(captureRows[0].id || "") === settlement.captureLedger.id
      && Number(captureRows[0].amountMicros) === actualGuMicros;
  const releaseLedgerMatches = releasedGuMicros === 0
    ? settlement.releaseLedger === null && releaseRows.length === 0
    : settlement.releaseLedger !== null
      && settlement.releaseLedger.amountMicros === releasedGuMicros
      && releaseRows.length === 1
      && String(releaseRows[0].id || "") === settlement.releaseLedger.id
      && Number(releaseRows[0].amountMicros) === releasedGuMicros;
  const terminalRowsMatch = terminalRows.every((row: Record<string, unknown>) => (
    String(row.relatedTaskId || "") === taskId
    && String(row.relatedUsageId || "") === slot.usageRecordId
    && String(row.requestId || "") === slot.requestId
    && String(row.currency || "") === "GU"
    && String(row.status || "") === "succeeded"
    && Number(row.remainingMicros || 0) === 0
  ));
  if (
    !sameBinding(storedBinding, binding)
    || String(task.workspaceId || "") !== binding.workspaceId
    || Number(task.projectId) !== binding.projectId
    || String(task.requestId || "") !== slot.requestId
    || String(task.endpointType || "") !== "video_generation"
    || String(task.provider || "") !== slot.provider
    || String(task.channelId || "") !== slot.channelId
    || String(task.model || "") !== slot.model
    || String(watchdog.dedupeKey || "") !== `reservation:${slot.reservationId}`
    || String(watchdog.usageRecordId || "") !== slot.usageRecordId
    || String(watchdog.requestId || "") !== slot.requestId
    || String(watchdog.endpointType || "") !== "video_generation"
    || String(watchdog.provider || "") !== slot.provider
    || String(watchdog.channelId || "") !== slot.channelId
    || String(watchdog.status || "") !== "resolved"
    || String(watchdog.reason || "") !== "dispatch_watchdog"
    || String(watchdog.decision || "") !== "reservation_settled"
    || watchdog.leaseOwner != null
    || watchdog.leaseExpiresAt != null
    || watchdog.lastError != null
    || !Number.isSafeInteger(Number(watchdog.resolvedAt))
    || !captureLedgerMatches
    || !releaseLedgerMatches
    || !terminalRowsMatch
    || terminalRows.length !== (actualGuMicros > 0 ? 1 : 0) + (releasedGuMicros > 0 ? 1 : 0)
  ) {
    budgetError("private_validation_budget_settlement_mismatch", "结算 task 的预算 binding 已变化", 409);
  }
  const terminalLedgerIds = terminalRows.map((row: Record<string, unknown>) => boundedText(row.id, "terminal ledger id", 200));
  const evidenceSha256 = privateValidationBudgetSettlementEvidenceSha256({
    bindingSha256: binding.bindingSha256,
    taskId,
    requestId: boundedText(slot.requestId, "slot requestId", 1_024),
    providerTaskIdSha256: sha256Text(providerTaskId),
    reservationId: boundedText(slot.reservationId, "slot reservationId", 200),
    usageRecordId: boundedText(slot.usageRecordId, "slot usageRecordId", 200),
    reservedGuMicros: slot.reservedGuMicros,
    actualGuMicros,
    terminalLedgerIds,
    reconcileJobId: boundedText(watchdog.id, "reconcile job id", 200),
  });
  if (slot.state === "settled") {
    if (
      slot.actualGuMicros !== actualGuMicros
      || slot.providerTaskIdSha256 !== sha256Text(providerTaskId)
      || slot.evidenceSha256 !== evidenceSha256
    ) {
      budgetError("private_validation_budget_settlement_conflict", "预算槽已被不同结算处理", 409);
    }
    return;
  }
  if (slot.state !== "dispatch_started") {
    budgetError("private_validation_budget_settlement_conflict", "预算槽未处于可结算派发状态", 409);
  }
  const checkpoint = replaceSlot(locked.checkpoint, binding.slot, {
    ...slot,
    state: "settled",
    providerTaskIdSha256: sha256Text(providerTaskId),
    actualGuMicros,
    terminalAt: input.now ?? Date.now(),
    evidenceSha256,
  });
  await persistCheckpoint(transaction, locked.row, locked.checkpoint, checkpoint);
}

export async function abortReleaseFullMaintenancePrivateValidationBudgetSlotBeforeBillingInTransaction(
  transaction: Knex.Transaction,
  input: {
    binding: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding;
    taskId: string;
    reason: string;
    now?: number;
  },
): Promise<void> {
  const binding = assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(input.binding);
  const taskId = boundedText(input.taskId, "taskId", 200);
  const reason = boundedText(input.reason, "reason", 200);
  const terminalAt = input.now ?? Date.now();
  const locked = await lockedBudgetRow(transaction, handleFromBinding(binding));
  const matched = assertBindingMatchesSlot(binding, locked.checkpoint);
  const slot = matched.slot;
  const [task, usages, ledgers, reconciles] = await Promise.all([
    transaction("o_relay_task").where({
      id: taskId,
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
      requestId: slot.requestId,
      endpointType: "video_generation",
      provider: slot.provider,
      channelId: slot.channelId,
      model: slot.model,
    }).first(),
    transaction("o_usage_record").where({
      workspaceId: binding.workspaceId,
      taskId,
    }),
    transaction("o_billing_ledger").where({
      workspaceId: binding.workspaceId,
      relatedTaskId: taskId,
    }),
    transaction("o_billing_reconcile_job").where({
      workspaceId: binding.workspaceId,
      requestId: slot.requestId,
      endpointType: "video_generation",
    }),
  ]);
  const providerPayload = task
    ? (typeof task.providerPayload === "string"
        ? record(parseJson(task.providerPayload, "relay providerPayload"), "relay providerPayload")
        : record(task.providerPayload, "relay providerPayload"))
    : {};
  const submission = providerPayload.submission
    && typeof providerPayload.submission === "object"
    && !Array.isArray(providerPayload.submission)
    ? providerPayload.submission as Record<string, unknown>
    : {};
  const submissionState = String(submission.state || "");
  if (
    !task
    || !["queued", "running", "failed", "cancelled"].includes(String(task.status || ""))
    || task.providerTaskId != null
    || task.submittedAt != null
    || ["dispatch_started", "accepted", "pending_reconcile", "captured"].includes(submissionState)
    || usages.length !== 0
    || ledgers.length !== 0
    || reconciles.length !== 0
    || !sameBinding(parseStoredBinding(task as Record<string, unknown>), binding)
  ) {
    budgetError(
      "private_validation_budget_prebilling_abort_evidence_mismatch",
      "预算槽 pre-billing 关闭缺少 exact non-dispatched task / zero-commercial 证据",
      409,
    );
  }
  const evidenceSha256 = releaseFullMaintenancePrivateValidationBudgetSha256({
    format: "fanjin-release-full-maintenance-private-validation-budget-prebilling-abort/v1",
    bindingSha256: binding.bindingSha256,
    taskId,
    requestId: slot.requestId,
    provider: slot.provider,
    channelId: slot.channelId,
    model: slot.model,
    reservedGuMicros: slot.reservedGuMicros,
    reason,
  });
  if (slot.state === "released_prebilling") {
    if (
      slot.taskId !== taskId
      || slot.reservationId !== null
      || slot.usageRecordId !== null
      || slot.actualGuMicros !== 0
      || slot.evidenceSha256 !== evidenceSha256
    ) {
      budgetError(
        "private_validation_budget_prebilling_abort_conflict",
        "预算槽已被不同 pre-billing 证明关闭",
        409,
      );
    }
    return;
  }
  if (slot.state !== "gu_reserved") {
    budgetError(
      "private_validation_budget_prebilling_abort_conflict",
      "预算槽不是可关闭的 GU 预占状态",
      409,
    );
  }
  const checkpoint = replaceSlot(locked.checkpoint, binding.slot, {
    ...slot,
    state: "released_prebilling",
    taskId,
    reservationId: null,
    usageRecordId: null,
    providerTaskIdSha256: null,
    actualGuMicros: 0,
    dispatchStartedAt: null,
    terminalAt,
    evidenceSha256,
  });
  await persistCheckpoint(transaction, locked.row, locked.checkpoint, checkpoint);
}

export async function releaseReleaseFullMaintenancePrivateValidationBudgetSlotInTransaction(
  transaction: Knex.Transaction,
  input: {
    binding: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding;
    taskId: string;
    reservationId: string;
    releaseProof: "not_dispatched" | "definitive_not_billable" | "customer_not_delivered_platform_absorbed";
    now?: number;
  },
): Promise<void> {
  const binding = assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(input.binding);
  const taskId = boundedText(input.taskId, "taskId", 200);
  const reservationId = boundedText(input.reservationId, "reservationId", 200);
  const locked = await lockedBudgetRow(transaction, handleFromBinding(binding));
  const matched = assertBindingMatchesSlot(binding, locked.checkpoint);
  const slot = matched.slot;
  const freeze = await transaction("o_billing_ledger").where({
    id: reservationId,
    workspaceId: binding.workspaceId,
    type: "freeze",
    relatedTaskId: taskId,
  }).first();
  const usageRecordId = String(freeze?.relatedUsageId || "").trim();
  const [task, usage, releases] = await Promise.all([
    transaction("o_relay_task").where({
      id: taskId,
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
    }).first(),
    transaction("o_usage_record").where({
      id: usageRecordId,
      workspaceId: binding.workspaceId,
      taskId,
      endpointType: "video_generation",
      status: "released",
      costMicros: 0,
    }).first(),
    transaction("o_billing_ledger").where({
      workspaceId: binding.workspaceId,
      relatedLedgerId: reservationId,
      type: "release",
    }),
  ]);
  if (
    !task
    || !freeze
    || !usage
    || !usageRecordId
    || releases.length !== 1
    || Number(freeze.amountMicros) !== slot.reservedGuMicros
    || Number(freeze.remainingMicros) !== 0
    || !sameBinding(parseStoredBinding(task as Record<string, unknown>), binding)
  ) {
    budgetError("private_validation_budget_release_evidence_missing", "预算释放缺少 exact freeze/usage/release 证据", 409);
  }
  const predispatch = input.releaseProof === "not_dispatched";
  const terminalState: ReleaseFullMaintenancePrivateValidationBudgetSlotState = predispatch
    ? "released_predispatch"
    : "terminal_no_charge";
  const evidenceSha256 = releaseFullMaintenancePrivateValidationBudgetSha256({
    format: "fanjin-release-full-maintenance-private-validation-budget-release/v1",
    bindingSha256: binding.bindingSha256,
    taskId,
    reservationId,
    usageRecordId,
    releaseLedgerId: String(releases[0].id || ""),
    releaseProof: input.releaseProof,
    terminalState,
  });
  if (slot.state === terminalState) {
    if (
      slot.taskId !== taskId
      || slot.reservationId !== reservationId
      || slot.usageRecordId !== usageRecordId
      || slot.actualGuMicros !== 0
      || slot.evidenceSha256 !== evidenceSha256
    ) {
      budgetError("private_validation_budget_release_conflict", "预算槽已被不同释放证明关闭", 409);
    }
    return;
  }
  if ((predispatch && slot.state !== "gu_reserved") || (!predispatch && slot.state !== "dispatch_started")) {
    budgetError("private_validation_budget_release_conflict", "预算槽状态不允许该释放证明", 409);
  }
  const checkpoint = replaceSlot(locked.checkpoint, binding.slot, {
    ...slot,
    state: terminalState,
    taskId,
    reservationId,
    usageRecordId,
    actualGuMicros: 0,
    terminalAt: input.now ?? Date.now(),
    evidenceSha256,
  });
  await persistCheckpoint(transaction, locked.row, locked.checkpoint, checkpoint);
}

export async function markReleaseFullMaintenancePrivateValidationBudgetSlotPendingInTransaction(
  transaction: Knex.Transaction,
  input: {
    binding: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding;
    taskId: string;
    reservationId: string;
    usageRecordId: string;
    reason: string;
    actualGuMicros: number;
    now?: number;
  },
): Promise<void> {
  const binding = assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(input.binding);
  const taskId = boundedText(input.taskId, "taskId", 200);
  const reservationId = boundedText(input.reservationId, "reservationId", 200);
  const usageRecordId = boundedText(input.usageRecordId, "usageRecordId", 200);
  const reason = boundedText(input.reason, "reason", 200);
  const actualGuMicros = nonNegativeSafeInteger(input.actualGuMicros, "actualGuMicros");
  const locked = await lockedBudgetRow(transaction, handleFromBinding(binding));
  const matched = assertBindingMatchesSlot(binding, locked.checkpoint);
  const slot = matched.slot;
  if (slot.state !== "dispatch_started") {
    if (
      slot.state === "pending_reconcile"
      && slot.reservationId === reservationId
      && slot.usageRecordId === usageRecordId
      && slot.actualGuMicros === actualGuMicros
    ) return;
    budgetError("private_validation_budget_pending_conflict", "预算槽未处于可转待核账状态", 409);
  }
  const [freeze, usage, job] = await Promise.all([
    transaction("o_billing_ledger").where({
      id: reservationId,
      workspaceId: binding.workspaceId,
      type: "freeze",
      relatedTaskId: taskId,
    }).first(),
    transaction("o_usage_record").where({
      id: usageRecordId,
      workspaceId: binding.workspaceId,
      taskId,
      endpointType: "video_generation",
      status: "pending_reconcile",
    }).first(),
    transaction("o_billing_reconcile_job").where({
      dedupeKey: `reservation:${reservationId}`,
      workspaceId: binding.workspaceId,
      reservationId,
      usageRecordId,
      status: "pending",
      reason,
    }).first(),
  ]);
  if (!freeze || !usage || !job || Number(freeze.remainingMicros) <= 0) {
    budgetError("private_validation_budget_pending_evidence_missing", "待核账缺少 freeze/usage/job 证据", 409);
  }
  const evidenceSha256 = releaseFullMaintenancePrivateValidationBudgetSha256({
    format: "fanjin-release-full-maintenance-private-validation-budget-pending/v1",
    bindingSha256: binding.bindingSha256,
    taskId,
    reservationId,
    usageRecordId,
    reconcileJobId: String(job.id || ""),
    reason,
    actualGuMicros,
  });
  const checkpoint = replaceSlot(locked.checkpoint, binding.slot, {
    ...slot,
    state: "pending_reconcile",
    actualGuMicros,
    terminalAt: input.now ?? Date.now(),
    evidenceSha256,
  });
  await persistCheckpoint(transaction, locked.row, locked.checkpoint, checkpoint);
}

export async function readFinalReleaseFullMaintenancePrivateValidationBudget(input: {
  handle: ReleaseFullMaintenancePrivateValidationBudgetHandle;
  database?: BudgetDatabase;
}): Promise<ReleaseFullMaintenancePrivateValidationBudgetFinalEvidence> {
  const database = input.database ?? db;
  return await inTransaction(database, async (transaction) => {
    const locked = await lockedBudgetRow(transaction, input.handle);
    const checkpoint = locked.checkpoint;
    if (checkpoint.status !== "settled") {
      budgetError("private_validation_budget_not_settled", "两个验证预算槽尚未全部 exact settled", 409);
    }
    const evidence: Array<ReleaseFullMaintenancePrivateValidationBudgetFinalEvidence["slots"][number]> = [];
    const taskIds = new Set<string>();
    const requestIds = new Set<string>();
    const providerTaskIds = new Set<string>();
    for (const slotName of releaseFullMaintenancePrivateValidationBudgetSlots) {
      const slot = checkpoint.slots[slotName];
      if (
        slot.state !== "settled"
        || !slot.taskId
        || !slot.requestId
        || !slot.reservationId
        || !slot.usageRecordId
        || !slot.providerTaskIdSha256
        || slot.actualGuMicros === null
        || !slot.evidenceSha256
      ) {
        budgetError("private_validation_budget_final_invalid", `${slotName} 不是 exact settled`, 409);
      }
      const [tasks, usages, freezes, terminalRows, reconcileRows] = await Promise.all([
        transaction("o_relay_task").where({
          id: slot.taskId,
          workspaceId: checkpoint.workspaceId,
          projectId: checkpoint.projectId,
          requestId: slot.requestId,
          endpointType: "video_generation",
          status: "succeeded",
        }),
        transaction("o_usage_record").where({
          id: slot.usageRecordId,
          workspaceId: checkpoint.workspaceId,
          taskId: slot.taskId,
          endpointType: "video_generation",
        }),
        transaction("o_billing_ledger").where({
          id: slot.reservationId,
          workspaceId: checkpoint.workspaceId,
          relatedTaskId: slot.taskId,
          relatedUsageId: slot.usageRecordId,
          type: "freeze",
        }),
        transaction("o_billing_ledger")
          .where({ workspaceId: checkpoint.workspaceId, relatedLedgerId: slot.reservationId })
          .whereIn("type", ["deduct", "release"])
          .orderBy("createdAt", "asc")
          .orderBy("id", "asc"),
        transaction("o_billing_reconcile_job").where({
          workspaceId: checkpoint.workspaceId,
          reservationId: slot.reservationId,
        }),
      ]);
      const task = tasks.length === 1 ? tasks[0] as Record<string, unknown> : null;
      const usage = usages.length === 1 ? usages[0] as Record<string, unknown> : null;
      const freeze = freezes.length === 1 ? freezes[0] as Record<string, unknown> : null;
      const reconcile = reconcileRows.length === 1 ? reconcileRows[0] as Record<string, unknown> : null;
      const providerTaskId = String(task?.providerTaskId || "").trim();
      const captureRows = terminalRows
        .filter((row: Record<string, unknown>) => row.type === "deduct");
      const releaseRows = terminalRows
        .filter((row: Record<string, unknown>) => row.type === "release");
      const captureMicros = captureRows
        .reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.amountMicros || 0), 0);
      const releaseMicros = releaseRows
        .reduce((sum: number, row: Record<string, unknown>) => sum + Number(row.amountMicros || 0), 0);
      const terminalLedgerIds = terminalRows.map((row: Record<string, unknown>) => (
        String(row.id || "").trim()
      ));
      const reconcileJobId = String(reconcile?.id || "").trim();
      const expectedEvidenceSha256 = task && providerTaskId && reconcileJobId
        ? privateValidationBudgetSettlementEvidenceSha256({
            bindingSha256: bindingFrom(locked.handle, slot).bindingSha256,
            taskId: slot.taskId,
            requestId: slot.requestId,
            providerTaskIdSha256: sha256Text(providerTaskId),
            reservationId: slot.reservationId,
            usageRecordId: slot.usageRecordId,
            reservedGuMicros: slot.reservedGuMicros,
            actualGuMicros: slot.actualGuMicros,
            terminalLedgerIds,
            reconcileJobId,
          })
        : null;
      if (
        !task
        || !usage
        || !freeze
        || !reconcile
        || !providerTaskId
        || !sameBinding(parseStoredBinding(task), bindingFrom(locked.handle, slot))
        || String(task.provider || "") !== slot.provider
        || String(task.channelId || "") !== slot.channelId
        || String(task.model || "") !== slot.model
        || sha256Text(providerTaskId) !== slot.providerTaskIdSha256
        || Number(usage.costMicros) !== slot.actualGuMicros
        || String(usage.currency || "") !== "GU"
        || !["charged", "free"].includes(String(usage.status || ""))
        || String(usage.provider || "") !== slot.provider
        || String(usage.channelId || "") !== slot.channelId
        || String(usage.model || "") !== slot.model
        || Number(freeze.amountMicros) !== slot.reservedGuMicros
        || Number(freeze.remainingMicros) !== 0
        || String(freeze.currency || "") !== "GU"
        || String(freeze.status || "") !== (
          slot.actualGuMicros === slot.reservedGuMicros ? "captured" : "released"
        )
        || captureRows.length !== (slot.actualGuMicros > 0 ? 1 : 0)
        || releaseRows.length !== (slot.actualGuMicros < slot.reservedGuMicros ? 1 : 0)
        || terminalLedgerIds.some((id: string) => !id)
        || !terminalRows.every((row: Record<string, unknown>) => (
          String(row.relatedTaskId || "") === slot.taskId
          && String(row.relatedUsageId || "") === slot.usageRecordId
          && String(row.requestId || "") === slot.requestId
          && String(row.currency || "") === "GU"
          && String(row.status || "") === "succeeded"
          && Number(row.remainingMicros || 0) === 0
        ))
        || captureMicros !== slot.actualGuMicros
        || releaseMicros !== slot.reservedGuMicros - slot.actualGuMicros
        || captureMicros + releaseMicros !== slot.reservedGuMicros
        || String(reconcile.dedupeKey || "") !== `reservation:${slot.reservationId}`
        || !reconcileJobId
        || String(reconcile.requestId || "") !== slot.requestId
        || String(reconcile.endpointType || "") !== "video_generation"
        || String(reconcile.provider || "") !== slot.provider
        || String(reconcile.channelId || "") !== slot.channelId
        || String(reconcile.reservationId || "") !== slot.reservationId
        || String(reconcile.usageRecordId || "") !== slot.usageRecordId
        || String(reconcile.reason || "") !== "dispatch_watchdog"
        || String(reconcile.status || "") !== "resolved"
        || String(reconcile.decision || "") !== "reservation_settled"
        || reconcile.leaseOwner != null
        || reconcile.leaseExpiresAt != null
        || reconcile.lastError != null
        || !Number.isSafeInteger(Number(reconcile.resolvedAt))
        || expectedEvidenceSha256 !== slot.evidenceSha256
      ) {
        budgetError("private_validation_budget_final_evidence_mismatch", `${slotName} 最终 task/billing/reconcile 读回不精确`, 409);
      }
      if (
        taskIds.has(slot.taskId)
        || requestIds.has(slot.requestId)
        || providerTaskIds.has(providerTaskId)
      ) {
        budgetError("private_validation_budget_final_duplicate", "两个预算槽复用了 task/request/provider identity", 409);
      }
      taskIds.add(slot.taskId);
      requestIds.add(slot.requestId);
      providerTaskIds.add(providerTaskId);
      evidence.push(Object.freeze({
        slot: slotName,
        taskId: slot.taskId,
        requestId: slot.requestId,
        providerTaskIdSha256: slot.providerTaskIdSha256,
        reservationId: slot.reservationId,
        usageRecordId: slot.usageRecordId,
        reservedGuMicros: slot.reservedGuMicros,
        actualGuMicros: slot.actualGuMicros,
        terminalLedgerIds: Object.freeze(terminalLedgerIds),
        reconcileJobId,
        evidenceSha256: slot.evidenceSha256,
      }));
    }
    const totalReservedGuMicros = evidence.reduce((sum, slot) => sum + slot.reservedGuMicros, 0);
    const totalActualGuMicros = evidence.reduce((sum, slot) => sum + slot.actualGuMicros, 0);
    if (
      evidence.length !== checkpoint.maximumProviderTasks
      || totalReservedGuMicros > checkpoint.maximumGuMicros
      || totalActualGuMicros > checkpoint.maximumGuMicros
    ) {
      budgetError("private_validation_budget_final_exceeded", "最终验证任务数或 GU 超过授权上限", 409);
    }
    const payload = {
      format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_FINAL_FORMAT,
      budgetId: locked.handle.budgetId,
      deploymentId: checkpoint.deploymentId,
      releaseBindingSha256: checkpoint.releaseBindingSha256,
      validationPlanSha256: checkpoint.validationPlanSha256,
      workspaceId: checkpoint.workspaceId,
      projectId: checkpoint.projectId,
      maximumProviderTasks: 2 as const,
      maximumGuMicros: checkpoint.maximumGuMicros,
      providerTaskCount: 2 as const,
      totalReservedGuMicros,
      totalActualGuMicros,
      checkpointSha256: checkpoint.checkpointSha256,
      slots: Object.freeze(evidence),
    };
    return Object.freeze({
      ...payload,
      evidenceSha256: releaseFullMaintenancePrivateValidationBudgetSha256(payload),
    });
  });
}
