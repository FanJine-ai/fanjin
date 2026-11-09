import type { ToolManifest } from "@/agent-runtime/contracts";
import {
  AGENT_MAIN_CANVAS_COMMANDS_PROMPT_VERSION,
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4,
  AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_GENERATION_PREFERENCE_PROMPT_VERSION,
  AGENT_MAIN_PLAN_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_PROMPT_KEY,
  AGENT_MAIN_R1_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_SCRIPT_DRAFT_PROMPT_VERSION,
  AGENT_MAIN_TOOLS_PROMPT_VERSION,
} from "@/agent-runtime/runtimeConfigRegistry";
import { getAgentDelegateContractForPromptVersion } from "@/agent-runtime/tools/packages/delegation";
import {
  isModelHiddenToolId,
  isR4ToolId,
  isToolId,
  type ToolId,
} from "@/agent-runtime/toolIds";

/**
 * The complete R1 write surface understood by the immutable v3 main-Agent
 * Prompt. Adding another R1 manifest to the Registry must not widen this set.
 */
export const MAIN_AGENT_R1_MODEL_TOOL_IDS_V3 = Object.freeze([
  "project.update",
  "session.update",
] as const satisfies readonly ToolId[]);

export const MAIN_AGENT_DELEGATION_MODEL_TOOL_ID_V4 = "agent.delegate" as const satisfies ToolId;

/**
 * The single R1 canvas write admitted by the immutable v7 main-Agent Prompt.
 * It is gated to exactly that Prompt version: v3/v4/v5/v6 Runs must never
 * inherit it, and the frozen V3 set above stays untouched.
 */
export const MAIN_AGENT_CANVAS_COMMANDS_MODEL_TOOL_ID_V7 = "canvas.commands.apply" as const satisfies ToolId;

/**
 * The two R1 script-draft writes admitted by the immutable v8 main-Agent
 * Prompt. They are gated to exactly that Prompt version: v2-v7 Runs must
 * never inherit them, and the frozen V3 set above stays untouched.
 */
export const MAIN_AGENT_SCRIPT_DRAFT_MODEL_TOOL_IDS_V8 = Object.freeze([
  "script.draft.create",
  "script.draft.update",
] as const satisfies readonly ToolId[]);

export const MAIN_AGENT_MODEL_TOOL_PROMPT_VERSIONS = Object.freeze([
  AGENT_MAIN_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_R1_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4,
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_PLAN_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_CANVAS_COMMANDS_PROMPT_VERSION,
  AGENT_MAIN_SCRIPT_DRAFT_PROMPT_VERSION,
  AGENT_MAIN_GENERATION_PREFERENCE_PROMPT_VERSION,
  AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION,
] as const);

export type MainAgentModelToolPromptVersion =
  (typeof MAIN_AGENT_MODEL_TOOL_PROMPT_VERSIONS)[number];

const r1ModelToolIdsV3 = new Set<string>(MAIN_AGENT_R1_MODEL_TOOL_IDS_V3);
const scriptDraftModelToolIdsV8 = new Set<string>(MAIN_AGENT_SCRIPT_DRAFT_MODEL_TOOL_IDS_V8);

export function isMainAgentModelToolPromptVersion(
  value: unknown,
): value is MainAgentModelToolPromptVersion {
  return typeof value === "string"
    && (MAIN_AGENT_MODEL_TOOL_PROMPT_VERSIONS as readonly string[]).includes(value);
}

export function isMainAgentR1ModelToolIdV3(value: unknown): value is "project.update" | "session.update" {
  return typeof value === "string" && r1ModelToolIdsV3.has(value);
}

export function isMainAgentScriptDraftModelToolIdV8(value: unknown): value is "script.draft.create" | "script.draft.update" {
  return typeof value === "string" && scriptDraftModelToolIdsV8.has(value);
}

/** R0 model tools are bounded, non-metered queries only. */
export function isSafeR0ModelTool(manifest: ToolManifest): boolean {
  return manifest.riskClass === "R0"
    && manifest.availability.state === "available"
    && !manifest.mutatesState
    && !manifest.metered
    && isToolId(manifest.name)
    && !isModelHiddenToolId(manifest.name)
    && !isR4ToolId(manifest.name);
}

/** R2/R3 calls still require the Controller's exact approval pause/resume. */
export function modelToolRequiresControllerApproval(manifest: ToolManifest): boolean {
  return isToolId(manifest.name)
    && !isModelHiddenToolId(manifest.name)
    && !isR4ToolId(manifest.name)
    && (manifest.riskClass === "R2" || manifest.riskClass === "R3");
}

export interface MainAgentModelToolExposureInput {
  promptKey: unknown;
  promptVersion: unknown;
  /** Exact immutable Run snapshot value; live environment flags are forbidden here. */
  delegationEnabled: unknown;
  /** Must come from the server-derived catalog for this exact model Turn. */
  manifest: ToolManifest;
}

/**
 * Fail-closed upper bound for projecting a server-derived current-Turn catalog
 * into a main-Agent model request. It does not replace role/permission/Grant
 * filtering or the Controller's R2/R3 approval state machine.
 */
export function mayExposeMainAgentModelTool(
  input: MainAgentModelToolExposureInput,
): boolean {
  const { manifest } = input;
  if (input.promptKey !== AGENT_MAIN_PROMPT_KEY
    || !isMainAgentModelToolPromptVersion(input.promptVersion)
    || !isToolId(manifest.name)
    || manifest.availability.state !== "available"
    || manifest.riskClass === "R4"
    || isModelHiddenToolId(manifest.name)
    || isR4ToolId(manifest.name)) {
    return false;
  }

  if (manifest.name === MAIN_AGENT_DELEGATION_MODEL_TOOL_ID_V4) {
    const contract = getAgentDelegateContractForPromptVersion(input.promptVersion);
    return contract !== null
      && input.delegationEnabled === true
      && manifest.version === contract.tool.manifest.version
      && manifest.riskClass === "R1"
      && manifest.mutatesState
      && !manifest.metered;
  }

  // The v7 canvas write is bound to the v7 Prompt and to Prompts that embed
  // its boundary verbatim (currently v8). It must never fall through to an
  // older Prompt, the frozen V3 set or a different risk branch if the
  // manifest is accidentally relabelled.
  if (manifest.name === MAIN_AGENT_CANVAS_COMMANDS_MODEL_TOOL_ID_V7) {
    return (input.promptVersion === AGENT_MAIN_CANVAS_COMMANDS_PROMPT_VERSION
        || input.promptVersion === AGENT_MAIN_SCRIPT_DRAFT_PROMPT_VERSION)
      && manifest.riskClass === "R1"
      && manifest.mutatesState
      && !manifest.metered;
  }

  // The v8 script-draft writes are bound to exactly the v8 Prompt. They must
  // never fall through to an older Prompt, the frozen V3 set or a different
  // risk branch if a manifest is accidentally relabelled.
  if (isMainAgentScriptDraftModelToolIdV8(manifest.name)) {
    return input.promptVersion === AGENT_MAIN_SCRIPT_DRAFT_PROMPT_VERSION
      && manifest.riskClass === "R1"
      && manifest.mutatesState
      && !manifest.metered;
  }

  // These semantic write ids must never fall through to an older Prompt or a
  // different risk branch if a manifest is accidentally relabelled.
  if (isMainAgentR1ModelToolIdV3(manifest.name)) {
    return (input.promptVersion === AGENT_MAIN_R1_TOOLS_PROMPT_VERSION
        || input.promptVersion === AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4
        || input.promptVersion === AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION
        || input.promptVersion === AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION)
      && manifest.riskClass === "R1"
      && manifest.mutatesState
      && !manifest.metered;
  }

  if (manifest.riskClass === "R0") return isSafeR0ModelTool(manifest);
  if (manifest.riskClass === "R1") return false;

  // Catalog construction and the Controller must already have authorized the
  // exact R2/R3 call. Keeping them projectable here preserves the existing
  // approval-mediated behavior; neither class may execute from this predicate.
  return manifest.riskClass === "R2" || manifest.riskClass === "R3";
}
