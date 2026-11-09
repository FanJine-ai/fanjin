import type { Knex } from "knex";
import { AGENT_APPROVAL_TABLE } from "@/lib/migrations/agentApprovalDelegation";

export const AGENT_APPROVAL_CONSUMED_STEP_COLUMN = "consumedStepId";

/**
 * Persists the exact Tool Step that atomically consumed an Approval. Existing
 * consumed rows deliberately remain NULL: there is no safe way to infer the
 * historical execution Step, so exact replay must fail closed for those rows.
 */
export async function upAgentApprovalConsumedStep(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(AGENT_APPROVAL_TABLE))) return;
  if (await trx.schema.hasColumn(AGENT_APPROVAL_TABLE, AGENT_APPROVAL_CONSUMED_STEP_COLUMN)) return;
  await trx.schema.alterTable(AGENT_APPROVAL_TABLE, (table) => {
    table.text(AGENT_APPROVAL_CONSUMED_STEP_COLUMN);
  });
}

export async function downAgentApprovalConsumedStep(): Promise<void> {
  // This nullable column is backward-compatible with older application
  // binaries, while dropping it could race a live Approval consumption after
  // any pre-drop evidence check. Keep the audit binding permanently instead
  // of offering a lossy SELECT-then-DROP downgrade path.
  throw new Error(
    "Migration agent_approval_consumed_step cannot be rolled back safely because consumed Step bindings are security audit evidence.",
  );
}
