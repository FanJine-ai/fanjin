export type LoadedCanvasIdentity = {
  canvasId: string;
  projectId: string;
  revision: number;
};

export function readLoadedCanvasIdentity(
  result: any,
  fallbackCanvasId: string,
  requestedProjectId: unknown,
  positiveProjectId: (value: unknown) => string | null,
  positiveRevision: (value: unknown) => number | null,
): LoadedCanvasIdentity {
  const canvasId = String(result?.canvasId || fallbackCanvasId || "").trim();
  const projectId = positiveProjectId(result?.projectId);
  const revision = positiveRevision(result?.revision);
  if (!canvasId || !projectId || revision === null) {
    throw new Error("画布缺少项目或版本信息，已阻止进入编辑状态");
  }
  const requested = positiveProjectId(requestedProjectId);
  if (requested && requested !== projectId) {
    throw new Error("画布与当前项目不匹配，请从项目列表重新打开");
  }
  return { canvasId, projectId, revision };
}
