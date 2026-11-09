import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type {
  ServiceRequestPage,
  ServiceRequestRecord,
  ServiceRequestStatus,
  ServiceRequestSummary,
  ServiceRequestType,
} from "./types";

export interface ServiceRequestFilters {
  workspaceId?: string | null;
  type?: ServiceRequestType | null;
  status?: ServiceRequestStatus | null;
  pageNum: number;
  pageSize: number;
}

export function listServiceRequests(filters: ServiceRequestFilters) {
  return apiPost<ServiceRequestPage>("/admin/billing/serviceRequests/list", { ...filters });
}

export async function loadServiceRequestSummary(): Promise<ServiceRequestSummary> {
  const statuses: ServiceRequestStatus[] = ["pending", "approved", "rejected", "issued", "cancelled"];
  const [all, ...pages] = await Promise.all([
    listServiceRequests({ pageNum: 1, pageSize: 1 }),
    ...statuses.map((status) => listServiceRequests({ status, pageNum: 1, pageSize: 1 })),
  ]);
  return {
    total: Number(all.total || 0),
    pending: Number(pages[0]?.total || 0),
    approved: Number(pages[1]?.total || 0),
    rejected: Number(pages[2]?.total || 0),
    issued: Number(pages[3]?.total || 0),
    cancelled: Number(pages[4]?.total || 0),
  };
}

export function updateServiceRequest(id: string, status: ServiceRequestStatus, reviewNote: string) {
  return apiPostWithStepUp<ServiceRequestRecord>(
    "/admin/billing/serviceRequests/update",
    { id, status, reviewNote: reviewNote.trim() || null },
    "admin.billing.service_request",
    "处理平台服务申请",
  );
}
