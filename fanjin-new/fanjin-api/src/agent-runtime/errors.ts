export class AgentRuntimeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AgentRuntimeError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isAgentRuntimeError(error: unknown): error is AgentRuntimeError {
  return error instanceof AgentRuntimeError;
}
