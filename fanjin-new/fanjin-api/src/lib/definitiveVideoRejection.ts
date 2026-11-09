function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasReceipt(payload: Record<string, any>): boolean {
  return Boolean(payload.id || payload.task_id || payload.taskId || payload.providerTaskId
    || payload.usage || payload.output || payload.result || payload.video_url
    || payload.data != null);
}

/** Only unwrap the observed gateway error envelope, never arbitrary prose. */
function rejectionPayload(payload: unknown): Record<string, any> | null {
  if (!object(payload) || hasReceipt(payload)) return null;
  if (object(payload.error)) return payload;
  if (payload.code !== "fail_to_fetch_task" || payload.data !== null
    || typeof payload.message !== "string" || payload.message.length > 16_384) return null;
  try {
    const nested = JSON.parse(payload.message);
    return object(nested) && object(nested.error) && !hasReceipt(nested) ? nested : null;
  } catch { return null; }
}

/**
 * Ark rejects this input before creating a task. Do not infer this from HTTP
 * status alone: the response must also prove no provider task, no usage and
 * no output were created.
 */
export function isDefinitiveVideoRejection(input: { provider: unknown; httpStatus: unknown; response: any; providerTaskId?: unknown }): boolean {
  const payload = rejectionPayload(input.response);
  if (input.provider !== "volcano") return false;
  if (Number(input.httpStatus) !== 400) return false;
  if (input.providerTaskId) return false;
  if (!payload) return false;

  const error = payload.error;
  if (!error || typeof error !== "object") return false;
  const code = String(error.code || "");
  const type = String(error.type || "");
  const message = String(error.message || payload.message || "");

  // Existing privacy rejection contract.
  if (type === "BadRequest" && /^Input(Image|Video)SensitiveContentDetected\.PrivacyInformation$/.test(code)) return true;

  // Client request shape errors: provider never created a billable task.
  if (/^(InvalidParameter|MissingParameter)(?:[._:]|$)/i.test(code)) return true;
  if (/parameter .* is not valid|not a valid|invalid parameter|parameter error/i.test(message)) return true;
  return false;
}
