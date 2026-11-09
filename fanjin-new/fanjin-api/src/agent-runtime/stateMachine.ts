export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "waiting_delegation",
  "waiting_external",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "waiting_external",
  "succeeded",
  "failed",
  "cancelled",
  "uncertain",
] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const satisfies readonly RunStatus[];
export const TERMINAL_STEP_STATUSES = ["succeeded", "failed", "cancelled", "uncertain"] as const satisfies readonly StepStatus[];

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelling", "cancelled", "failed"],
  running: [
    "queued",
    "waiting_approval",
    "waiting_input",
    "waiting_delegation",
    "waiting_external",
    "cancelling",
    "succeeded",
    "failed",
  ],
  waiting_approval: ["queued", "cancelling", "cancelled"],
  waiting_input: ["queued", "cancelling"],
  waiting_delegation: ["queued", "cancelling"],
  waiting_external: ["queued", "cancelling", "succeeded", "failed"],
  cancelling: ["cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  queued: ["awaiting_approval", "running", "cancelled"],
  running: ["waiting_external", "succeeded", "failed", "cancelled", "uncertain"],
  awaiting_approval: ["queued", "cancelled"],
  waiting_external: ["succeeded", "failed", "cancelled", "uncertain"],
  succeeded: [],
  failed: [],
  cancelled: [],
  uncertain: [],
};

export type StateMachineEntity = "run" | "step";

export class InvalidStateTransitionError extends Error {
  readonly code = "INVALID_STATE_TRANSITION";
  readonly entity: StateMachineEntity;
  readonly from: RunStatus | StepStatus;
  readonly to: RunStatus | StepStatus;

  constructor(entity: StateMachineEntity, from: RunStatus | StepStatus, to: RunStatus | StepStatus) {
    super(`不允许 ${entity} 从 ${from} 转换到 ${to}`);
    this.name = "InvalidStateTransitionError";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status as (typeof TERMINAL_RUN_STATUSES)[number]);
}

export function isTerminalStepStatus(status: StepStatus): boolean {
  return TERMINAL_STEP_STATUSES.includes(status as (typeof TERMINAL_STEP_STATUSES)[number]);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) throw new InvalidStateTransitionError("run", from, to);
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!canTransitionStep(from, to)) throw new InvalidStateTransitionError("step", from, to);
}
