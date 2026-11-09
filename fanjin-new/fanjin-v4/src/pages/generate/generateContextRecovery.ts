import type { Asset } from "../../api/types";
import { BYTEPLUS_SEEDANCE_25_MODEL_ID } from "../../features/quick-create/videoOutputContract";
import type {
  AgentMessageContextSnapshot,
  AgentMessageContextSnapshotInput,
  AgentMessageContextUsage,
  AgentMessageGenerationPreferences,
} from "../../features/agent-runtime/types";
import type {
  QuickCreateDirectorPlan,
  QuickCreateImageAsset,
  QuickCreateMaterializedProject,
  QuickCreateSessionParameters,
} from "../../features/quick-create/types";
import type {
  StudioContextAsset,
  StudioContextReference,
  StudioContextSkill,
  StudioContextStyle,
} from "../../components/project-studio";
import { agentReferenceDisplayKind } from "./generateCatalog";
import { getAssetTypeLabel } from "./generatePresentation";

export const AGENT_SKILL_SELECTION_LIMIT = 5;

export type AgentSkill = {
  id: string;
  key: string;
  version: string;
  name: string;
  description: string;
  category?: string;
  provider?: "fanjin" | "jimeng";
  author?: string | null;
  source: "official";
};

export type RestorableAgentContextMessage = {
  role: string;
  runId?: string | null;
  contextSnapshot?: AgentMessageContextSnapshot | null;
  contextUsage?: AgentMessageContextUsage | null;
};

export type RestoredAgentContext = {
  assets: StudioContextAsset[];
  skills: StudioContextSkill[];
  styles: StudioContextStyle[];
  references: StudioContextReference[];
};

export type QuickSessionContextSource = {
  parameters?: Record<string, unknown> | Partial<QuickCreateSessionParameters> | null;
  selectedAssetVersionIds?: readonly string[] | null;
  projectAssets?: readonly Asset[];
  officialSkills?: readonly AgentSkill[];
};

export type RestoredQuickSessionContext = RestoredAgentContext & { canonicalSkills: AgentSkill[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueContextItemsByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const keys = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (!key || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function isPersistentPreviewUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return Boolean(normalized) && !/^(?:blob|data):/i.test(normalized);
}

function isRestorableDirectorPlan(value: unknown): value is QuickCreateDirectorPlan {
  if (!isRecord(value)) return false;
  return typeof value.title === "string"
    && typeof value.simpleScript === "string"
    && typeof value.stylePrompt === "string"
    && typeof value.ratio === "string"
    && /^\d{1,3}:\d{1,3}$/.test(value.ratio)
    && typeof value.duration === "number"
    && Number.isFinite(value.duration)
    && Array.isArray(value.shots);
}

function isRestorableMaterializedProject(value: unknown): value is QuickCreateMaterializedProject {
  if (!isRecord(value) || !isRecord(value.project) || !isRecord(value.script)) return false;
  return Number.isSafeInteger(Number(value.project.id))
    && Number(value.project.id) > 0
    && Number.isSafeInteger(Number(value.script.id))
    && Number(value.script.id) > 0
    && Array.isArray(value.shots);
}

function restorableGeneratedImageAssets(value: unknown): QuickCreateImageAsset[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is QuickCreateImageAsset => (
    isRecord(item)
    && typeof item.id === "string"
    && Boolean(item.id.trim())
    && typeof item.taskId === "string"
    && Boolean(item.taskId.trim())
    && isPersistentPreviewUrl(item.url)
    && typeof item.assetType === "string"
    && Boolean(item.assetType.trim())
  ));
}

export function restoreUtilityGenerationSession(parameters: unknown) {
  const source = isRecord(parameters) ? parameters : {};
  return {
    plan: isRestorableDirectorPlan(source.directorPlan) ? source.directorPlan : null,
    materialized: isRestorableMaterializedProject(source.materializedProject)
      ? source.materializedProject
      : null,
    imageAssets: restorableGeneratedImageAssets(source.generatedImageAssets),
  };
}

function sessionReferenceKind(type: string, mimeType: string) {
  const normalized = `${type} ${mimeType}`.toLowerCase();
  if (normalized.includes("image")) return "图片";
  if (normalized.includes("video")) return "视频";
  if (normalized.includes("audio")) return "音频";
  return "文件";
}

export function contextStyleName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizedContextName(value: string) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

export function matchQuickSessionCanonicalSkills(
  titles: readonly string[],
  officialSkills: readonly AgentSkill[],
): AgentSkill[] {
  const matches: AgentSkill[] = [];
  const seen = new Set<string>();
  for (const title of titles) {
    const normalized = normalizedContextName(title);
    const candidates = officialSkills.filter((skill) => normalizedContextName(skill.name) === normalized);
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    const canonicalId = `${candidate.key}@${candidate.version}`;
    if (seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    matches.push(candidate);
  }
  return matches;
}

export function restoreQuickSessionContext({
  parameters,
  selectedAssetVersionIds = [],
  projectAssets = [],
  officialSkills = [],
}: QuickSessionContextSource): RestoredQuickSessionContext {
  const params = isRecord(parameters) ? parameters : {};
  const selectedSubjectIds = new Set(stringList(params.selectedSubjectIds));
  const selectedVersions = new Set(stringList(selectedAssetVersionIds));
  const styleName = contextStyleName(params.style);

  const assets = projectAssets
    .filter((asset) => selectedSubjectIds.has(`asset-${asset.id}`))
    .map((asset) => ({
      id: `session-asset-${asset.id}`,
      assetId: asset.id,
      name: asset.name || `资产 ${asset.id}`,
      thumbnailUrl: asset.src || asset.sonAssets?.find((item) => item.src)?.src || null,
      kind: getAssetTypeLabel(asset.type),
    }));

  const canonicalSkills = matchQuickSessionCanonicalSkills(
    stringList(params.selectedSkillIds),
    officialSkills,
  );
  const skills = canonicalSkills.map((skill) => ({
    id: `session-skill-${skill.key}@${skill.version}`,
    name: skill.name,
    source: "快速模式草稿",
  }));

  const references = (Array.isArray(params.uploadedAttachments) ? params.uploadedAttachments : [])
    .filter(isRecord)
    .flatMap((attachment, index): StudioContextReference[] => {
      const assetId = Number(attachment.assetId);
      const assetVersionId = String(attachment.assetVersionId ?? "").trim();
      const name = typeof attachment.name === "string" ? attachment.name.trim() : "";
      const filePath = typeof attachment.filePath === "string" ? attachment.filePath.trim() : "";
      const previewUrl = isPersistentPreviewUrl(attachment.previewUrl) ? attachment.previewUrl.trim() : "";
      const type = typeof attachment.type === "string" ? attachment.type.trim() : "";
      const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
      if (
        !Number.isSafeInteger(assetId)
        || assetId <= 0
        || !/^[1-9]\d*$/.test(assetVersionId)
        || !selectedVersions.has(assetVersionId)
        || !name
        || !filePath
        || !previewUrl
      ) return [];
      return [{
        id: `session-reference-${assetVersionId}-${index}`,
        assetId,
        assetVersionId,
        name,
        thumbnailUrl: previewUrl,
        kind: sessionReferenceKind(type, mimeType),
      }];
    });

  return {
    assets: uniqueContextItemsByKey(assets, (asset) => String(asset.assetId)),
    skills,
    styles: styleName ? [{ id: "session-style", name: styleName, source: "快速模式草稿" }] : [],
    references: uniqueContextItemsByKey(references, (reference) => String(reference.assetVersionId)),
    canonicalSkills,
  };
}

function isSnapshotAsset(value: unknown) {
  return isRecord(value)
    && Number.isSafeInteger(value.assetId)
    && Number(value.assetId) > 0
    && (value.assetVersionId === null
      || (typeof value.assetVersionId === "string" && /^[1-9]\d*$/.test(value.assetVersionId)))
    && typeof value.name === "string"
    && Boolean(value.name.trim())
    && (value.kind === null || typeof value.kind === "string");
}

function isSnapshotReference(value: unknown) {
  return isRecord(value)
    && typeof value.assetVersionId === "string"
    && /^[1-9]\d*$/.test(value.assetVersionId)
    && Number.isSafeInteger(value.assetId)
    && Number(value.assetId) > 0
    && typeof value.name === "string"
    && Boolean(value.name.trim())
    && (value.kind === null || typeof value.kind === "string");
}

function isSnapshotSkill(value: unknown) {
  return isRecord(value)
    && typeof value.key === "string"
    && Boolean(value.key.trim())
    && typeof value.version === "string"
    && Boolean(value.version.trim())
    && typeof value.displayName === "string"
    && Boolean(value.displayName.trim());
}

function isGenerationPreferences(value: unknown): value is AgentMessageGenerationPreferences {
  if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim()) return false;
  if (typeof value.ratio !== "string" || !(/^\d{1,3}:\d{1,3}$/.test(value.ratio)
    || value.generationType === "video" && value.model === BYTEPLUS_SEEDANCE_25_MODEL_ID && value.ratio === "adaptive")) return false;
  if (value.generationType === "image") {
    return typeof value.quality === "string"
      && Boolean(value.quality.trim())
      && Number.isSafeInteger(value.count)
      && Number(value.count) > 0;
  }
  return value.generationType === "video"
    && typeof value.resolution === "string"
    && Boolean(value.resolution.trim())
    && typeof value.mode === "string"
    && Boolean(value.mode.trim())
    && typeof value.duration === "number"
    && Number.isFinite(value.duration)
    && (value.duration > 0 || value.model === BYTEPLUS_SEEDANCE_25_MODEL_ID && value.duration === -1)
    && typeof value.generateAudio === "boolean"
    && (value.outputFormat === undefined || value.outputFormat === "mp4" || value.outputFormat === "mov");
}

export function isConfirmedAgentContextSnapshot(value: unknown): value is AgentMessageContextSnapshot {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && value.status === "confirmed"
    && typeof value.digest === "string"
    && /^[a-f0-9]{64}$/.test(value.digest)
    && Array.isArray(value.assets)
    && value.assets.every(isSnapshotAsset)
    && Array.isArray(value.attachments)
    && value.attachments.every(isSnapshotReference)
    && Array.isArray(value.references)
    && value.references.every(isSnapshotReference)
    && Array.isArray(value.skills)
    && value.skills.every(isSnapshotSkill)
    && (value.style === null || typeof value.style === "string")
    && (value.generationPreferences === undefined || isGenerationPreferences(value.generationPreferences));
}

export function isAgentMessageContextUsage(value: unknown): value is AgentMessageContextUsage {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.status === "used"
    && typeof value.digest === "string"
    && /^[a-f0-9]{64}$/.test(value.digest);
}

function emptyRestoredAgentContext(): RestoredAgentContext {
  return { assets: [], skills: [], styles: [], references: [] };
}

function restoreAgentContextSnapshot(snapshot: AgentMessageContextSnapshot): RestoredAgentContext {
  const assetIds = new Set<number>();
  const assets = snapshot.assets.flatMap((asset) => {
    if (assetIds.has(asset.assetId)) return [];
    assetIds.add(asset.assetId);
    return [{
      id: `confirmed-asset-${asset.assetId}`,
      assetId: asset.assetId,
      assetVersionId: asset.assetVersionId,
      name: asset.name,
      kind: asset.kind || undefined,
    }];
  });
  const skillIds = new Set<string>();
  const skills = snapshot.skills.flatMap((skill) => {
    const id = `${skill.key}@${skill.version}`;
    if (skillIds.has(id)) return [];
    skillIds.add(id);
    return [{ id: `confirmed-skill-${id}`, name: skill.displayName, source: "服务端已确认" }];
  });
  const referenceIds = new Set<string>();
  const references = [...snapshot.attachments, ...snapshot.references].flatMap((reference) => {
    if (referenceIds.has(reference.assetVersionId)) return [];
    referenceIds.add(reference.assetVersionId);
    return [{
      id: `confirmed-reference-${reference.assetVersionId}`,
      assetId: reference.assetId,
      assetVersionId: reference.assetVersionId,
      name: reference.name,
      kind: agentReferenceDisplayKind(reference.kind),
    }];
  });
  const styleName = snapshot.style?.trim() || "";
  return {
    assets,
    skills,
    styles: styleName
      ? [{ id: `confirmed-style-${snapshot.digest}`, name: styleName, source: "服务端已确认" }]
      : [],
    references,
  };
}

export function restoreLatestAgentContext(messages: readonly RestorableAgentContextMessage[]): RestoredAgentContext {
  const snapshot = [...messages].reverse().find((message) => (
    message.role === "user" && isConfirmedAgentContextSnapshot(message.contextSnapshot)
  ))?.contextSnapshot;
  if (!isConfirmedAgentContextSnapshot(snapshot)) return emptyRestoredAgentContext();
  return restoreAgentContextSnapshot(snapshot);
}

export function runtimeUsedSkillsForRun(
  messages: readonly RestorableAgentContextMessage[],
  runId: string | null | undefined,
): AgentMessageContextSnapshot["skills"] {
  if (!runId) return [];
  const usage = [...messages].reverse().find((message) => (
    message.role === "assistant"
    && message.runId === runId
    && isAgentMessageContextUsage(message.contextUsage)
  ))?.contextUsage;
  if (!isAgentMessageContextUsage(usage)) return [];
  const snapshot = [...messages].reverse().find((message) => (
    message.role === "user"
    && message.runId === runId
    && isConfirmedAgentContextSnapshot(message.contextSnapshot)
    && message.contextSnapshot.digest === usage.digest
  ))?.contextSnapshot;
  return isConfirmedAgentContextSnapshot(snapshot) ? snapshot.skills : [];
}

export function restoreAgentContextScopes(
  messages: readonly RestorableAgentContextMessage[],
): { confirmed: RestoredAgentContext; used: RestoredAgentContext } {
  const snapshots = messages.flatMap((message) => (
    message.role === "user" && isConfirmedAgentContextSnapshot(message.contextSnapshot)
      ? [message.contextSnapshot]
      : []
  ));
  const latestConfirmed = snapshots.at(-1) ?? null;
  const latestUsage = [...messages].reverse().find((message) => (
    message.role === "assistant" && isAgentMessageContextUsage(message.contextUsage)
  ))?.contextUsage;
  const usedSnapshot = isAgentMessageContextUsage(latestUsage)
    ? [...snapshots].reverse().find((snapshot) => snapshot.digest === latestUsage.digest) ?? null
    : null;
  return {
    confirmed: latestConfirmed && latestConfirmed.digest !== usedSnapshot?.digest
      ? restoreAgentContextSnapshot(latestConfirmed)
      : emptyRestoredAgentContext(),
    used: usedSnapshot ? restoreAgentContextSnapshot(usedSnapshot) : emptyRestoredAgentContext(),
  };
}

export function mergeAgentTurnSkills(
  selectedSkills: readonly AgentSkill[],
  sessionSkills: readonly AgentSkill[],
): AgentSkill[] {
  return uniqueContextItemsByKey(
    [...selectedSkills, ...sessionSkills],
    (skill) => `${skill.key}@${skill.version}`,
  ).slice(0, AGENT_SKILL_SELECTION_LIMIT);
}

export function buildAgentContextSnapshotInput(
  assets: readonly StudioContextAsset[],
  style: string | null,
  generationPreferences?: AgentMessageGenerationPreferences,
): AgentMessageContextSnapshotInput {
  const assetRefs = uniqueContextItemsByKey(
    assets.filter((asset) => Number.isSafeInteger(asset.assetId) && Number(asset.assetId) > 0),
    (asset) => String(asset.assetId),
  ).map((asset) => ({ assetId: Number(asset.assetId) }));
  const normalizedStyle = style?.trim() || null;
  return {
    assetRefs,
    style: normalizedStyle,
    ...(generationPreferences ? { generationPreferences } : {}),
  };
}

export function retainUnsubmittedAttachments<T extends { id: string }>(
  attachments: readonly T[],
  submittedLocalIds: readonly string[],
): T[] {
  const submitted = new Set(submittedLocalIds);
  return attachments.filter((attachment) => !submitted.has(attachment.id));
}
