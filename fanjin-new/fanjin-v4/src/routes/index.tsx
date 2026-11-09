import { lazy, type ReactElement } from "react";
import { createHashRouter, Navigate, type RouteObject, useLocation } from "react-router-dom";
import RootRouteError from "../pages/error/RootRouteError";
import { RouteGuard } from "./RouteGuard";
import { CONSOLE_ROUTE_BY_ID, type ConsoleRouteId } from "./consoleRegistry";
import { ProjectModeRouteSync } from "./ProjectModeRouteSync";

const ToolApprovalPage = lazy(() => import("../pages/tools/ToolApprovalPage"));
const ToolConnections = lazy(() => import("../pages/workspace/ToolConnectionsPage"));

/* ---------- layout components ---------- */
const RootLayout = lazy(() => import("../layouts/RootLayout"));
const ConsoleLayout = lazy(() => import("../pages/console/ConsoleLayout"));

/* ---------- top-level pages ---------- */
const WorkbenchEntryPage = lazy(() => import("../pages/create/WorkbenchEntryPage"));
const GuestWorkbench = lazy(() => import("../pages/create/GuestWorkbench"));
const Register = lazy(() => import("../pages/auth/Register"));
const ForgotPassword = lazy(() => import("../pages/auth/ForgotPassword"));
const ResetPassword = lazy(() => import("../pages/auth/ResetPassword"));
const VerifyEmail = lazy(() => import("../pages/auth/VerifyEmail"));
const OAuthCallback = lazy(() => import("../pages/auth/OAuthCallback"));
const TenantTransfer = lazy(() => import("../pages/auth/TenantTransfer"));
const TermsPage = lazy(() => import("../pages/legal/TermsPage"));
const PrivacyPage = lazy(() => import("../pages/legal/PrivacyPage"));
const DeveloperDocsPage = lazy(() => import("../pages/docs/DeveloperDocsPage"));
const UserGuidePage = lazy(() => import("../pages/docs/UserGuidePage"));
const PublicDocsHome = lazy(() => import("../pages/docs/PublicDocsHome"));
const ModelPlazaPage = lazy(() => import("../pages/models/ModelPlazaPage"));
const PublicCanvasSnapshotPage = lazy(() => import("../pages/public/PublicCanvasSnapshotPage"));
const FjtvGalleryPage = lazy(() => import("../pages/public/FjtvGalleryPage"));
const NotFound = lazy(() => import("../pages/error/NotFound"));
const FeedbackAttachmentPage = lazy(() => import("../features/feedback/FeedbackAttachmentPage"));

/* ---------- canvas ---------- */
const CanvasEntryPage = lazy(() => import("../pages/canvas/CanvasEntryPage"));

/* ---------- workspace ---------- */
const AccountOverviewPage = lazy(() => import("../pages/analytics/AnalyticsDashboard"));
const WorkspaceSelectPage = lazy(() => import("../pages/workspace/WorkspaceSelectPage"));
const WorkspaceManagePage = lazy(() => import("../pages/workspace/WorkspaceManagePage"));
const SubaccountsPage = lazy(() => import("../pages/workspace/SubaccountsPage"));
const BillingPage = lazy(() => import("../pages/workspace/BillingPage"));

/* ---------- admin ---------- */
const AdminOverview = lazy(() => import("../pages/admin/overview"));
const AgentCenter = lazy(() => import("../features/admin/agents/Page"));
const AdminOperations = lazy(() => import("../pages/admin/operations"));
const AdminObservability = lazy(() => import("../features/admin/observability/Page"));
const FinanceCenter = lazy(() => import("../pages/admin/financeCenter"));
const ServiceRequests = lazy(() => import("../pages/admin/serviceRequests"));
const CommercialTenants = lazy(() => import("../pages/admin/commercialTenants"));
const TenantDirectory = lazy(() => import("../pages/admin/tenantDirectory"));
const TenantDomains = lazy(() => import("../pages/admin/tenantDomains"));
const TenantReconciliation = lazy(() => import("../pages/admin/tenantReconciliation"));
const PlatformReleases = lazy(() => import("../pages/admin/releases"));
const BillingReconciliation = lazy(() => import("../pages/admin/reconciliation"));
const AdminUsers = lazy(() => import("../pages/admin/users"));
const ProviderChannels = lazy(() => import("../pages/admin/providerChannels"));
const ModelPool = lazy(() => import("../pages/admin/modelPool"));
const RelayTasks = lazy(() => import("../pages/admin/relayTasks"));
const ModelRoutes = lazy(() => import("../pages/admin/modelRoutes"));
const VideoFulfillment = lazy(() => import("../pages/admin/videoFulfillment"));
const MediaServices = lazy(() => import("../pages/admin/mediaServices"));
const QualityEnhancement = lazy(() => import("../pages/admin/qualityEnhancement"));
const PortraitAssets = lazy(() => import("../pages/admin/portraitAssets"));
const PortraitAssetRelay = lazy(() => import("../pages/admin/portraitAssetRelay"));
const PricingRules = lazy(() => import("../pages/admin/pricingRules"));
const AuditLogs = lazy(() => import("../pages/admin/auditLogs"));
const RequestLogs = lazy(() => import("../pages/admin/requestLogs"));
const SystemSettings = lazy(() => import("../pages/admin/systemSettings"));
const BillingPlans = lazy(() => import("../pages/admin/billingPlans"));
const Redemption = lazy(() => import("../pages/admin/redemption"));
const SystemPrompts = lazy(() => import("../pages/admin/systemPrompts"));
const ModelManagement = lazy(() => import("../pages/admin/modelManagement"));

/* ---------- developer ---------- */
const DeveloperOverview = lazy(() => import("../pages/developer/overview"));
const DeveloperBilling = lazy(() => import("../pages/developer/billing"));
const ApiKeys = lazy(() => import("../pages/developer/apiKeys"));
const DevDocs = lazy(() => import("../pages/developer/docs"));
const DevRequest = lazy(() => import("../pages/developer/request"));
const DevTasks = lazy(() => import("../pages/developer/tasks"));
const DevLogs = lazy(() => import("../pages/developer/logs"));
const DevModels = lazy(() => import("../pages/developer/models"));

/* ---------- settings ---------- */
const ProfilePage = lazy(() => import("../pages/settings/ProfilePage"));
const AboutPage = lazy(() => import("../pages/settings/AboutPage"));
const SettingsApiStatusPage = lazy(() => import("../pages/settings/SettingsApiStatusPage"));

/* ---------- workbench ---------- */
const ProjectListPage = lazy(() => import("../pages/projects/ProjectListPage"));
const ProjectPage = lazy(() => import("../pages/project/index"));
const GenerateEntryPage = lazy(() => import("../pages/generate/GenerateEntryPage"));
const CreativeLibraryView = lazy(() => import("../pages/library/CreativeLibraryView"));
const TaskListPage = lazy(() => import("../pages/task/TaskListPage"));
const ProductionWorkbench = lazy(() => import("../pages/project/ProductionWorkbench"));
const NovelPage = lazy(() => import("../pages/novel/index"));
const ScriptPage = lazy(() => import("../pages/script/index"));
const CornerScapePage = lazy(() => import("../pages/cornerScape/CornerScapePage"));
const AssetListPage = lazy(() => import("../pages/assets/FileManagerPage"));

const consoleRouteElements: Record<ConsoleRouteId, ReactElement> = {
  "workspace.select": <WorkspaceSelectPage />,
  "workspace.members": <SubaccountsPage />,
  "workspace.manage": <WorkspaceManagePage />,
  "workspace.billing": <BillingPage />,
  "workspace.connections": <ToolConnections />,
  "developer.overview": <DeveloperOverview />,
  "developer.api.keys": <ApiKeys />,
  "developer.api.docs": <DevDocs />,
  "developer.api.request": <DevRequest />,
  "developer.api.tasks": <DevTasks />,
  "developer.api.logs": <DevLogs />,
  "developer.api.models": <DevModels />,
  "admin.systemPrompts": <SystemPrompts />,
  "admin.modelManagement": <ModelManagement />,
  "admin.agents": <AgentCenter />,
  "admin.overview": <AdminOverview />,
  "admin.operations": <AdminOperations />,
  "admin.observability": <AdminObservability />,
  "admin.users": <AdminUsers />,
  "admin.relayTasks": <RelayTasks />,
  "admin.requestLogs": <RequestLogs />,
  "admin.auditLogs": <AuditLogs />,
  "admin.providerChannels": <ProviderChannels />,
  "admin.modelPool": <ModelPool />,
  "admin.modelRoutes": <ModelRoutes />,
  "admin.videoFulfillment": <VideoFulfillment />,
  "admin.mediaServices": <MediaServices />,
  "admin.qualityEnhancement": <QualityEnhancement />,
  "admin.portraitAssets": <PortraitAssets />,
  "admin.portraitAssetRelay": <PortraitAssetRelay />,
  "admin.finance": <FinanceCenter />,
  "admin.serviceRequests": <ServiceRequests />,
  "admin.commercialTenants": <CommercialTenants />,
  "admin.tenantDirectory": <TenantDirectory />,
  "admin.tenantDomains": <TenantDomains />,
  "admin.tenantReconciliation": <TenantReconciliation />,
  "admin.releases": <PlatformReleases />,
  "admin.reconciliation": <BillingReconciliation />,
  "admin.pricingRules": <PricingRules />,
  "admin.billingPlans": <BillingPlans />,
  "admin.redemption": <Redemption />,
  "admin.systemSettings": <SystemSettings />,
  "settings.account": <AccountOverviewPage />,
  "settings.profile.basic": <ProfilePage />,
  "settings.profile.authentication": <ProfilePage />,
  "settings.profile.security": <ProfilePage />,
  "settings.about": <AboutPage />,
  "settings.apiStatus": <SettingsApiStatusPage />,
};

function consoleRouteElement(id: ConsoleRouteId) {
  const entry = CONSOLE_ROUTE_BY_ID[id];
  return <RouteGuard meta={entry.guardMeta}>{consoleRouteElements[id]}</RouteGuard>;
}

function consoleRoute(
  id: ConsoleRouteId,
  path = CONSOLE_ROUTE_BY_ID[id].routePath,
  children?: RouteObject[],
): RouteObject {
  return { path, element: consoleRouteElement(id), ...(children ? { children } : {}) };
}

function LegacyAdminRedirect() {
  const location = useLocation();
  const suffix = location.pathname.slice("/admin".length);
  return <Navigate to={`/fjadmin${suffix}${location.search}`} replace />;
}

function ProjectClipWorkbenchRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set("mode", "quick_create");
  params.set("stage", "clip");
  return <Navigate to={`/workbench/quick-create?${params.toString()}`} replace />;
}

function EntryRedirect({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={`${to}${location.search}`} replace />;
}

/* ========== router ========== */
export const appRoutes: RouteObject[] = [
  { path: "/tools/approvals/:approvalId", element: <RouteGuard meta={{ requiresAuth: true }}><ToolApprovalPage /></RouteGuard> },
  /* ---- public routes (no guard) ---- */
  {
    path: "/",
    element: <EntryRedirect to="/workbench/create" />,
  },
  {
    path: "/infinite-canvas-v2",
    element: <RouteGuard meta={{ requiresAuth: true }}><ProjectModeRouteSync mode="canvas"><CanvasEntryPage /></ProjectModeRouteSync></RouteGuard>,
  },
  {
    path: "/canvas/:id",
    element: <RouteGuard meta={{ requiresAuth: true }}><ProjectModeRouteSync mode="canvas"><CanvasEntryPage /></ProjectModeRouteSync></RouteGuard>,
  },
  {
    path: "/legal/terms",
    element: <TermsPage />,
  },
  {
    path: "/legal/privacy",
    element: <PrivacyPage />,
  },
  {
    path: "/docs",
    element: <PublicDocsHome />,
  },
  { path: "/docs/api", element: <DeveloperDocsPage kind="api" /> },
  { path: "/docs/mcp", element: <DeveloperDocsPage kind="mcp" /> },
  { path: "/docs/cli", element: <DeveloperDocsPage kind="cli" /> },
  { path: "/docs/user-guide", element: <UserGuidePage /> },
  {
    path: "/models",
    element: <ModelPlazaPage />,
  },
  {
    path: "/share/canvas/:slug",
    element: <PublicCanvasSnapshotPage source="share" />,
  },
  {
    path: "/fjtv",
    element: <FjtvGalleryPage />,
  },
  {
    path: "/fjtv/:slug",
    element: <PublicCanvasSnapshotPage source="fjtv" />,
  },
  {
    path: "/docs/legal/terms",
    element: <TermsPage />,
  },
  {
    path: "/docs/legal/privacy",
    element: <PrivacyPage />,
  },
  /* ---- auth routes (guestOnly) ---- */
  {
    path: "/auth/login",
    element: <RouteGuard meta={{ guestOnly: true }}><GuestWorkbench initialLoginOpen /></RouteGuard>,
  },
  {
    path: "/login",
    element: <EntryRedirect to="/auth/login" />,
  },
  {
    path: "/auth/register",
    element: <RouteGuard meta={{ guestOnly: true }}><Register /></RouteGuard>,
  },
  {
    path: "/auth/forgot-password",
    element: <RouteGuard meta={{ guestOnly: true }}><ForgotPassword /></RouteGuard>,
  },
  {
    path: "/auth/reset-password",
    element: <RouteGuard meta={{ guestOnly: true }}><ResetPassword /></RouteGuard>,
  },
  {
    path: "/auth/verify-email",
    element: <RouteGuard meta={{ guestOnly: true }}><VerifyEmail /></RouteGuard>,
  },
  {
    path: "/auth/oauth/callback",
    element: <RouteGuard meta={{ public: true }}><OAuthCallback /></RouteGuard>,
  },
  {
    path: "/auth/tenant-transfer",
    element: <RouteGuard meta={{ requiresAuth: true }}><TenantTransfer /></RouteGuard>,
  },

  { path: "/workbench", element: <EntryRedirect to="/workbench/create" /> },

  /* ---- front-stage tool entries: standalone Jimeng-like workspace ---- */
  {
    path: "/workbench/create",
    element: <WorkbenchEntryPage />,
  },
  {
    path: "/workbench/generate",
    element: <RouteGuard meta={{ requiresAuth: true }}><GenerateEntryPage /></RouteGuard>,
  },
  {
    path: "/workbench/generate/:id",
    element: <RouteGuard meta={{ requiresAuth: true }}><GenerateEntryPage /></RouteGuard>,
  },
  {
    path: "/workbench/assets",
    element: <RouteGuard meta={{ requiresAuth: true }}><AssetListPage /></RouteGuard>,
  },
  {
    path: "/workbench/project",
    element: <RouteGuard meta={{ requiresAuth: true }}><ProjectListPage /></RouteGuard>,
  },
  {
    path: "/workbench/novel",
    element: <RouteGuard meta={{ requiresAuth: true, requiresProject: true }}><NovelPage /></RouteGuard>,
  },
  {
    path: "/workbench/script",
    element: <RouteGuard meta={{ requiresAuth: true, requiresProject: true }}><ScriptPage /></RouteGuard>,
  },
  {
    path: "/workbench/canvas/editor",
    element: <RouteGuard meta={{ requiresAuth: true }}><ProjectModeRouteSync mode="canvas"><CanvasEntryPage /></ProjectModeRouteSync></RouteGuard>,
  },
  {
    path: "/workbench/canvas/editor/:id",
    element: <RouteGuard meta={{ requiresAuth: true }}><ProjectModeRouteSync mode="canvas"><CanvasEntryPage /></ProjectModeRouteSync></RouteGuard>,
  },
  {
    path: "/workbench/canvas",
    element: <RouteGuard meta={{ requiresAuth: true }}><ProjectListPage canvasEntry /></RouteGuard>,
  },

  /* ---- main app: canvas + workbench (RootLayout, requiresAuth) ---- */
  {
    element: (
      <RouteGuard meta={{ requiresAuth: true }}>
        <RootLayout />
      </RouteGuard>
    ),
    children: [
      /* Layout-backed workbench routes; standalone creator entries are declared above. */

      { path: "workbench/quick-create", element: <ProjectModeRouteSync mode="quick"><ProjectPage /></ProjectModeRouteSync> },
      { path: "workbench/director", element: <EntryRedirect to="/workbench/create" /> },
      { path: "workbench/library", element: <CreativeLibraryView /> },
      { path: "workbench/task", element: <TaskListPage /> },
      { path: "workbench/editor", element: <ProjectClipWorkbenchRedirect /> },
      {
        path: "workbench/production",
        element: (
          <RouteGuard meta={{ requiresAuth: true, requiresProject: true }}>
            <ProductionWorkbench />
          </RouteGuard>
        ),
      },
      {
        path: "workbench/script-agent",
        element: <Navigate to="/workbench/generate?mode=agent" replace />,
      },
      {
        path: "workbench/corner-scape",
        element: (
          <RouteGuard meta={{ requiresAuth: true, requiresProject: true }}>
            <CornerScapePage />
          </RouteGuard>
        ),
      },
    ],
  },

  /* ---- console: workspace (requiresAuth) ---- */
  {
    path: "/workspace",
    element: (
      <RouteGuard meta={{ requiresAuth: true }}>
        <ConsoleLayout />
      </RouteGuard>
    ),
    children: [
      { index: true, element: <Navigate to="select" replace /> },
      consoleRoute("workspace.select"),
      consoleRoute("workspace.manage"),
      consoleRoute("workspace.members"),
      { path: "subaccounts", element: <Navigate to="/workspace/members" replace /> },
      consoleRoute("workspace.billing"),
      consoleRoute("workspace.connections"),
    ],
  },

  /* ---- standalone FJ Admin: platform management / operations ---- */
  {
    path: "/fjadmin",
    element: (
      <RouteGuard meta={{ requiresAuth: true }}>
        <ConsoleLayout scope="fjadmin" />
      </RouteGuard>
    ),
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      consoleRoute("admin.overview"),
      consoleRoute("admin.operations"),
      consoleRoute("admin.observability"),
      consoleRoute("admin.finance"),
      consoleRoute("admin.serviceRequests"),
      consoleRoute("admin.commercialTenants"),
      consoleRoute("admin.tenantDirectory"),
      consoleRoute("admin.tenantDomains"),
      consoleRoute("admin.tenantReconciliation"),
      consoleRoute("admin.releases"),
      consoleRoute("admin.users"),
      consoleRoute("admin.agents"),
      consoleRoute("admin.providerChannels"),
      consoleRoute("admin.modelPool"),
      consoleRoute("admin.relayTasks"),
      consoleRoute("admin.modelRoutes"),
      consoleRoute("admin.modelManagement"),
      consoleRoute("admin.videoFulfillment"),
      consoleRoute("admin.mediaServices"),
      consoleRoute("admin.qualityEnhancement"),
      consoleRoute("admin.portraitAssets"),
      consoleRoute("admin.portraitAssetRelay"),
      consoleRoute("admin.reconciliation"),
      consoleRoute("admin.systemPrompts"),
      consoleRoute("admin.pricingRules"),
      consoleRoute("admin.billingPlans"),
      consoleRoute("admin.redemption"),
      consoleRoute("admin.auditLogs"),
      consoleRoute("admin.requestLogs"),
      consoleRoute("admin.systemSettings"),
    ],
  },

  /* legacy admin URLs remain safe bookmarks and preserve query parameters */
  { path: "/admin", element: <LegacyAdminRedirect /> },
  { path: "/admin/*", element: <LegacyAdminRedirect /> },

  /* legacy system-prompt shortcut: platform configuration moved out of developer tools */
  {
    path: "/developer/prompts",
    element: (
      <RouteGuard meta={{ requiresAuth: true, requiresAdmin: true }}>
        <Navigate to="/fjadmin/system-prompts" replace />
      </RouteGuard>
    ),
  },

  /* ---- console: developer (requiresAuth) ---- */
  {
    path: "/developer",
    element: (
      <RouteGuard meta={{ requiresAuth: true }}>
        <ConsoleLayout />
      </RouteGuard>
    ),
    children: [
      consoleRoute(
        "developer.overview",
        "",
        [
          { index: true, element: <DeveloperBilling /> },
          consoleRoute("developer.api.keys", "api/keys"),
          consoleRoute("developer.api.docs", "api/docs"),
          consoleRoute("developer.api.request", "api/request"),
          consoleRoute("developer.api.tasks", "api/tasks"),
          consoleRoute("developer.api.logs", "api/logs"),
          consoleRoute("developer.api.models", "api/models"),
        ],
      ),
    ],
  },

  /* ---- console: settings (requiresAuth) ---- */
  {
    path: "/settings",
    element: (
      <RouteGuard meta={{ requiresAuth: true }}>
        <ConsoleLayout />
      </RouteGuard>
    ),
    children: [
      { index: true, element: <Navigate to="account" replace /> },
      { path: "profile", element: <Navigate to="basic" replace /> },
      consoleRoute("settings.account"),
      consoleRoute("settings.profile.basic"),
      consoleRoute("settings.profile.authentication"),
      consoleRoute("settings.profile.security"),
      { path: "preferences", element: <Navigate to="/settings/profile/basic" replace /> },
      consoleRoute("settings.about"),
      consoleRoute("settings.apiStatus"),
    ],
  },

  /* ---- short redirects ---- */
  { path: "/project", element: <Navigate to="/workbench/project" replace /> },
  { path: "/create", element: <Navigate to="/workbench/create" replace /> },
  { path: "/library", element: <Navigate to="/workbench/library" replace /> },
  { path: "/task", element: <Navigate to="/workbench/task" replace /> },
  { path: "/director", element: <EntryRedirect to="/workbench/create" /> },
  { path: "/production", element: <Navigate to="/workbench/production" replace /> },
  { path: "/canvas", element: <Navigate to="/workbench/canvas/editor" replace /> },
  { path: "/editor", element: <Navigate to="/workbench/editor" replace /> },
  { path: "/novel", element: <Navigate to="/workbench/novel" replace /> },
  { path: "/script", element: <Navigate to="/workbench/script" replace /> },
  { path: "/scriptAgent", element: <Navigate to="/workbench/generate?mode=agent" replace /> },
  { path: "/cornerScape", element: <Navigate to="/workbench/corner-scape" replace /> },
  { path: "/assets", element: <Navigate to="/workbench/assets" replace /> },

  {
    path: "/feedback/attachments/:id",
    element: <RouteGuard meta={{ requiresAuth: true }}><FeedbackAttachmentPage /></RouteGuard>,
  },

  /* ---- 404 ---- */
  { path: "*", element: <NotFound /> },
];

const rootErrorElement = <RootRouteError />;

export const router = createHashRouter(appRoutes.map((route) => ({
  ...route,
  errorElement: route.errorElement ?? rootErrorElement,
})));
