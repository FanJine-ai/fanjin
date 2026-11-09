export type RelayProjectBindingErrorCode =
  | "project_id_required"
  | "invalid_project_id"
  | "project_id_conflict";

export class RelayProjectBindingError extends Error {
  readonly code: RelayProjectBindingErrorCode;
  readonly status = 400;
  readonly statusCode = 400;

  constructor(code: RelayProjectBindingErrorCode, message: string) {
    super(message);
    this.name = "RelayProjectBindingError";
    this.code = code;
  }
}

function readPositiveProjectId(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const projectId = Number(normalized);
  return Number.isSafeInteger(projectId) && projectId > 0 ? projectId : null;
}

function hasAliasValue(
  payload: Record<string, unknown>,
  key: "projectId" | "project_id",
): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key)
    && payload[key] !== undefined;
}

/**
 * Public video-generation APIs accept both naming conventions, but project
 * authority is always reduced to one canonical positive integer before it
 * reaches the Relay core. No default/system project is inferred here.
 */
export function resolveRequiredRelayProjectId(
  payload: Record<string, unknown>,
): number {
  const hasCamel = hasAliasValue(payload, "projectId");
  const hasSnake = hasAliasValue(payload, "project_id");
  if (!hasCamel && !hasSnake) {
    throw new RelayProjectBindingError(
      "project_id_required",
      "视频生成请求必须显式提供 projectId",
    );
  }

  const camel = hasCamel ? readPositiveProjectId(payload.projectId) : null;
  const snake = hasSnake ? readPositiveProjectId(payload.project_id) : null;
  if ((hasCamel && camel === null) || (hasSnake && snake === null)) {
    throw new RelayProjectBindingError(
      "invalid_project_id",
      "projectId 必须是正安全整数",
    );
  }
  if (camel !== null && snake !== null && camel !== snake) {
    throw new RelayProjectBindingError(
      "project_id_conflict",
      "projectId 与 project_id 不一致",
    );
  }
  return camel ?? snake!;
}

/** Project aliases are authorization context, never provider request payload. */
export function removeRelayProjectIdAliases<T extends Record<string, unknown>>(
  payload: T,
): T {
  const sanitized = { ...payload };
  delete sanitized.projectId;
  delete sanitized.project_id;
  return sanitized;
}
