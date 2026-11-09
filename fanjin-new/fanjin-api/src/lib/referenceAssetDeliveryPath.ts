const MULTIPART_SESSION_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/source\.(?:jpg|png|gif|webp|mp4|webm|mov|mp3|wav|m4a)$/iu;

export function isReferenceAssetDeliveryPath(input: {
  filePath: unknown;
  projectId: unknown;
  workspaceId: unknown;
}): boolean {
  const filePath = String(input.filePath || "").replace(/\\/g, "/");
  const projectId = Number(input.projectId);
  const workspaceId = String(input.workspaceId || "").trim();
  if (!filePath || !Number.isSafeInteger(projectId) || projectId <= 0 || !workspaceId) {
    return false;
  }

  const legacyPrefix = `/${projectId}/assets/references/`;
  if (filePath.startsWith(legacyPrefix)) {
    const suffix = filePath.slice(legacyPrefix.length);
    return Boolean(suffix) && !suffix.includes("/");
  }

  const multipartPrefix = `/workspaces/${encodeURIComponent(workspaceId)}/projects/${projectId}/references/`;
  return filePath.startsWith(multipartPrefix)
    && MULTIPART_SESSION_PATH.test(filePath.slice(multipartPrefix.length));
}
