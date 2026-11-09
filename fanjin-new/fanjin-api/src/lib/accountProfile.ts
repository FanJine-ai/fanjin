import u from "@/utils";
import { normalizePasswordPolicy, normalizeSessionPolicy } from "@/lib/accountSecurity";

export type AccountVerificationType = "personal" | "enterprise";
export type AccountVerificationStatus = "not_started" | "pending" | "approved" | "rejected";

export interface AccountProfileContext {
  userId: number;
  workspaceId?: string | null;
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function maskIdentity(value?: string | null): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.length <= 6) return `${text.slice(0, 1)}****${text.slice(-1)}`;
  return `${text.slice(0, 3)}********${text.slice(-4)}`;
}

function maskPhone(value?: string | null): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.replace(/^(\+?\d{2,4})?\d{3,4}(\d{4})$/, (_all, prefix = "", suffix) => `${prefix}****${suffix}`);
}

function normalizeStatus(value?: string | null): AccountVerificationStatus {
  if (value === "pending" || value === "approved" || value === "rejected") return value;
  return "not_started";
}

function normalizeVerification(row: any | null, type: AccountVerificationType) {
  const metadata = parseJsonRecord(row?.metadata);
  return {
    type,
    status: normalizeStatus(row?.status),
    subjectName: row?.subjectName || null,
    companyName: row?.companyName || null,
    unifiedSocialCreditCode: row?.unifiedSocialCreditCode || null,
    legalRepresentative: row?.legalRepresentative || null,
    contactPhone: row?.contactPhone || null,
    idNumberMasked: row?.idNumberMasked || null,
    submittedAt: row?.submittedAt || null,
    approvedAt: row?.approvedAt || null,
    rejectedReason: row?.rejectedReason || metadata.rejectedReason || null,
    metadata,
  };
}

function defaultSecurity(user: any, row: any | null) {
  const passwordPolicy = normalizePasswordPolicy(row?.passwordPolicy);
  const passwordChangedAt = Number(user?.passwordChangedAt || user?.createdAt || 0) || null;
  const passwordExpiresAt = passwordPolicy.expireDays > 0 && passwordChangedAt
    ? passwordChangedAt + passwordPolicy.expireDays * 24 * 60 * 60 * 1000
    : null;
  return {
    phone: row?.phone || null,
    email: user?.email || null,
    phoneBound: Boolean(row?.phone),
    emailBound: Boolean(user?.email),
    mfaEnabled: Boolean(row?.mfaEnabled),
    loginProtectionEnabled: Boolean(row?.loginProtectionEnabled),
    sensitiveOperationProtectionEnabled: Boolean(row?.sensitiveOperationProtectionEnabled),
    loginIpAllowlist: row?.loginIpAllowlist || "",
    passwordPolicy,
    sessionPolicy: normalizeSessionPolicy(row?.sessionPolicy),
    passwordChangedAt,
    passwordExpiresAt,
    passwordExpired: Boolean(passwordExpiresAt && passwordExpiresAt <= Date.now()),
    updatedAt: row?.updatedAt || null,
  };
}

export async function getAccountProfile(input: AccountProfileContext) {
  const db = u.db as any;
  const user = await db("o_user")
    .select("id", "name", "email", "displayName", "role", "status", "currentWorkspaceId", "createdAt", "updatedAt", "lastLoginAt", "passwordChangedAt")
    .where("id", input.userId)
    .first();
  if (!user) return null;

  const workspaceId = input.workspaceId || user.currentWorkspaceId || "default";
  const workspace = workspaceId ? await db("o_workspace").where("id", workspaceId).first() : null;
  const verificationRows = await db("o_account_verification").where("userId", input.userId);
  const securityRow = await db("o_account_security").where("userId", input.userId).first();
  const findVerification = (type: AccountVerificationType) => verificationRows.find((row: any) => row.type === type) || null;

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email || null,
      displayName: user.displayName || user.name,
      role: user.role || "member",
      status: user.status || "active",
      createdAt: user.createdAt || null,
      updatedAt: user.updatedAt || null,
      lastLoginAt: user.lastLoginAt || null,
    },
    workspace: workspace
      ? {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          status: workspace.status,
        }
      : {
          id: workspaceId,
          name: "默认工作区",
          slug: "default",
          status: "active",
        },
    verification: {
      personal: normalizeVerification(findVerification("personal"), "personal"),
      enterprise: normalizeVerification(findVerification("enterprise"), "enterprise"),
    },
    security: defaultSecurity(user, securityRow),
  };
}

export function buildVerificationPatch(type: AccountVerificationType, data: Record<string, unknown>) {
  const now = Date.now();
  if (type === "personal") {
    const realName = String(data.realName || "").trim();
    const idNumber = String(data.idNumber || "").trim();
    const contactPhone = String(data.contactPhone || "").trim();
    return {
      subjectName: realName,
      idNumberMasked: maskIdentity(idNumber),
      contactPhone: maskPhone(contactPhone),
      companyName: null,
      unifiedSocialCreditCode: null,
      legalRepresentative: null,
      status: "pending",
      metadata: JSON.stringify({
        source: "self_service",
        idNumberLast4: idNumber ? idNumber.slice(-4) : "",
      }),
      submittedAt: now,
      updatedAt: now,
    };
  }

  const companyName = String(data.companyName || "").trim();
  const taxId = String(data.unifiedSocialCreditCode || data.taxId || "").trim().toUpperCase();
  const legalRepresentative = String(data.legalRepresentative || "").trim();
  const contactPhone = String(data.contactPhone || "").trim();
  return {
    subjectName: companyName,
    companyName,
    unifiedSocialCreditCode: taxId,
    legalRepresentative,
    contactPhone: maskPhone(contactPhone),
    idNumberMasked: null,
    status: "pending",
    metadata: JSON.stringify({
      source: "self_service",
      businessLicenseUploaded: Boolean(data.businessLicenseUploaded),
    }),
    submittedAt: now,
    updatedAt: now,
  };
}
