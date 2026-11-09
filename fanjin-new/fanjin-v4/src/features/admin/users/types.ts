export const userRoleOptions = ["root", "admin", "finance_viewer", "finance_operator", "finance_manager", "owner", "member"] as const;
export const userStatusOptions = ["active", "disabled", "locked"] as const;
export const accountTypeOptions = ["personal", "enterprise"] as const;
export const billingModeOptions = ["prepaid", "postpaid", "hybrid"] as const;
export const settlementTypeOptions = ["online", "offline", "contract"] as const;

export type UserRole = (typeof userRoleOptions)[number];
export type UserStatus = (typeof userStatusOptions)[number];
export type AccountType = (typeof accountTypeOptions)[number];
export type BillingMode = (typeof billingModeOptions)[number];
export type SettlementType = (typeof settlementTypeOptions)[number];

export const userRoleLabels: Record<UserRole, string> = {
  root: "Root 管理员",
  admin: "平台管理员",
  finance_viewer: "财务查看者",
  finance_operator: "财务操作员",
  finance_manager: "财务管理员",
  owner: "工作区所有者",
  member: "普通成员",
};

export const userStatusLabels: Record<UserStatus, string> = {
  active: "正常",
  disabled: "已停用",
  locked: "已锁定",
};

export const accountTypeLabels: Record<AccountType, string> = {
  personal: "个人账户",
  enterprise: "企业账户",
};

export const billingModeLabels: Record<BillingMode, string> = {
  prepaid: "预付费",
  postpaid: "后付费",
  hybrid: "混合计费",
};

export const settlementTypeLabels: Record<SettlementType, string> = {
  online: "线上结算",
  offline: "线下结算",
  contract: "合同结算",
};

export interface AdminUserRecord {
  id: number;
  name: string;
  email?: string | null;
  displayName?: string | null;
  role?: string | null;
  status?: string | null;
  currentWorkspaceId?: string | null;
  currentWorkspaceName?: string | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
  lastLoginAt?: string | number | null;
  accountType?: string | null;
  verification?: {
    status?: string | null;
    statusText?: string | null;
    subjectName?: string | null;
    taxId?: string | null;
  } | null;
  team?: {
    ownedWorkspaceCount?: number;
    joinedWorkspaceCount?: number;
    memberCount?: number;
  } | null;
  billing?: {
    accountId?: string | null;
    balanceGu?: number;
    creditLimitGu?: number;
    reservedGu?: number;
    planId?: string | null;
    planName?: string | null;
    billingMode?: string | null;
  } | null;
  commercial?: {
    accountType?: string | null;
    commercialGroup?: string | null;
    pricingGroup?: string | null;
    rechargeDiscountBps?: number;
    billingMode?: string | null;
    settlementType?: string | null;
    notes?: string | null;
  } | null;
  attribution?: {
    registeredTenantId?: string | null;
    registrationHostname?: string | null;
    registrationSource?: string | null;
    ownerTenantId?: string | null;
    ownerTenantRevision?: number;
    ownerTenantChangedAt?: string | number | null;
    ownerTenantChangeReason?: string | null;
  } | null;
}

export const registrationSourceLabels: Record<string, string> = {
  public_signup: "公开注册",
  admin_create: "管理员创建",
  import: "批量导入",
  legacy_default: "历史默认",
};

export interface UserAttributionDetail {
  userId: number;
  userName?: string | null;
  attribution: {
    userId: number;
    registeredTenantId: string;
    registrationHostname: string | null;
    registrationSource: string;
    ownerTenantId: string;
    ownerTenantRevision: number;
    ownerTenantChangedAt: number | null;
    ownerTenantChangedByUserId: number | null;
    ownerTenantChangeReason: string | null;
  };
  registeredTenantName: string | null;
  ownerTenantName: string | null;
  history: Array<{
    id: string;
    userId: number;
    fromTenantId: string;
    toTenantId: string;
    fromTenantName: string | null;
    toTenantName: string | null;
    revision: number;
    reason: string;
    operatorUserId: number | null;
    createdAt: number;
  }>;
}

export interface ChangeOwnerTenantInput {
  ownerTenantId: string;
  expectedRevision: number;
  reason: string;
}

export interface UsersListInput {
  keyword?: string;
  status?: "all" | UserStatus;
  accountType?: "all" | AccountType;
  role?: "all" | UserRole;
  pricingGroup?: string;
  ownerTenantId?: string;
  pageNum: number;
  pageSize: number;
}

export interface UsersListPayload {
  items: AdminUserRecord[];
  total: number;
  pageNum: number;
  pageSize: number;
  summary?: {
    total?: number;
    active?: number;
    personal?: number;
    enterprise?: number;
  };
}

export interface CreateUserInput {
  name: string;
  email?: string | null;
  displayName?: string | null;
  password: string;
  workspaceName?: string | null;
  accountType: AccountType;
  commercialGroup: string;
  pricingGroup?: string | null;
  rechargeDiscountBps: number;
  billingMode: BillingMode;
  settlementType: SettlementType;
  notes?: string | null;
}

export interface UpdateUserInput {
  userId: number;
  displayName?: string | null;
  email?: string | null;
  status?: UserStatus;
  role?: UserRole;
  commercial?: {
    accountType: AccountType;
    commercialGroup: string;
    pricingGroup?: string | null;
    rechargeDiscountBps: number;
    billingMode: BillingMode;
    settlementType: SettlementType;
    notes?: string | null;
  };
}

export interface UserFormState {
  name: string;
  displayName: string;
  email: string;
  password: string;
  confirmPassword: string;
  workspaceName: string;
  role: UserRole;
  status: UserStatus;
  accountType: AccountType;
  commercialGroup: string;
  pricingGroup: string;
  rechargeDiscountBps: number;
  billingMode: BillingMode;
  settlementType: SettlementType;
  notes: string;
}

function supportedValue<T extends string>(value: unknown, supported: readonly T[], fallback: T): T {
  return supported.includes(value as T) ? value as T : fallback;
}

export function emptyUserForm(): UserFormState {
  return {
    name: "",
    displayName: "",
    email: "",
    password: "",
    confirmPassword: "",
    workspaceName: "",
    role: "owner",
    status: "active",
    accountType: "personal",
    commercialGroup: "default",
    pricingGroup: "",
    rechargeDiscountBps: 10000,
    billingMode: "prepaid",
    settlementType: "online",
    notes: "",
  };
}

export function userFormFromRecord(user: AdminUserRecord): UserFormState {
  const commercial = user.commercial || {};
  return {
    ...emptyUserForm(),
    name: String(user.name || ""),
    displayName: String(user.displayName || ""),
    email: String(user.email || ""),
    workspaceName: String(user.currentWorkspaceName || ""),
    role: supportedValue(user.role, userRoleOptions, "member"),
    status: supportedValue(user.status, userStatusOptions, "active"),
    accountType: supportedValue(commercial.accountType || user.accountType, accountTypeOptions, "personal"),
    commercialGroup: String(commercial.commercialGroup || "default"),
    pricingGroup: String(commercial.pricingGroup || ""),
    rechargeDiscountBps: Number(commercial.rechargeDiscountBps ?? 10000),
    billingMode: supportedValue(commercial.billingMode || user.billing?.billingMode, billingModeOptions, "prepaid"),
    settlementType: supportedValue(commercial.settlementType, settlementTypeOptions, "online"),
    notes: String(commercial.notes || ""),
  };
}
