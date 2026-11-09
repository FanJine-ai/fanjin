// Projects API：兼容旧工作台 POST 列表和看板 canonical GET 列表。
import { apiGet, apiPost } from "./http";
import type { Project } from "./types";

type ProjectListPayload =
  | unknown[]
  | { projects?: unknown[]; data?: unknown[] }
  | null
  | undefined;

export type CreateProjectPayload = {
  projectType?: string;
  name: string;
  intro?: string;
  type?: string;
  artStyle?: string | null;
  directorManual?: string;
  videoRatio?: string;
  imageModel?: string;
  videoModel?: string;
  imageQuality?: string;
  mode?: string;
};

export type EditProjectPayload = CreateProjectPayload & {
  id: string | number;
};

function listPayloadItems(payload: ProjectListPayload): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.projects)) return payload.projects;
  return Array.isArray(payload.data) ? payload.data : [];
}

function projectIdValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(text);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : text;
}

function stringValue(value: unknown, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function timestampValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function imageQualityValue(value: unknown): Project["imageQuality"] {
  return value === "1K" || value === "2K" || value === "4K" ? value : "";
}

function correlationDigestValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

/** Normalize either legacy `id` records or canonical `projectId` records. */
export function normalizeProjectRecord(value: unknown): Project | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = projectIdValue(record.id ?? record.projectId);
  if (id === null) return null;
  const canonicalOnly = record.id === undefined && record.projectId !== undefined;
  const createdAt = timestampValue(record.createTime ?? record.createdAt);
  const updatedAt = timestampValue(record.updatedAt ?? record.updateTime ?? record.createdAt ?? record.createTime);
  const artStyle = record.artStyle === null
    ? null
    : stringValue(record.artStyle) || null;

  return {
    id,
    name: stringValue(record.name, "未命名项目"),
    intro: stringValue(record.intro),
    type: stringValue(record.type, canonicalOnly ? "画布项目" : ""),
    artStyle,
    videoRatio: stringValue(record.videoRatio, "16:9"),
    coverImageUrl: stringValue(record.coverImageUrl),
    createTime: createdAt,
    updatedAt,
    imageModel: stringValue(record.imageModel),
    videoModel: stringValue(record.videoModel),
    projectType: stringValue(record.projectType, canonicalOnly ? "canvas" : "script"),
    imageQuality: imageQualityValue(record.imageQuality),
    mode: stringValue(record.mode, canonicalOnly ? "canvas" : "text"),
    directorManual: stringValue(record.directorManual),
    correlationDigest: correlationDigestValue(record.correlationDigest),
  };
}

function projectKey(project: Project) {
  return String(project.id).trim();
}

function mergeProjectLists(legacyValues: unknown[], canonicalValues: unknown[]) {
  const canonicalProjects = canonicalValues
    .map(normalizeProjectRecord)
    .filter((project): project is Project => project !== null);
  const legacyProjects = legacyValues
    .map(normalizeProjectRecord)
    .filter((project): project is Project => project !== null);
  const merged = new Map<string, Project>();

  for (const project of canonicalProjects) merged.set(projectKey(project), project);
  for (const legacy of legacyProjects) {
    const canonical = merged.get(projectKey(legacy));
    if (!canonical) {
      merged.set(projectKey(legacy), legacy);
      continue;
    }
    merged.set(projectKey(legacy), {
      ...canonical,
      ...legacy,
      // Legacy carries the rich quick-mode fields; canonical contributes the
      // canvas cover and can have the newest timestamp.
      name: canonical.name !== "未命名项目" ? canonical.name : legacy.name,
      coverImageUrl: legacy.coverImageUrl || canonical.coverImageUrl,
      createTime: legacy.createTime ?? canonical.createTime,
      updatedAt: Math.max(legacy.updatedAt ?? 0, canonical.updatedAt ?? 0) || undefined,
    });
  }

  return [...merged.values()].sort(
    (left, right) => (right.updatedAt ?? right.createTime ?? 0) - (left.updatedAt ?? left.createTime ?? 0),
  );
}

/**
 * Unified project list. Either endpoint may be absent during a rolling deploy;
 * one successful source is enough, while duplicate database projects collapse
 * to the legacy-rich representation used by the six quick-mode workbenches.
 */
export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const [legacyResult, canonicalResult] = await Promise.allSettled([
    apiGet<ProjectListPayload>("/project/getProject", undefined, { signal }),
    apiGet<ProjectListPayload>("/projects", undefined, { signal }),
  ]);
  if (legacyResult.status === "rejected" && canonicalResult.status === "rejected") {
    throw legacyResult.reason;
  }
  return mergeProjectLists(
    legacyResult.status === "fulfilled" ? listPayloadItems(legacyResult.value) : [],
    canonicalResult.status === "fulfilled" ? listPayloadItems(canonicalResult.value) : [],
  );
}

/** POST /general/getSingleProject → Project。 */
export async function getProject(id: string | number): Promise<Project> {
  const result = await apiPost<Project[] | Project, { id: number }>("/general/getSingleProject", { id: Number(id) });
  return Array.isArray(result) ? result[0] : result;
}

/** POST /project/addProject → Project。 */
export function addProject(payload: CreateProjectPayload): Promise<Project> {
  return apiPost<Project, CreateProjectPayload>("/project/addProject", payload);
}

/** POST /project/editProject。 */
export function editProject(payload: EditProjectPayload): Promise<unknown> {
  return apiPost<unknown, EditProjectPayload>("/project/editProject", payload);
}

/** POST /project/delProject。 */
export function deleteProject(id: string | number): Promise<unknown> {
  return apiPost<unknown, { id: string | number }>("/project/delProject", { id });
}
