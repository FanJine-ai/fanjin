import type { Knex } from "knex";
import { AGENT_APPROVAL_TABLE } from "@/lib/migrations/agentApprovalDelegation";

export const AGENT_APPROVAL_ARGUMENTS_SUMMARY_COLUMN = "argumentsSummary";

/**
 * Persists a sanitized scalar projection of the proposed tool arguments so the
 * browser-safe approval DTO can echo the proposal on the editable confirmation
 * card (REVAMP-PLAN 1.2-6). Display-only: the argumentsHash/scopeHash pair
 * remains the authoritative action binding. Rows created before this migration
 * keep NULL, which the DTO projects as a missing summary.
 */
export async function upAgentApprovalArgumentsSummary(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(AGENT_APPROVAL_TABLE))) return;
  if (await trx.schema.hasColumn(AGENT_APPROVAL_TABLE, AGENT_APPROVAL_ARGUMENTS_SUMMARY_COLUMN)) return;
  await trx.schema.alterTable(AGENT_APPROVAL_TABLE, (table) => {
    table.text(AGENT_APPROVAL_ARGUMENTS_SUMMARY_COLUMN);
  });
}

export async function downAgentApprovalArgumentsSummary(): Promise<void> {
  // Dropping the column could race a live decide-with-revision write. Keep the
  // nullable column permanently instead of offering a lossy downgrade path.
  throw new Error(
    "Migration agent_approval_arguments_summary cannot be rolled back safely because proposal echo data is part of the approval record.",
  );
}
