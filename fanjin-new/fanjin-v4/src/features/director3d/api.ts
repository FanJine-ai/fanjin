import { apiPost } from "../../api/http";
import type {
  DirectorSceneV1,
  DirectorStoryboardOption,
} from "./directorScene";

export type DirectorSceneReadResponse = {
  data: unknown | null;
  updatedAt: number | null;
  digest: string | null;
  corrupted: boolean;
};

export type DirectorSceneSaveResponse = {
  accepted: boolean;
  reason?: "stale_snapshot";
  updatedAt: number;
  digest: string | null;
  boundStoryboardIds?: number[];
};

type ScriptRow = { id: number; name: string };
type StoryboardRow = {
  id?: number;
  prompt?: string;
  videoDesc?: string;
  trackId?: number;
};

function parseScripts(value: unknown): ScriptRow[] {
  if (!Array.isArray(value)) throw new Error("剧本列表响应格式无效");
  return value.map((entry) => {
    const source = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const id = Number(source?.id);
    const name = typeof source?.name === "string" ? source.name.trim() : "";
    if (!source || !Number.isSafeInteger(id) || id <= 0 || !name) {
      throw new Error("剧本列表包含无效记录");
    }
    return { id, name };
  });
}

function parseStoryboards(value: unknown, script: ScriptRow): DirectorStoryboardOption[] {
  if (!Array.isArray(value)) throw new Error(`剧本「${script.name}」的分镜响应格式无效`);
  return value.flatMap((entry) => {
    const source = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const storyboardId = Number(source?.id);
    const trackId = Number(source?.trackId);
    if (!source || !Number.isSafeInteger(storyboardId) || storyboardId <= 0
      || !Number.isSafeInteger(trackId) || trackId <= 0) {
      return [];
    }
    const row = source as StoryboardRow;
    return [{
      storyboardId,
      scriptId: script.id,
      trackId,
      scriptName: script.name,
      prompt: String(row.videoDesc || row.prompt || "").trim(),
    }];
  });
}

export async function getDirectorScene(
  projectId: number,
  signal?: AbortSignal,
): Promise<DirectorSceneReadResponse> {
  return apiPost<DirectorSceneReadResponse>(
    "/production/director/getScene",
    { projectId },
    undefined,
    { signal },
  );
}

export async function saveDirectorScene(
  projectId: number,
  data: DirectorSceneV1,
  idempotencyKey: string,
): Promise<DirectorSceneSaveResponse> {
  return apiPost<DirectorSceneSaveResponse>(
    "/production/director/saveScene",
    { projectId, data },
    undefined,
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
}

export async function listDirectorStoryboards(
  projectId: number,
  signal?: AbortSignal,
): Promise<DirectorStoryboardOption[]> {
  const scripts = parseScripts(await apiPost<unknown>(
    "/script/getScrptApi",
    { projectId, name: "" },
    undefined,
    { signal },
  ));
  const groups = await Promise.all(scripts.map(async (script) => {
    const response = await apiPost<unknown>(
      "/production/getStoryboardData",
      { projectId, scriptId: script.id },
      undefined,
      { signal },
    );
    return parseStoryboards(response, script);
  }));
  return groups.flat().sort((left, right) => (
    left.scriptId - right.scriptId || left.storyboardId - right.storyboardId
  ));
}
