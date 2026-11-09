export type ServiceRequestType = "invoice" | "credit_limit" | "offline_payment";
export type ServiceRequestStatus = "pending" | "approved" | "rejected" | "issued" | "cancelled";

export interface ServiceRequestRecord {
  id: string;
  workspaceId: string;
  sellerTenantId: string;
  type: ServiceRequestType;
  status: ServiceRequestStatus;
  amountMicros: number;
  currency: string;
  subjectName: string | null;
  taxId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  note: string | null;
  reviewNote: string | null;
  submittedByUserId: number | null;
  reviewedByUserId: number | null;
  reviewedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ServiceRequestPage {
  items: ServiceRequestRecord[];
  total: number;
  pageNum: number;
  pageSize: number;
}

export interface ServiceRequestSummary {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  issued: number;
  cancelled: number;
}
