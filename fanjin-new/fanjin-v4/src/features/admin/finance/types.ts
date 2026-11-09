export type FinanceRecord = Record<string, any>;

export type FinanceTab = "accounts" | "ledger" | "cases" | "gifts";

export type AdjustmentOperation =
  | "recharge"
  | "deduct"
  | "refund"
  | "credit_increase"
  | "credit_limit"
  | "gift_grant";

export type FinanceCaseStatus = "pending" | "approved" | "rejected" | "issued" | "cancelled";

export interface FinanceOverview {
  account?: {
    total?: number;
    active?: number;
    availableMicros?: number | string;
    creditLimitMicros?: number | string;
  };
  cases?: { pending?: number; total?: number };
  income?: { todayCnyMicros?: number | string };
  ledger?: { todayCount?: number };
}

export interface PagePayload {
  items?: FinanceRecord[];
  data?: FinanceRecord[];
  total?: number;
}

export interface AdjustmentForm {
  workspaceId: string;
  operation: AdjustmentOperation;
  amount: string;
  description: string;
  incomeAmount: string;
  campaignName: string;
  giftExpiresAt: string;
}

export interface AccountRow {
  id: string;
  source: FinanceRecord;
  workspaceId: string;
  workspaceName: string;
  owner: string;
  available: string;
  balance: string;
  credit: string;
  reserved: string;
  billingMode: string;
  status: string;
}

export interface LedgerRow {
  id: string;
  workspace: string;
  type: string;
  direction: string;
  amount: string;
  balance: string;
  operator: string;
  description: string;
  time: string;
}

export interface FinanceCaseRow {
  id: string;
  source: FinanceRecord;
  caseNo: string;
  workspace: string;
  type: string;
  amount: string;
  amountCny: string;
  submittedBy: string;
  status: string;
  time: string;
}

export interface GiftGrantRow {
  id: string;
  source: FinanceRecord;
  userId: string;
  workspace: string;
  amount: string;
  remaining: string;
  campaign: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface FinanceQueryState<T> {
  loading: boolean;
  error: string;
  data: T;
  reload: () => Promise<void>;
}
