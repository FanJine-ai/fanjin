import { z } from "zod";

export const analyticsFilterSchema = z.object({
  scope: z.enum(["workspace", "account"]).default("workspace"),
  workspaceId: z.string().trim().min(1).max(128).optional(),
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().positive().optional(),
  projectId: z.number().int().positive().optional(),
  memberId: z.number().int().positive().optional(),
  apiKeyId: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(200).optional(),
  source: z.enum(["web", "api", "mcp", "cli", "unknown"]).optional(),
  executionStatus: z.enum(["succeeded", "failed", "cancelled", "expired", "queued", "running", "unknown", "unsuccessful", "unfinished"]).optional(),
  failureCategory: z.enum(["policy", "invalid_input", "rate_limit", "timeout", "upstream", "cancelled", "expired", "unknown"]).optional(),
  status: z.string().min(1).max(50).optional(),
  query: z.string().trim().max(128).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(4096).optional(),
}).strict();
export type AnalyticsFilter = z.infer<typeof analyticsFilterSchema>;
export const analyticsActions = ["balance", "summary", "usage", "usage-detail", "ledger", "ledger-detail", "export", "export-create", "export-jobs", "export-status", "export-cancel", "export-part"] as const;
export type AnalyticsAction = typeof analyticsActions[number];
export const analyticsInputSchema = analyticsFilterSchema.extend({
  id: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
  part: z.number().int().nonnegative().optional(),
  kind: z.enum(["usage", "ledger"]).optional(),
  format: z.enum(["csv", "json"]).default("csv"),
}).strict();
export type AnalyticsInput = z.infer<typeof analyticsInputSchema>;
export class AnalyticsError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
