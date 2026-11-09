import { apiGet, apiPost, apiPut, type ApiRequestOptions } from "../../../api/http";

export type CreationSessionMode = "agent" | "quick_create" | "canvas";

export type CreationSessionDto = {
  id: string;
  projectId: number;
  goal: string;
  mode: CreationSessionMode;
  inputs: unknown[];
  parameters: Record<string, unknown>;
  selectedAssetVersionIds: string[];
  canvasId: string | null;
  status: "active" | "archived";
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type CreationSessionUpdatePayload = {
  expectedVersion: number;
  goal?: string;
  mode?: CreationSessionMode;
  inputs?: unknown[];
  parameters?: Record<string, unknown>;
  selectedAssetVersionIds?: string[];
  canvasId?: string | null;
};

export type CreationSessionPatch = Omit<CreationSessionUpdatePayload, "expectedVersion">;

export type EnsureCreationSessionPayload = CreationSessionPatch;

type EnsureCreationSessionResponse = {
  session: CreationSessionDto;
  created: boolean;
};

/**
 * 获取项目当前的 CreationSession。
 * 如果该项目从未创建过 Session，返回 null。
 */
export async function getCurrentCreationSession(projectId: number): Promise<CreationSessionDto | null> {
  return apiGet<CreationSessionDto | null>(
    `/projects/${projectId}/creationSessions/current`,
  );
}

/**
 * Return the current project Session, creating a Quick Create Session when the
 * project does not have one yet. Project/workspace authorization is enforced
 * by the server.
 */
export async function ensureCurrentCreationSession(
  projectId: number,
  payload: EnsureCreationSessionPayload = { mode: "quick_create" },
): Promise<CreationSessionDto> {
  const result = await apiPost<EnsureCreationSessionResponse, EnsureCreationSessionPayload>(
    `/projects/${projectId}/creationSessions/current`,
    payload,
  );
  return result.session;
}

/**
 * 更新 CreationSession（乐观并发控制）。
 * 如果 version 冲突，后端返回 409。
 */
export async function updateCreationSession(
  projectId: number,
  sessionId: string,
  payload: CreationSessionUpdatePayload,
  options?: ApiRequestOptions,
): Promise<CreationSessionDto> {
  return apiPut<CreationSessionDto, CreationSessionUpdatePayload>(
    `/projects/${projectId}/creationSessions/${sessionId}`,
    payload,
    undefined,
    options,
  );
}
