import crypto from "node:crypto";

export const QUICK_CREATE_EMPTY_DRAFT_BODY_CONTRACT_VERSION =
  "quick-create-empty-draft/v1" as const;

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;
const SECRET_KEY = /^(?:api[-_]?key|authorization|cookie|credential|password|secret|token)$/iu;
const PARAMETER_KEYS = Object.freeze([
  "activeEntry",
  "autoEnabled",
  "directorPlan",
  "duration",
  "generatedImageAssets",
  "imageModel",
  "imageQuality",
  "llmModel",
  "materializedProject",
  "preferenceTab",
  "ratio",
  "selectedSkillIds",
  "selectedSubjectIds",
  "shotCount",
  "style",
  "targetType",
  "uploadedAttachments",
  "videoAudio",
  "videoModel",
  "videoResolution",
] as const);

export class IsolatedSessionQuickCreateBodyContractError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "IsolatedSessionQuickCreateBodyContractError";
  }
}

function fail(code: string): never {
  throw new IsolatedSessionQuickCreateBodyContractError(code);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort(compare).join("\0")
    === [...keys].sort(compare).join("\0");
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 30) fail("QUICK_CREATE_EMPTY_DRAFT_VALUE_INVALID");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail("QUICK_CREATE_EMPTY_DRAFT_VALUE_INVALID");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 20_000) fail("QUICK_CREATE_EMPTY_DRAFT_VALUE_INVALID");
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("QUICK_CREATE_EMPTY_DRAFT_VALUE_INVALID");
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (
      entries.length > 500
      || entries.some(([key, item]) => (
        key.length > 200
        || SECRET_KEY.test(key)
        || ["__proto__", "constructor", "prototype"].includes(key)
        || item === undefined
      ))
    ) fail("QUICK_CREATE_EMPTY_DRAFT_VALUE_INVALID");
    return `{${entries
      .sort(([left], [right]) => compare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`)
      .join(",")}}`;
  }
  return fail("QUICK_CREATE_EMPTY_DRAFT_VALUE_INVALID");
}

function binding(domain: string, value: unknown): string {
  const canonical = canonicalJson({ domain, value });
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function exactEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}

function exactIdentifierList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 200
    && value.every((item) => typeof item === "string" && IDENTIFIER.test(item))
    && new Set(value).size === value.length;
}

export type QuickCreateEmptyDraftImageSelection = Readonly<{
  model: string;
  quality: "1K" | "2K" | "4K";
}>;

export type QuickCreateEmptyDraftVideoSelection = Readonly<{
  model: string;
  resolution: string;
  audio: boolean;
}>;

export type QuickCreateEmptyDraftBodyContract = Readonly<{
  kind: typeof QUICK_CREATE_EMPTY_DRAFT_BODY_CONTRACT_VERSION;
  templateId: string;
  initialVersion: number;
  expectedVersion: number;
  fixedGoal: string;
  allowedLlmModelIds: readonly string[];
  allowedImageSelections: readonly QuickCreateEmptyDraftImageSelection[];
  allowedVideoSelections: readonly QuickCreateEmptyDraftVideoSelection[];
}>;

export type IsolatedSessionExactBodyContract = Readonly<{
  kind: "exact/v1";
}>;

export type IsolatedSessionRequestBodyContract =
  | IsolatedSessionExactBodyContract
  | QuickCreateEmptyDraftBodyContract;

function assertSelections(contract: QuickCreateEmptyDraftBodyContract): void {
  if (
    !exactIdentifierList(contract.allowedLlmModelIds)
    || !Array.isArray(contract.allowedImageSelections)
    || contract.allowedImageSelections.length < 1
    || contract.allowedImageSelections.length > 200
    || !Array.isArray(contract.allowedVideoSelections)
    || contract.allowedVideoSelections.length < 1
    || contract.allowedVideoSelections.length > 200
  ) fail("QUICK_CREATE_EMPTY_DRAFT_CONTRACT_INVALID");
  const imageKeys = new Set<string>();
  for (const selection of contract.allowedImageSelections) {
    if (
      !selection
      || typeof selection !== "object"
      || Array.isArray(selection)
      || !exactKeys(selection as Record<string, unknown>, ["model", "quality"])
      || !IDENTIFIER.test(selection.model)
      || !["1K", "2K", "4K"].includes(selection.quality)
    ) fail("QUICK_CREATE_EMPTY_DRAFT_CONTRACT_INVALID");
    const key = `${selection.model}\0${selection.quality}`;
    if (imageKeys.has(key)) fail("QUICK_CREATE_EMPTY_DRAFT_CONTRACT_INVALID");
    imageKeys.add(key);
  }
  const videoKeys = new Set<string>();
  for (const selection of contract.allowedVideoSelections) {
    if (
      !selection
      || typeof selection !== "object"
      || Array.isArray(selection)
      || !exactKeys(selection as Record<string, unknown>, ["audio", "model", "resolution"])
      || !IDENTIFIER.test(selection.model)
      || typeof selection.resolution !== "string"
      || selection.resolution.length < 1
      || selection.resolution.length > 100
      || selection.resolution !== selection.resolution.trim()
      || typeof selection.audio !== "boolean"
    ) fail("QUICK_CREATE_EMPTY_DRAFT_CONTRACT_INVALID");
    const key = `${selection.model}\0${selection.resolution}\0${selection.audio ? "1" : "0"}`;
    if (videoKeys.has(key)) fail("QUICK_CREATE_EMPTY_DRAFT_CONTRACT_INVALID");
    videoKeys.add(key);
  }
}

export function assertQuickCreateEmptyDraftBodyContract(
  value: unknown,
): asserts value is QuickCreateEmptyDraftBodyContract {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || !exactKeys(value as Record<string, unknown>, [
      "allowedImageSelections",
      "allowedLlmModelIds",
      "allowedVideoSelections",
      "expectedVersion",
      "fixedGoal",
      "initialVersion",
      "kind",
      "templateId",
    ])
  ) return fail("QUICK_CREATE_EMPTY_DRAFT_CONTRACT_INVALID");
  const contract = value as QuickCreateEmptyDraftBodyContract;
  if (
    contract.kind !== QUICK_CREATE_EMPTY_DRAFT_BODY_CONTRACT_VERSION
    || !IDENTIFIER.test(contract.templateId)
    || !positiveInteger(contract.initialVersion)
    || !positiveInteger(contract.expectedVersion)
    || ![contract.initialVersion, contract.initialVersion + 1]
      .includes(contract.expectedVersion)
    || typeof contract.fixedGoal !== "string"
    || contract.fixedGoal.length < 1
    || contract.fixedGoal.length > 4_000
    || contract.fixedGoal !== contract.fixedGoal.trim()
  ) return fail("QUICK_CREATE_EMPTY_DRAFT_CONTRACT_INVALID");
  assertSelections(contract);
  canonicalJson(contract);
}

function profileProjection(contract: QuickCreateEmptyDraftBodyContract): unknown {
  return {
    kind: contract.kind,
    templateId: contract.templateId,
    initialVersion: contract.initialVersion,
    fixedGoal: contract.fixedGoal,
    allowedLlmModelIds: contract.allowedLlmModelIds,
    allowedImageSelections: contract.allowedImageSelections,
    allowedVideoSelections: contract.allowedVideoSelections,
  };
}

export function quickCreateEmptyDraftBodyContractBinding(
  contract: QuickCreateEmptyDraftBodyContract,
): string {
  assertQuickCreateEmptyDraftBodyContract(contract);
  return binding(`${contract.kind}/contract`, contract);
}

export function quickCreateEmptyDraftProfileBinding(
  contract: QuickCreateEmptyDraftBodyContract,
): string {
  assertQuickCreateEmptyDraftBodyContract(contract);
  return binding(`${contract.kind}/profile`, profileProjection(contract));
}

export function buildQuickCreateEmptyDraftExemplar(
  contract: QuickCreateEmptyDraftBodyContract,
): Readonly<Record<string, unknown>> {
  assertQuickCreateEmptyDraftBodyContract(contract);
  const image = contract.allowedImageSelections[0];
  const video = contract.allowedVideoSelections[0];
  return Object.freeze({
    expectedVersion: contract.expectedVersion,
    goal: contract.fixedGoal,
    mode: "quick_create",
    parameters: Object.freeze({
      activeEntry: "创意导演",
      autoEnabled: true,
      preferenceTab: "图片",
      style: "高级、清晰、商业化、真实光影",
      targetType: "广告视频",
      ratio: "16:9",
      llmModel: contract.allowedLlmModelIds[0],
      imageModel: image.model,
      imageQuality: image.quality,
      videoModel: video.model,
      videoResolution: video.resolution,
      videoAudio: video.audio,
      duration: 15,
      shotCount: 3,
      selectedSkillIds: Object.freeze([]),
      selectedSubjectIds: Object.freeze([]),
      directorPlan: null,
      materializedProject: null,
      generatedImageAssets: Object.freeze([]),
      uploadedAttachments: Object.freeze([]),
    }),
    selectedAssetVersionIds: Object.freeze([]),
  });
}

function parseRecord(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === "string") {
    if (Buffer.byteLength(parsed, "utf8") > 1024 * 1024) {
      return fail("QUICK_CREATE_EMPTY_DRAFT_BODY_INVALID");
    }
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fail("QUICK_CREATE_EMPTY_DRAFT_BODY_INVALID");
    }
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype
  ) return fail("QUICK_CREATE_EMPTY_DRAFT_BODY_INVALID");
  canonicalJson(parsed);
  return parsed as Record<string, unknown>;
}

function validateParameters(
  contract: QuickCreateEmptyDraftBodyContract,
  value: unknown,
): Record<string, unknown> {
  const parameters = parseRecord(value);
  if (!exactKeys(parameters, PARAMETER_KEYS)) {
    return fail("QUICK_CREATE_EMPTY_DRAFT_PARAMETERS_INVALID");
  }
  const imageAllowed = contract.allowedImageSelections.some((selection) => (
    selection.model === parameters.imageModel
    && selection.quality === parameters.imageQuality
  ));
  const videoAllowed = contract.allowedVideoSelections.some((selection) => (
    selection.model === parameters.videoModel
    && selection.resolution === parameters.videoResolution
    && selection.audio === parameters.videoAudio
  ));
  if (
    parameters.activeEntry !== "创意导演"
    || parameters.autoEnabled !== true
    || parameters.preferenceTab !== "图片"
    || parameters.style !== "高级、清晰、商业化、真实光影"
    || parameters.targetType !== "广告视频"
    || parameters.ratio !== "16:9"
    || typeof parameters.llmModel !== "string"
    || !contract.allowedLlmModelIds.includes(parameters.llmModel)
    || !imageAllowed
    || !videoAllowed
    || parameters.duration !== 15
    || parameters.shotCount !== 3
    || !exactEmptyArray(parameters.selectedSkillIds)
    || !exactEmptyArray(parameters.selectedSubjectIds)
    || parameters.directorPlan !== null
    || parameters.materializedProject !== null
    || !exactEmptyArray(parameters.generatedImageAssets)
    || !exactEmptyArray(parameters.uploadedAttachments)
  ) return fail("QUICK_CREATE_EMPTY_DRAFT_PARAMETERS_INVALID");
  return parameters;
}

export type QuickCreateEmptyDraftMatch = Readonly<{
  canonicalBody: string;
  canonicalDraft: string;
  bodyContractBinding: string;
  bodyInstanceBinding: string;
  capturedDraftBinding: string;
}>;

export type QuickCreateEmptyDraftMatcher = Readonly<{
  match: (
    contract: QuickCreateEmptyDraftBodyContract,
    body: unknown,
  ) => QuickCreateEmptyDraftMatch;
}>;

export function createQuickCreateEmptyDraftMatcher(): QuickCreateEmptyDraftMatcher {
  const captured = new Map<string, Readonly<{
    profileBinding: string;
    canonicalDraft: string;
    capturedDraftBinding: string;
  }>>();
  return Object.freeze({
    match: (contract, value) => {
      assertQuickCreateEmptyDraftBodyContract(contract);
      const body = parseRecord(value);
      if (!exactKeys(body, [
        "expectedVersion",
        "goal",
        "mode",
        "parameters",
        "selectedAssetVersionIds",
      ])) return fail("QUICK_CREATE_EMPTY_DRAFT_BODY_INVALID");
      if (
        body.expectedVersion !== contract.expectedVersion
        || body.goal !== contract.fixedGoal
        || body.mode !== "quick_create"
        || !exactEmptyArray(body.selectedAssetVersionIds)
      ) return fail("QUICK_CREATE_EMPTY_DRAFT_BODY_INVALID");
      const parameters = validateParameters(contract, body.parameters);
      const draft = {
        goal: body.goal,
        mode: body.mode,
        parameters,
        selectedAssetVersionIds: body.selectedAssetVersionIds,
      };
      const canonicalBody = canonicalJson(body);
      const canonicalDraft = canonicalJson(draft);
      const profileBinding = quickCreateEmptyDraftProfileBinding(contract);
      const capturedDraftBinding = binding(`${contract.kind}/captured-draft`, {
        templateId: contract.templateId,
        canonicalDraft,
      });
      const previous = captured.get(contract.templateId);
      if (previous && previous.profileBinding !== profileBinding) {
        return fail("QUICK_CREATE_EMPTY_DRAFT_PROFILE_MISMATCH");
      }
      if (contract.expectedVersion === contract.initialVersion) {
        if (!previous) {
          captured.set(contract.templateId, Object.freeze({
            profileBinding,
            canonicalDraft,
            capturedDraftBinding,
          }));
        } else if (previous.canonicalDraft !== canonicalDraft) {
          return fail("QUICK_CREATE_EMPTY_DRAFT_CAPTURE_MISMATCH");
        }
      } else if (!previous) {
        return fail("QUICK_CREATE_EMPTY_DRAFT_RETRY_BEFORE_CAPTURE");
      } else if (previous.canonicalDraft !== canonicalDraft) {
        return fail("QUICK_CREATE_EMPTY_DRAFT_CAPTURE_MISMATCH");
      }
      return Object.freeze({
        canonicalBody,
        canonicalDraft,
        bodyContractBinding: quickCreateEmptyDraftBodyContractBinding(contract),
        bodyInstanceBinding: binding(`${contract.kind}/body-instance`, {
          contractBinding: quickCreateEmptyDraftBodyContractBinding(contract),
          canonicalBody,
        }),
        capturedDraftBinding,
      });
    },
  });
}
