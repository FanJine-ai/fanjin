import {
  Activity,
  BadgeCheck,
  BadgeInfo,
  BookOpen,
  Bot,
  Boxes,
  Building2,
  CircleDollarSign,
  ClipboardList,
  Cpu,
  CreditCard,
  FileClock,
  FileText,
  Gauge,
  Globe2,
  Inbox,
  KeyRound,
  Landmark,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  ReceiptText,
  Rocket,
  Route,
  ScanFace,
  Scale,
  ServerCog,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Ticket,
  UserCog,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { ConsoleAccess, ConsoleAccessKey, GuardMeta } from "./consoleAccess";

export type ConsoleRoot = "workspace" | "admin" | "developer" | "settings";

export type ConsoleRouteId =
  | "workspace.select"
  | "workspace.members"
  | "workspace.manage"
  | "workspace.connections"
  | "workspace.billing"
  | "developer.overview"
  | "developer.api.keys"
  | "developer.api.docs"
  | "developer.api.request"
  | "developer.api.tasks"
  | "developer.api.logs"
  | "developer.api.models"
  | "admin.systemPrompts"
  | "admin.agents"
  | "admin.overview"
  | "admin.operations"
  | "admin.observability"
  | "admin.users"
  | "admin.relayTasks"
  | "admin.requestLogs"
  | "admin.auditLogs"
  | "admin.mediaServices"
  | "admin.providerChannels"
  | "admin.modelPool"
  | "admin.modelRoutes"
  | "admin.videoFulfillment"
  | "admin.qualityEnhancement"
  | "admin.portraitAssets"
  | "admin.portraitAssetRelay"
  | "admin.finance"
  | "admin.commercialTenants"
  | "admin.tenantDirectory"
  | "admin.tenantDomains"
  | "admin.tenantReconciliation"
  | "admin.serviceRequests"
  | "admin.releases"
  | "admin.reconciliation"
  | "admin.pricingRules"
  | "admin.billingPlans"
  | "admin.redemption"
  | "admin.systemSettings"
  | "admin.modelManagement"
  | "settings.account"
  | "settings.profile.basic"
  | "settings.profile.authentication"
  | "settings.profile.security"
  | "settings.about"
  | "settings.apiStatus";

export type ConsoleRouteEntry = {
  id: ConsoleRouteId;
  root: ConsoleRoot;
  routePath: string;
  fullPath: string;
  label: string;
  icon: LucideIcon;
  guardMeta: GuardMeta;
  access: ConsoleAccessKey;
  menuSection?: string;
  menuOrder?: number;
  matchPrefix?: string;
  showInMenu?: boolean;
};

export type ConsoleMenuItem = {
  path: string;
  label: string;
  matchPrefix?: string;
  icon: LucideIcon;
  order?: number;
};

export type ConsoleMenuSection = {
  label: string;
  icon: LucideIcon;
  items: ConsoleMenuItem[];
};

const authOnly: GuardMeta = { requiresAuth: true };
const adminOnly: GuardMeta = { requiresAuth: true, requiresAdmin: true };
const developerOnly: GuardMeta = { requiresAuth: true, requiresDeveloperAccess: true };

const MENU_SECTION_META: Record<string, { icon: LucideIcon; order: number }> = {
  工作区: { icon: Gauge, order: 10 },
  密钥管理: { icon: KeyRound, order: 20 },
  我的账号: { icon: UserRound, order: 100 },
  概览: { icon: LayoutDashboard, order: 10 },
  运营: { icon: ClipboardList, order: 20 },
  平台管理: { icon: Landmark, order: 25 },
  模型管理: { icon: Cpu, order: 30 },
  "AI 策略": { icon: Bot, order: 40 },
  计费与财务: { icon: CircleDollarSign, order: 50 },
  系统治理: { icon: ShieldCheck, order: 60 },
};

export const CONSOLE_ROUTE_ENTRIES: ConsoleRouteEntry[] = [
  {
    id: "workspace.connections",
    menuOrder: 80,
    root: "workspace",
    routePath: "connections",
    fullPath: "/workspace/connections",
    label: "MCP / CLI 连接",
    icon: TerminalSquare,
    guardMeta: developerOnly,
    access: "developer",
    menuSection: "工作区",
  },
  {
    id: "workspace.select",
    root: "workspace",
    routePath: "select",
    fullPath: "/workspace/select",
    label: "工作区首页",
    icon: Gauge,
    guardMeta: authOnly,
    access: "always",
    menuSection: "工作区",
    matchPrefix: "/workspace/select",
  },
  {
    id: "workspace.members",
    root: "workspace",
    routePath: "members",
    fullPath: "/workspace/members",
    label: "工作区成员",
    icon: UsersRound,
    guardMeta: { requiresAuth: true, requiresWorkspaceMembers: true },
    access: "workspaceMembers",
    menuSection: "工作区",
  },
  {
    id: "workspace.manage",
    root: "workspace",
    routePath: "manage",
    fullPath: "/workspace/manage",
    label: "工作区管理",
    icon: Building2,
    guardMeta: { requiresAuth: true, requiresWorkspaceManager: true },
    access: "workspaceManager",
    menuSection: "工作区",
  },
  {
    id: "workspace.billing",
    root: "workspace",
    routePath: "billing",
    fullPath: "/workspace/billing",
    label: "账单与用量",
    icon: CreditCard,
    guardMeta: { requiresAuth: true, requiresBillingAccess: true },
    access: "billing",
    menuSection: "工作区",
  },
  {
    id: "developer.overview",
    menuOrder: 60,
    root: "developer",
    routePath: "",
    fullPath: "/developer",
    label: "开发者总览",
    icon: KeyRound,
    guardMeta: developerOnly,
    access: "developer",
    menuSection: "工作区",
  },
  {
    id: "developer.api.keys",
    menuOrder: 70,
    root: "developer",
    routePath: "api/keys",
    fullPath: "/developer/api/keys",
    label: "API 中转密钥",
    icon: KeyRound,
    guardMeta: developerOnly,
    access: "developer",
    menuSection: "工作区",
    matchPrefix: "/developer/api/keys",
  },
  {
    id: "developer.api.docs",
    root: "developer",
    routePath: "api/docs",
    fullPath: "/developer/api/docs",
    label: "文档",
    icon: BookOpen,
    guardMeta: developerOnly,
    access: "developer",
    menuSection: "密钥管理",
    matchPrefix: "/developer/api/docs",
    showInMenu: false,
  },
  {
    id: "developer.api.request",
    root: "developer",
    routePath: "api/request",
    fullPath: "/developer/api/request",
    label: "调试",
    icon: TerminalSquare,
    guardMeta: developerOnly,
    access: "developer",
    menuSection: "密钥管理",
    matchPrefix: "/developer/api/request",
    showInMenu: false,
  },
  {
    id: "developer.api.tasks",
    root: "developer",
    routePath: "api/tasks",
    fullPath: "/developer/api/tasks",
    label: "任务",
    icon: ClipboardList,
    guardMeta: developerOnly,
    access: "developer",
    menuSection: "密钥管理",
    matchPrefix: "/developer/api/tasks",
    showInMenu: false,
  },
  {
    id: "developer.api.logs",
    root: "developer",
    routePath: "api/logs",
    fullPath: "/developer/api/logs",
    label: "日志",
    icon: FileClock,
    guardMeta: developerOnly,
    access: "developer",
    menuSection: "密钥管理",
    matchPrefix: "/developer/api/logs",
    showInMenu: false,
  },
  {
    id: "developer.api.models",
    root: "developer",
    routePath: "api/models",
    fullPath: "/developer/api/models",
    label: "模型与能力",
    icon: Boxes,
    guardMeta: developerOnly,
    access: "developer",
    menuSection: "密钥管理",
    matchPrefix: "/developer/api/models",
    showInMenu: false,
  },
  {
    id: "admin.overview",
    root: "admin",
    routePath: "overview",
    fullPath: "/fjadmin/overview",
    label: "平台概览",
    icon: LayoutDashboard,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "概览",
    menuOrder: 10,
    matchPrefix: "/fjadmin/overview",
  },
  {
    id: "admin.users",
    root: "admin",
    routePath: "users",
    fullPath: "/fjadmin/users",
    label: "用户管理",
    icon: UserCog,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "运营",
    menuOrder: 10,
    matchPrefix: "/fjadmin/users",
  },
  {
    id: "admin.agents",
    root: "admin",
    routePath: "agents",
    fullPath: "/fjadmin/agents",
    label: "Agent 中枢",
    icon: Bot,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "AI 策略",
    menuOrder: 10,
    matchPrefix: "/fjadmin/agents",
  },
  {
    id: "admin.serviceRequests",
    root: "admin",
    routePath: "service-requests",
    fullPath: "/fjadmin/service-requests",
    label: "服务申请",
    icon: Inbox,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "运营",
    menuOrder: 20,
  },
  {
    id: "admin.releases",
    root: "admin",
    routePath: "releases",
    fullPath: "/fjadmin/releases",
    label: "版本发布",
    icon: Rocket,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "系统治理",
    menuOrder: 40,
  },
  {
    id: "admin.operations",
    root: "admin",
    routePath: "operations",
    fullPath: "/fjadmin/operations",
    label: "运维总览",
    icon: Activity,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "系统治理",
    menuOrder: 10,
    matchPrefix: "/fjadmin/operations",
  },
  {
    id: "admin.observability",
    root: "admin",
    routePath: "observability",
    fullPath: "/fjadmin/observability",
    label: "可观测性",
    icon: Gauge,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "系统治理",
    menuOrder: 20,
    matchPrefix: "/fjadmin/observability",
  },
  {
    id: "admin.relayTasks",
    root: "admin",
    routePath: "relay-tasks",
    fullPath: "/fjadmin/relay-tasks",
    label: "视频任务",
    icon: ListChecks,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "运营",
    menuOrder: 30,
  },
  {
    id: "admin.requestLogs",
    root: "admin",
    routePath: "request-logs",
    fullPath: "/fjadmin/request-logs",
    label: "平台请求日志",
    icon: ClipboardList,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "运营",
    menuOrder: 40,
  },
  {
    id: "admin.auditLogs",
    root: "admin",
    routePath: "audit-logs",
    fullPath: "/fjadmin/audit-logs",
    label: "审计日志",
    icon: FileText,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "系统治理",
    menuOrder: 30,
  },
  {
    id: "admin.providerChannels",
    root: "admin",
    routePath: "provider-channels",
    fullPath: "/fjadmin/provider-channels",
    label: "供应商通道",
    icon: ServerCog,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "模型管理",
    menuOrder: 10,
  },
  {
    id: "admin.modelPool",
    root: "admin",
    routePath: "model-pool",
    fullPath: "/fjadmin/model-pool",
    label: "模型池",
    icon: Boxes,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "模型管理",
    menuOrder: 20,
  },
  {
    id: "admin.modelRoutes",
    root: "admin",
    routePath: "model-routes",
    fullPath: "/fjadmin/model-routes",
    label: "模型路由",
    icon: Route,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "模型管理",
    menuOrder: 30,
    showInMenu: false,
  },
  {
    id: "admin.modelManagement",
    root: "admin",
    routePath: "model-management",
    fullPath: "/fjadmin/model-management",
    label: "模型路由",
    icon: Route,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "模型管理",
    menuOrder: 30,
    matchPrefix: "/fjadmin/model-management",
  },
  {
    id: "admin.videoFulfillment",
    root: "admin",
    routePath: "video-fulfillment",
    fullPath: "/fjadmin/video-fulfillment",
    label: "视频能力兑现",
    icon: Gauge,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "模型管理",
    menuOrder: 40,
    showInMenu: false,
    matchPrefix: "/fjadmin/video-fulfillment",
  },
  {
    id: "admin.mediaServices",
    root: "admin",
    routePath: "media-services",
    fullPath: "/fjadmin/media-services",
    label: "媒体服务",
    icon: KeyRound,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "模型管理",
    menuOrder: 35,
  },
  {
    id: "admin.qualityEnhancement",
    root: "admin",
    routePath: "quality-enhancement",
    fullPath: "/fjadmin/quality-enhancement",
    label: "画质增强",
    icon: Sparkles,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "模型管理",
    menuOrder: 40,
  },
  {
    id: "admin.portraitAssets",
    root: "admin",
    routePath: "portrait-assets",
    fullPath: "/fjadmin/portrait-assets",
    label: "人像资产",
    icon: ScanFace,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "模型管理",
    menuOrder: 50,
  },
  {
    id: "admin.portraitAssetRelay",
    root: "admin",
    routePath: "portrait-asset-relay",
    fullPath: "/fjadmin/portrait-asset-relay",
    label: "人像资产中转",
    icon: Boxes,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "模型管理",
    menuOrder: 55,
  },
  {
    id: "admin.reconciliation",
    root: "admin",
    routePath: "reconciliation",
    fullPath: "/fjadmin/reconciliation",
    label: "计费对账",
    icon: Scale,
    guardMeta: { requiresAuth: true, requiresFinanceManager: true },
    access: "financeManager",
    menuSection: "计费与财务",
    menuOrder: 50,
  },
  {
    id: "admin.systemPrompts",
    root: "admin",
    routePath: "system-prompts",
    fullPath: "/fjadmin/system-prompts",
    label: "系统提示词",
    icon: LayoutTemplate,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "AI 策略",
    menuOrder: 20,
  },
  {
    id: "admin.finance",
    root: "admin",
    routePath: "finance",
    fullPath: "/fjadmin/finance",
    label: "财务中心",
    icon: CircleDollarSign,
    guardMeta: { requiresAuth: true, requiresFinance: true },
    access: "finance",
    menuSection: "计费与财务",
    menuOrder: 10,
    matchPrefix: "/fjadmin/finance",
  },
  {
    id: "admin.commercialTenants",
    root: "admin",
    routePath: "commercial-tenants",
    fullPath: "/fjadmin/commercial-tenants",
    label: "商业租户",
    icon: Landmark,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "平台管理",
    matchPrefix: "/fjadmin/commercial-tenants",
  },
  {
    id: "admin.tenantDirectory",
    root: "admin",
    routePath: "tenant-directory",
    fullPath: "/fjadmin/tenant-directory",
    label: "租户目录",
    icon: Building2,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "平台管理",
    matchPrefix: "/fjadmin/tenant-directory",
  },
  {
    id: "admin.tenantDomains",
    root: "admin",
    routePath: "tenant-domains",
    fullPath: "/fjadmin/tenant-domains",
    label: "租户域名与证书",
    icon: Globe2,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "平台管理",
    matchPrefix: "/fjadmin/tenant-domains",
  },
  {
    id: "admin.tenantReconciliation",
    root: "admin",
    routePath: "tenant-reconciliation",
    fullPath: "/fjadmin/tenant-reconciliation",
    label: "租户对账",
    icon: Scale,
    // The API router is platform-admin only. Keep navigation and route guards
    // aligned so finance viewers do not land on a page whose every request is 403.
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "计费与财务",
    matchPrefix: "/fjadmin/tenant-reconciliation",
  },
  {
    id: "admin.pricingRules",
    root: "admin",
    routePath: "pricing-rules",
    fullPath: "/fjadmin/pricing-rules",
    // Avoid duplicating the enclosing "模型管理" disclosure's accessible name.
    label: "模型定价",
    icon: ReceiptText,
    guardMeta: { requiresAuth: true, requiresFinanceManager: true },
    access: "financeManager",
    menuSection: "模型管理",
    menuOrder: 60,
  },
  {
    id: "admin.billingPlans",
    root: "admin",
    routePath: "billing-plans",
    fullPath: "/fjadmin/billing-plans",
    label: "套餐管理",
    icon: CreditCard,
    guardMeta: { requiresAuth: true, requiresFinanceManager: true },
    access: "financeManager",
    menuSection: "计费与财务",
    menuOrder: 30,
  },
  {
    id: "admin.redemption",
    root: "admin",
    routePath: "redemption",
    fullPath: "/fjadmin/redemption",
    label: "兑换码",
    icon: Ticket,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "计费与财务",
    menuOrder: 40,
  },
  {
    id: "admin.systemSettings",
    root: "admin",
    routePath: "system-settings",
    fullPath: "/fjadmin/system-settings",
    label: "平台设置",
    icon: Settings2,
    guardMeta: adminOnly,
    access: "admin",
    menuSection: "系统治理",
    menuOrder: 50,
  },
  {
    id: "settings.account", root: "settings", routePath: "account", fullPath: "/settings/account",
    label: "账号总览", icon: Gauge, guardMeta: authOnly, access: "always", menuSection: "我的账号", menuOrder: 0,
  },
  {
    id: "settings.profile.basic",
    root: "settings",
    routePath: "profile/basic",
    fullPath: "/settings/profile/basic",
    label: "基本信息",
    icon: UserRound,
    guardMeta: authOnly,
    access: "always",
    menuSection: "我的账号",
    matchPrefix: "/settings/profile/basic",
  },
  {
    id: "settings.profile.authentication",
    root: "settings",
    routePath: "profile/authentication",
    fullPath: "/settings/profile/authentication",
    label: "实名认证",
    icon: BadgeCheck,
    guardMeta: authOnly,
    access: "always",
    menuSection: "我的账号",
    matchPrefix: "/settings/profile/authentication",
  },
  {
    id: "settings.profile.security",
    root: "settings",
    routePath: "profile/security",
    fullPath: "/settings/profile/security",
    label: "安全设置",
    icon: ShieldCheck,
    guardMeta: authOnly,
    access: "always",
    menuSection: "我的账号",
    matchPrefix: "/settings/profile/security",
  },
  {
    id: "settings.about",
    root: "settings",
    routePath: "about",
    fullPath: "/settings/about",
    label: "关于版本",
    icon: BadgeInfo,
    guardMeta: authOnly,
    access: "always",
    menuSection: "我的账号",
  },
  {
    id: "settings.apiStatus",
    root: "settings",
    routePath: "api-status",
    fullPath: "/settings/api-status",
    label: "API 状态",
    icon: ServerCog,
    guardMeta: authOnly,
    access: "always",
    showInMenu: false,
  },
];

export const CONSOLE_ROUTE_BY_ID = Object.fromEntries(
  CONSOLE_ROUTE_ENTRIES.map((entry) => [entry.id, entry]),
) as Record<ConsoleRouteId, ConsoleRouteEntry>;

export function getConsoleEntriesByRoot(root: ConsoleRoot) {
  return CONSOLE_ROUTE_ENTRIES.filter((entry) => entry.root === root);
}

export function buildConsoleMenuSections(access: ConsoleAccess, roots?: readonly ConsoleRoot[]): ConsoleMenuSection[] {
  const sectionMap = new Map<string, ConsoleMenuSection & { order: number }>();
  const allowedRoots = roots ? new Set(roots) : null;
  CONSOLE_ROUTE_ENTRIES.forEach((entry, index) => {
    if (allowedRoots && !allowedRoots.has(entry.root)) return;
    if (entry.showInMenu === false || !entry.menuSection || !access[entry.access]) return;
    const sectionMeta = MENU_SECTION_META[entry.menuSection];
    let section = sectionMap.get(entry.menuSection);
    if (!section) {
      section = {
        label: entry.menuSection,
        icon: sectionMeta?.icon ?? entry.icon,
        items: [],
        order: sectionMeta?.order ?? index,
      };
      sectionMap.set(entry.menuSection, section);
    }
    section.items.push({
      path: entry.fullPath,
      label: entry.label,
      matchPrefix: entry.matchPrefix,
      icon: entry.icon,
      order: entry.menuOrder ?? index,
    });
  });

  return Array.from(sectionMap.values())
    .sort((left, right) => left.order - right.order)
    .map(({ label, icon, items }) => ({
      label,
      icon,
      items: items
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .map(({ order: _order, ...item }) => item),
    }));
}

export function getVisibleConsoleMenuPaths() {
  return CONSOLE_ROUTE_ENTRIES
    .filter((entry) => entry.showInMenu !== false && entry.menuSection)
    .map((entry) => entry.fullPath)
    .sort();
}
