/**
 * Canonical ids that may appear in an Agent-facing capability contract.
 * Availability is still derived from the request-scoped server catalog; this
 * list is only the permanent upper bound and must never be widened by model
 * input.
 */
export const AGENT_CAPABILITY_TOOL_IDS = [
  "context.snapshot.get",
  "capability.search",
  "capability.describe",
  "toolpack.load",
  "approval.request",
  "agent.delegate",
  "plan.present",
  "project.get",
  "project.update",
  "project.archive",
  "session.get",
  "session.update",
  "script.list",
  "script.get",
  "script.draft.create",
  "script.draft.update",
  "asset.search",
  "asset.get",
  "asset.version.list",
  "asset.spec.create",
  "asset.spec.update",
  "asset.archive",
  "asset.delete",
  "storyboard.list",
  "storyboard.get",
  "storyboard.draft.upsert",
  "storyboard.draft.reorder",
  "canvas.get",
  "canvas.selection.get",
  "canvas.commands.apply",
  "canvas.asset.attach",
  "generation.quote",
  "generation.image.submit",
  "generation.video.submit",
  "generation.task.list",
  "generation.task.get",
  "generation.task.cancel",
  "generation.task.retry",
  "video.merge",
  "delivery.preview",
  "delivery.draft.create",
  "delivery.publish",
  "delivery.share",
  "review.report.get",
  "review.report.create",
] as const;

/** Canonical ids retained for internal policy enforcement, never discovery. */
export const R4_TOOL_IDS = [
  "system.sql.execute",
  "system.shell.execute",
  "system.file.read",
  "system.file.write",
  "admin.workspace.update",
  "provider.credential.read",
  "billing.admin.adjust",
] as const;

/**
 * Controller-owned audit operations. They remain canonical for server-side
 * policy and persistence, but are never projected into any model catalog.
 */
export const MODEL_HIDDEN_TOOL_IDS = [
  "review.report.get",
  "review.report.create",
] as const satisfies readonly (typeof AGENT_CAPABILITY_TOOL_IDS)[number][];

export const TOOL_IDS = [
  ...AGENT_CAPABILITY_TOOL_IDS,
  ...R4_TOOL_IDS,
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

declare const toolWildcardSelectorBrand: unique symbol;

export type ToolWildcardSelector = string & {
  readonly [toolWildcardSelectorBrand]: "ToolWildcardSelector";
};

export type ToolSelector = ToolId | ToolWildcardSelector;

export const LEGACY_TOOL_ALIASES = [
  "context.get_project_snapshot",
  "capabilities.search",
  "capabilities.describe",
  "project.update_brief",
  "script.apply_patch",
  "assets.search",
  "assets.get_version",
  "assets.archive",
  "storyboard.apply_patch",
  "canvas.get_snapshot",
  "canvas.apply_patch",
  "generation.estimate",
  "generation.create_image_task",
  "generation.create_video_task",
  "tasks.get_status",
  "tasks.cancel",
  "tasks.retry",
  "delivery.create_draft",
  "run.get_status",
] as const;

export type LegacyToolAlias = (typeof LEGACY_TOOL_ALIASES)[number];

const toolIdSet = new Set<string>(TOOL_IDS);
const r4ToolIdSet = new Set<string>(R4_TOOL_IDS);
const modelHiddenToolIdSet = new Set<string>(MODEL_HIDDEN_TOOL_IDS);
const selectorSegmentPattern = /^(?:\*|[a-z][a-z0-9_-]*)$/;

export function isToolId(value: unknown): value is ToolId {
  return typeof value === "string" && toolIdSet.has(value);
}

export type R4ToolId = (typeof R4_TOOL_IDS)[number];

export function isR4ToolId(value: unknown): value is R4ToolId {
  return typeof value === "string" && r4ToolIdSet.has(value);
}

export type ModelHiddenToolId = (typeof MODEL_HIDDEN_TOOL_IDS)[number];

export function isModelHiddenToolId(value: unknown): value is ModelHiddenToolId {
  return typeof value === "string" && modelHiddenToolIdSet.has(value);
}

export function assertToolId(value: unknown): asserts value is ToolId {
  if (!isToolId(value)) throw new TypeError(`未知或非 canonical ToolId: ${String(value)}`);
}

function selectorPattern(selector: string): RegExp | null {
  if (selector === "*") return /^.*$/;
  const segments = selector.split(".");
  if (segments.length < 2 || !segments.every((segment) => selectorSegmentPattern.test(segment))) return null;
  const source = segments
    .map((segment) => (segment === "*" ? ".*" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("\\.");
  return new RegExp(`^${source}$`);
}

export function isToolSelector(value: unknown): value is ToolSelector {
  if (isToolId(value)) return true;
  if (typeof value !== "string" || !value.includes("*")) return false;
  const pattern = selectorPattern(value);
  return pattern !== null && TOOL_IDS.some((toolId) => pattern.test(toolId));
}

export function assertToolSelector(value: unknown): asserts value is ToolSelector {
  if (!isToolSelector(value)) {
    throw new TypeError(`无效 ToolSelector（未知 namespace、旧别名或未匹配任何 canonical ToolId）: ${String(value)}`);
  }
}

export function defineToolSelectors(...values: readonly string[]): readonly ToolSelector[] {
  for (const value of values) assertToolSelector(value);
  return Object.freeze([...values]) as readonly ToolSelector[];
}

export function matchesToolSelector(toolName: unknown, selector: unknown): boolean {
  if (!isToolId(toolName) || !isToolSelector(selector)) return false;
  if (selector === "*") return true;
  if (!selector.includes("*")) return toolName === selector;
  return selectorPattern(selector)?.test(toolName) === true;
}
