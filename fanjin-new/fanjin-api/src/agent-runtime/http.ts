import type { Response } from "express";
import { AgentRuntimeError, isAgentRuntimeError } from "@/agent-runtime/errors";
import { IdempotencyConflictError } from "@/agent-runtime/idempotency";

export function agentSuccess<T>(data: T) {
  return { code: "ok" as const, data };
}

export function sendAgentRuntimeError(res: Response, error: unknown) {
  if (isAgentRuntimeError(error)) {
    return res.status(error.status).send({
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  if (error instanceof IdempotencyConflictError) {
    return res.status(409).send({ code: "idempotency_conflict", message: error.message });
  }
  throw error;
}

export function requireResource<T>(value: T | null, code: string, message: string): T {
  if (value == null) throw new AgentRuntimeError(404, code, message);
  return value;
}
