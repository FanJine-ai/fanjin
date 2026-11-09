/**
 * Side-effect-free projection of the PostgreSQL objects installed by v39.
 * Keep this module independent from the database singleton so the migration
 * registry can import it during process bootstrap.
 */
const nativeServiceRequestLifecycleCheck =
  "CHECK (NOT (COALESCE(\"contractVersion\" = 'service-request.v1'::text, false) OR COALESCE(\"compatibilityStatus\" = 'native_v1'::text, false)) OR \"contractVersion\" = 'service-request.v1'::text AND \"compatibilityStatus\" = 'native_v1'::text AND type IS NOT NULL AND status IS NOT NULL AND decision IS NOT NULL AND \"financeState\" IS NOT NULL AND revision IS NOT NULL AND revision >= 0 AND revision <= '9007199254740991'::bigint AND \"submittedByUserId\" IS NOT NULL AND \"submittedByUserId\" > 0 AND \"submittedByUserId\" <= '9007199254740991'::bigint AND (type = ANY (ARRAY['invoice'::text, 'offline_payment'::text, 'credit_limit'::text])) AND (decision = 'pending'::text AND \"financeState\" = 'not_started'::text AND status = 'pending'::text AND \"financeResult\" IS NULL AND \"reviewedByUserId\" IS NULL AND \"reviewEvidenceId\" IS NULL AND \"reviewedAt\" IS NULL AND \"reviewNote\" IS NULL OR decision = 'approved'::text AND (\"financeState\" = ANY (ARRAY['not_started'::text, 'processing'::text, 'failed_retryable'::text, 'manual_required'::text])) AND status = 'pending'::text AND \"financeResult\" IS NULL AND \"reviewedByUserId\" IS NOT NULL AND \"reviewedByUserId\" > 0 AND \"reviewedByUserId\" <= '9007199254740991'::bigint AND \"reviewEvidenceId\" IS NOT NULL AND btrim(\"reviewEvidenceId\") <> ''::text AND \"reviewedAt\" IS NOT NULL AND \"reviewedAt\" > 0 AND \"reviewedAt\" <= '9007199254740991'::bigint AND \"reviewNote\" IS NULL OR decision = 'approved'::text AND \"financeState\" = 'succeeded'::text AND (type = 'invoice'::text AND status = 'issued'::text OR type <> 'invoice'::text AND status = 'approved'::text) AND \"financeResult\" IS NOT NULL AND \"reviewedByUserId\" IS NOT NULL AND \"reviewedByUserId\" > 0 AND \"reviewedByUserId\" <= '9007199254740991'::bigint AND \"reviewEvidenceId\" IS NOT NULL AND btrim(\"reviewEvidenceId\") <> ''::text AND \"reviewedAt\" IS NOT NULL AND \"reviewedAt\" > 0 AND \"reviewedAt\" <= '9007199254740991'::bigint AND \"reviewNote\" IS NULL OR decision = 'rejected'::text AND \"financeState\" = 'not_applicable'::text AND status = 'rejected'::text AND \"financeResult\" IS NULL AND \"reviewedByUserId\" IS NOT NULL AND \"reviewedByUserId\" > 0 AND \"reviewedByUserId\" <= '9007199254740991'::bigint AND \"reviewEvidenceId\" IS NOT NULL AND btrim(\"reviewEvidenceId\") <> ''::text AND \"reviewedAt\" IS NOT NULL AND \"reviewedAt\" > 0 AND \"reviewedAt\" <= '9007199254740991'::bigint AND \"reviewNote\" IS NOT NULL AND btrim(\"reviewNote\") <> ''::text OR decision = 'cancelled'::text AND \"financeState\" = 'not_applicable'::text AND status = 'cancelled'::text AND \"financeResult\" IS NULL AND \"reviewedByUserId\" IS NOT NULL AND \"reviewedByUserId\" > 0 AND \"reviewedByUserId\" <= '9007199254740991'::bigint AND \"reviewEvidenceId\" IS NOT NULL AND btrim(\"reviewEvidenceId\") <> ''::text AND \"reviewedAt\" IS NOT NULL AND \"reviewedAt\" > 0 AND \"reviewedAt\" <= '9007199254740991'::bigint AND \"reviewNote\" IS NOT NULL AND btrim(\"reviewNote\") <> ''::text))";

export const SERVICE_REQUEST_V1_RUNTIME_INDEXES = [
  {
    name: "uq_billing_service_request_command_operation_idempotency",
    table: "o_billing_service_request_command",
    unique: true,
    columns: ["operation", "idempotencyKey"],
    predicate: null,
  },
  {
    name: "uq_billing_finance_intent_operation_idempotency",
    table: "o_billing_finance_intent",
    unique: true,
    columns: ["operation", "idempotencyKey"],
    predicate: null,
  },
  {
    name: "uq_billing_finance_intent_request",
    table: "o_billing_finance_intent",
    unique: true,
    columns: ["requestId"],
    predicate: null,
  },
  {
    name: "uq_billing_watchdog_lease_request",
    table: "o_billing_watchdog_lease",
    unique: true,
    columns: ["requestId"],
    predicate: null,
  },
  {
    name: "idx_billing_outbox_status_available",
    table: "o_billing_outbox",
    unique: false,
    columns: ["status", "availableAt"],
    predicate: null,
  },
  {
    name: "idx_billing_service_request_workspace_revision",
    table: "o_billing_service_request",
    unique: false,
    columns: ["workspaceId", "revision"],
    predicate: null,
  },
  {
    name: "idx_o_account_wallet_ledger_idempotency",
    table: "o_account_wallet_ledger",
    unique: true,
    columns: ["userId", "type", "idempotencyKey"],
    predicate: "\"idempotencyKey\" IS NOT NULL",
  },
  {
    name: "idx_o_account_wallet_user",
    table: "o_account_wallet",
    unique: true,
    columns: ["userId"],
    predicate: null,
  },
  {
    name: "idx_o_billing_account_workspace",
    table: "o_billing_account",
    unique: true,
    columns: ["workspaceId"],
    predicate: null,
  },
  {
    name: "idx_o_billing_ledger_idempotency",
    table: "o_billing_ledger",
    unique: true,
    columns: ["workspaceId", "type", "idempotencyKey"],
    predicate: "\"idempotencyKey\" IS NOT NULL",
  },
  {
    name: "idx_o_finance_income_idempotency",
    table: "o_finance_income_record",
    unique: true,
    columns: ["idempotencyKey"],
    predicate: "\"idempotencyKey\" IS NOT NULL",
  },
] as const;

export const SERVICE_REQUEST_V1_RUNTIME_CHECKS = [
  {
    name: "ck_billing_service_request_native_lifecycle",
    table: "o_billing_service_request",
    definition: nativeServiceRequestLifecycleCheck,
  },
  {
    name: "ck_billing_finance_intent_terminal_result",
    table: "o_billing_finance_intent",
    definition:
      "CHECK (status IS NOT NULL AND COALESCE(status = 'succeeded'::text AND \"financeResult\" IS NOT NULL AND \"errorMessage\" IS NULL OR (status = ANY (ARRAY['manual_required'::text, 'failed_retryable'::text])) AND \"financeResult\" IS NULL AND \"errorMessage\" IS NOT NULL OR (status = ANY (ARRAY['persisted'::text, 'processing'::text])) AND \"financeResult\" IS NULL AND \"errorMessage\" IS NULL, false))",
  },
] as const;
