import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Clock3,
  Copy,
  Crown,
  Ellipsis,
  MailPlus,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import { useAuthStore } from "../../../stores/authStore";
import { canManageWorkspaceMembers } from "../../../utils/permissions";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Drawer,
  FieldGroup,
  FormField,
  Input,
  MetricStrip,
  Select,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useToast,
  type BadgeTone,
  type DataTableColumn,
} from "../../../ui/console";
import "./enterpriseSubaccounts.css";

interface Subaccount {
  userId?: number;
  invitationId?: string;
  name: string;
  email: string;
  role: string;
  status: "active" | "invited" | "disabled";
  permissions: string[];
  permissionsInherited: boolean;
  quotaLimit: number | null;
  rateLimitPerMinute: number | null;
  notes?: string;
  lastActiveAt?: string;
  createdAt?: string;
  updatedAt?: string;
  isWorkspaceOwner: boolean;
  ownerInvariantValid: boolean;
  canManageMembers: boolean;
}

interface InviteForm {
  email: string;
  role: string;
}

interface DetailForm {
  userId: number;
  role: string;
  status: "active" | "disabled";
  permissions: string[];
  permissionsInherited: boolean;
  quotaLimit?: number;
  rateLimitPerMinute?: number;
  notes: string;
}

type FormerOwnerRole = "workspace_admin" | "creator";

interface OwnerTransferForm {
  formerOwnerRole: FormerOwnerRole;
  reason: string;
  idempotencyKey: string;
}

type ConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "default" | "danger";
  onConfirm: () => Promise<void>;
};

const emptyInviteForm: InviteForm = { email: "", role: "creator" };
const emptyDetailForm: DetailForm = {
  userId: 0,
  role: "creator",
  status: "active",
  permissions: [],
  permissionsInherited: false,
  quotaLimit: undefined,
  rateLimitPerMinute: undefined,
  notes: "",
};

function createOwnerTransferForm(): OwnerTransferForm {
  const randomId = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    formerOwnerRole: "workspace_admin",
    reason: "",
    idempotencyKey: `workspace-owner-transfer-${randomId}`,
  };
}

function readJsonList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function formatTime(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toMember(row: Record<string, unknown>): Subaccount {
  const effectiveRole = typeof row.effectiveRole === "string" && row.effectiveRole
    ? row.effectiveRole
    : row.role;
  return {
    userId: row.userId === null || row.userId === undefined ? undefined : Number(row.userId),
    name: String(row.displayName || row.name || row.email || `用户 ${row.userId}`),
    email: String(row.email || ""),
    role: String(effectiveRole || "member"),
    status: row.status === "disabled" ? "disabled" : "active",
    permissions: readJsonList(row.permissions),
    permissionsInherited: row.permissions === null || row.permissions === undefined,
    quotaLimit: row.quotaLimit === null || row.quotaLimit === undefined ? null : Number(row.quotaLimit),
    rateLimitPerMinute: row.rateLimitPerMinute === null || row.rateLimitPerMinute === undefined ? null : Number(row.rateLimitPerMinute),
    notes: String(row.notes || ""),
    lastActiveAt: formatTime(row.lastLoginAt),
    createdAt: formatTime(row.createdAt),
    updatedAt: formatTime(row.updatedAt),
    isWorkspaceOwner: row.isWorkspaceOwner === true,
    ownerInvariantValid: row.ownerInvariantValid !== false,
    canManageMembers: row.canManageMembers === true,
  };
}

function toInvitation(row: Record<string, unknown>): Subaccount {
  return {
    invitationId: String(row.id),
    name: String(row.email || "待加入成员"),
    email: String(row.email || ""),
    role: String(row.role || "creator"),
    status: "invited",
    permissions: [],
    permissionsInherited: true,
    quotaLimit: null,
    rateLimitPerMinute: null,
    notes: String(row.status || ""),
    lastActiveAt: "-",
    createdAt: formatTime(row.createdAt),
    updatedAt: formatTime(row.updatedAt),
    isWorkspaceOwner: false,
    ownerInvariantValid: true,
    canManageMembers: false,
  };
}

const roleProfiles = [
  {
    value: "owner",
    label: "所有者",
    desc: "工作区最高权限",
    permissions: ["workspace:read", "workspace:write", "member:read", "member:write", "api_key:read", "api_key:write", "billing:read", "billing:request:create", "project:read", "project:write", "project:delete", "generation:create", "audit:read"],
  },
  {
    value: "workspace_admin",
    label: "管理员",
    desc: "管理成员、额度、API 和资料",
    permissions: ["workspace:read", "member:read", "member:write", "api_key:read", "api_key:write", "billing:read", "billing:request:create", "project:read", "project:write", "project:delete", "generation:create", "audit:read"],
  },
  {
    value: "creator",
    label: "创作者",
    desc: "使用创作台和生成任务",
    permissions: ["workspace:read", "member:read", "api_key:read", "billing:read", "project:read", "project:write", "generation:create"],
  },
] as const;

const permissionOptions = [
  { value: "workspace:read", label: "查看工作区" },
  { value: "workspace:write", label: "管理工作区" },
  { value: "project:read", label: "查看项目" },
  { value: "project:write", label: "编辑项目" },
  { value: "project:delete", label: "删除项目及资料" },
  { value: "billing:request:create", label: "创建账务申请" },
  { value: "generation:create", label: "发起生成" },
  { value: "api_key:read", label: "查看 API" },
  { value: "api_key:write", label: "管理 API" },
  { value: "billing:read", label: "查看账单" },
  { value: "member:read", label: "查看成员" },
  { value: "member:write", label: "管理成员" },
  { value: "audit:read", label: "查看审计" },
] as const;

const permissionImplications: Record<string, string[]> = {
  "workspace:write": ["workspace:read"],
  "project:write": ["project:read"],
  "api_key:write": ["api_key:read"],
  "member:write": ["member:read"],
};

function normalizePermissionClosure(permissions: readonly string[]) {
  const closed = new Set(permissions);
  for (const [permission, impliedPermissions] of Object.entries(permissionImplications)) {
    if (!closed.has(permission)) continue;
    impliedPermissions.forEach((implied) => closed.add(implied));
  }
  return [...closed];
}

function roleLabel(role: string) {
  return roleProfiles.find((profile) => profile.value === role)?.label || role;
}

function roleTone(role: string): BadgeTone {
  if (role === "owner") return "info";
  if (role === "workspace_admin") return "success";
  return "neutral";
}

function statusLabel(status: Subaccount["status"]) {
  return { active: "已启用", invited: "待加入", disabled: "已停用" }[status];
}

function statusTone(status: Subaccount["status"]): BadgeTone {
  if (status === "active") return "success";
  if (status === "invited") return "warning";
  return "danger";
}

function statusIcon(status: Subaccount["status"]) {
  if (status === "active") return <CheckCircle2 size={14} />;
  if (status === "invited") return <Clock3 size={14} />;
  return <Ban size={14} />;
}

function permissionLabel(permission: string) {
  return permissionOptions.find((option) => option.value === permission)?.label || permission;
}

function avatarText(name: string) {
  return (name || "U").trim().slice(0, 1).toUpperCase();
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function serializeDetailForm(form: DetailForm) {
  return JSON.stringify({ ...form, permissions: [...form.permissions].sort() });
}

export default function EnterpriseSubaccounts() {
  const { toast } = useToast();
  const currentUser = useAuthStore((state) => state.user);
  const currentWorkspace = useAuthStore((state) => state.currentWorkspace);
  const currentWorkspaceId = currentWorkspace?.id ? String(currentWorkspace.id) : "";
  const activeWorkspaceIdRef = useRef(currentWorkspaceId);
  activeWorkspaceIdRef.current = currentWorkspaceId;
  const directoryLoadRef = useRef<{ sequence: number; controller: AbortController | null }>({ sequence: 0, controller: null });
  const canManageMembers = canManageWorkspaceMembers({ user: currentUser, workspace: currentWorkspace });
  const isCurrentWorkspaceOwner = Number(currentUser?.id || 0) > 0
    && Number(currentUser?.id) === Number((currentWorkspace as Record<string, unknown> | null)?.ownerUserId || 0);
  const inviteEmailRef = useRef<HTMLInputElement>(null);
  const inviteSubmittingRef = useRef(false);
  const detailRoleRef = useRef<HTMLSelectElement>(null);
  const ownerTransferRoleRef = useRef<HTMLSelectElement>(null);
  const detailQuotaRef = useRef<HTMLInputElement>(null);
  const detailRateLimitRef = useRef<HTMLInputElement>(null);
  const detailSubmittingRef = useRef(false);
  const copyLinkRef = useRef<HTMLButtonElement>(null);

  const [subaccounts, setSubaccounts] = useState<Subaccount[]>([]);
  const [assignableRoles, setAssignableRoles] = useState<string[]>([]);
  const [subaccountLoading, setSubaccountLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [rowActionKey, setRowActionKey] = useState("");

  const [inviteVisible, setInviteVisible] = useState(false);
  const [inviteForm, setInviteForm] = useState<InviteForm>(emptyInviteForm);
  const [initialInviteForm, setInitialInviteForm] = useState<InviteForm>(emptyInviteForm);
  const [inviteSaving, setInviteSaving] = useState(false);
  const [inviteEmailError, setInviteEmailError] = useState("");
  const [inviteSubmitError, setInviteSubmitError] = useState("");

  const [detailVisible, setDetailVisible] = useState(false);
  const [selectedMember, setSelectedMember] = useState<Subaccount | null>(null);
  const [detailForm, setDetailForm] = useState<DetailForm>(emptyDetailForm);
  const [initialDetailForm, setInitialDetailForm] = useState<DetailForm>(emptyDetailForm);
  const [savingDetail, setSavingDetail] = useState(false);
  const [detailSubmitError, setDetailSubmitError] = useState("");
  const [ownerTransferVisible, setOwnerTransferVisible] = useState(false);
  const [ownerTransferForm, setOwnerTransferForm] = useState<OwnerTransferForm>(
    createOwnerTransferForm,
  );
  const [ownerTransferSaving, setOwnerTransferSaving] = useState(false);
  const [ownerTransferError, setOwnerTransferError] = useState("");

  const [inviteLinkVisible, setInviteLinkVisible] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  const [copyingLink, setCopyingLink] = useState(false);
  const [copyLinkError, setCopyLinkError] = useState("");
  const [discardTarget, setDiscardTarget] = useState<"invite" | "detail" | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const inviteDirty = JSON.stringify(inviteForm) !== JSON.stringify(initialInviteForm);
  const detailDirty = Boolean(
    selectedMember
      && selectedMember.status !== "invited"
      && serializeDetailForm(detailForm) !== serializeDetailForm(initialDetailForm),
  );
  const quotaError = detailForm.quotaLimit !== undefined && detailForm.quotaLimit < 0 ? "额度不能小于 0" : "";
  const rateLimitError = detailForm.rateLimitPerMinute !== undefined && detailForm.rateLimitPerMinute < 0
    ? "请求上限不能小于 0"
    : "";

  useEffect(() => {
    const invite = { ...emptyInviteForm };
    const detail = { ...emptyDetailForm, permissions: [] };
    setSubaccounts([]);
    setLoadError("");
    setRowActionKey("");
    setInviteVisible(false);
    setInviteForm(invite);
    setInitialInviteForm(invite);
    setInviteSaving(false);
    setInviteEmailError("");
    setInviteSubmitError("");
    setDetailVisible(false);
    setSelectedMember(null);
    setDetailForm(detail);
    setInitialDetailForm(detail);
    setSavingDetail(false);
    setDetailSubmitError("");
    setOwnerTransferVisible(false);
    setOwnerTransferForm(createOwnerTransferForm());
    setOwnerTransferSaving(false);
    setOwnerTransferError("");
    setInviteLinkVisible(false);
    setInviteLink("");
    setCopyingLink(false);
    setCopyLinkError("");
    setDiscardTarget(null);
    setConfirmAction(null);

    void loadSubaccounts(currentWorkspaceId);

    return () => {
      directoryLoadRef.current.controller?.abort();
    };
  }, [currentWorkspaceId]);

  async function loadSubaccounts(workspaceId = currentWorkspaceId) {
    if (workspaceId !== activeWorkspaceIdRef.current) return;
    const sequence = directoryLoadRef.current.sequence + 1;
    directoryLoadRef.current.controller?.abort();
    const controller = new AbortController();
    directoryLoadRef.current = { sequence, controller };
    setSubaccountLoading(true);
    setLoadError("");
    try {
      const payload = workspaceId ? { workspaceId } : {};
      const [directory, invitations] = await Promise.all([
        apiPost<{ members?: Record<string, unknown>[]; assignableRoles?: string[] }>("/workspace/subaccounts/list", payload, undefined, { signal: controller.signal }),
        apiPost<Record<string, unknown>[]>("/workspace/invitations/list", payload, undefined, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted || sequence !== directoryLoadRef.current.sequence || workspaceId !== activeWorkspaceIdRef.current) return;
      const pendingInvitations = (Array.isArray(invitations) ? invitations : [])
        .filter((item) => String(item.status || "pending") === "pending")
        .map(toInvitation);
      const memberRows = (Array.isArray(directory?.members) ? directory.members : []).map(toMember);
      setAssignableRoles(Array.isArray(directory?.assignableRoles) ? directory.assignableRoles : []);
      setSubaccounts([...pendingInvitations, ...memberRows]);
    } catch (error) {
      if (controller.signal.aborted || sequence !== directoryLoadRef.current.sequence || workspaceId !== activeWorkspaceIdRef.current) return;
      const message = errorMessage(error, "成员加载失败，请稍后重试。");
      setLoadError(message);
      setSubaccounts([]);
    } finally {
      if (!controller.signal.aborted && sequence === directoryLoadRef.current.sequence && workspaceId === activeWorkspaceIdRef.current) {
        directoryLoadRef.current.controller = null;
        setSubaccountLoading(false);
      }
    }
  }

  const memberMetrics = useMemo(() => [
    { id: "total", label: "全部成员", value: subaccountLoading ? "—" : subaccounts.length, hint: "含待加入邀请" },
    {
      id: "active",
      label: "已启用",
      value: subaccountLoading ? "—" : subaccounts.filter((item) => item.status === "active").length,
      hint: "可使用工作区",
      tone: "positive" as const,
    },
    {
      id: "invited",
      label: "待加入",
      value: subaccountLoading ? "—" : subaccounts.filter((item) => item.status === "invited").length,
      hint: "邀请尚未完成",
      tone: "warning" as const,
    },
    {
      id: "managers",
      label: "管理角色",
      value: subaccountLoading ? "—" : subaccounts.filter((item) => item.isWorkspaceOwner || item.canManageMembers).length,
      hint: "所有者与管理员",
      tone: "info" as const,
    },
  ], [subaccountLoading, subaccounts]);

  function openInvite() {
    if (!canManageMembers) return;
    inviteSubmittingRef.current = false;
    const next = { ...emptyInviteForm };
    setInviteForm(next);
    setInitialInviteForm({ ...next });
    setInviteEmailError("");
    setInviteSubmitError("");
    setInviteVisible(true);
  }

  function closeInvite() {
    if (inviteSaving) return;
    setInviteVisible(false);
    setInviteEmailError("");
    setInviteSubmitError("");
  }

  function requestInviteCancel() {
    if (inviteDirty) setDiscardTarget("invite");
    else closeInvite();
  }

  async function submitInvite() {
    if (inviteSubmittingRef.current || inviteSaving || !canManageMembers) return;
    const email = inviteForm.email.trim();
    if (!email) {
      setInviteEmailError("请输入成员邮箱。");
      inviteEmailRef.current?.focus();
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setInviteEmailError("请输入有效的邮箱地址。");
      inviteEmailRef.current?.focus();
      return;
    }

    const operationWorkspaceId = currentWorkspaceId;
    inviteSubmittingRef.current = true;
    setInviteSaving(true);
    setInviteEmailError("");
    setInviteSubmitError("");
    try {
      const data = await apiPostWithStepUp<{ inviteUrl?: string; url?: string }>("/workspace/invitations/create", {
        workspaceId: operationWorkspaceId || undefined,
        email,
        role: inviteForm.role,
      }, "workspace.member.manage");
      if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
      setInviteVisible(false);
      setInviteLink(String(data.inviteUrl || data.url || ""));
      setCopyLinkError("");
      setInviteLinkVisible(true);
      toast({ title: "邀请链接已创建", tone: "success" });
      await loadSubaccounts(operationWorkspaceId);
    } catch (error) {
      if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
      const message = errorMessage(error, "邀请创建失败，请检查邮箱和权限后重试。");
      setInviteSubmitError(message);
    } finally {
      inviteSubmittingRef.current = false;
      if (operationWorkspaceId === activeWorkspaceIdRef.current) setInviteSaving(false);
    }
  }

  function openMemberDetail(row: Subaccount) {
    detailSubmittingRef.current = false;
    const rolePermissions = roleProfiles.find((item) => item.value === row.role)?.permissions || [];
    const next: DetailForm = {
      userId: row.userId || 0,
      role: row.role,
      status: row.status === "disabled" ? "disabled" : "active",
      permissions: normalizePermissionClosure(row.permissionsInherited ? rolePermissions : row.permissions),
      permissionsInherited: row.permissionsInherited,
      quotaLimit: row.quotaLimit ?? undefined,
      rateLimitPerMinute: row.rateLimitPerMinute ?? undefined,
      notes: row.notes || "",
    };
    setSelectedMember(row);
    setDetailForm(next);
    setInitialDetailForm({ ...next, permissions: [...next.permissions] });
    setDetailSubmitError("");
    setDetailVisible(true);
  }

  function closeDetail() {
    if (savingDetail) return;
    setDetailVisible(false);
    setSelectedMember(null);
    setDetailSubmitError("");
  }

  function requestDetailCancel() {
    if (detailDirty) setDiscardTarget("detail");
    else closeDetail();
  }

  async function submitDetail() {
    if (
      !selectedMember
      || selectedMember.isWorkspaceOwner
      || !selectedMember.ownerInvariantValid
      || detailSubmittingRef.current
      || savingDetail
      || !canManageMembers
    ) return;
    if (!detailForm.userId) {
      setDetailSubmitError("缺少用户 ID，无法保存成员配置。");
      return;
    }
    if (quotaError || rateLimitError) {
      setDetailSubmitError("请先修正额度与限速设置。");
      (quotaError ? detailQuotaRef : detailRateLimitRef).current?.focus();
      return;
    }

    const operationWorkspaceId = currentWorkspaceId;
    detailSubmittingRef.current = true;
    setSavingDetail(true);
    setDetailSubmitError("");
    try {
      await apiPostWithStepUp("/workspace/subaccounts/update", {
        workspaceId: operationWorkspaceId || undefined,
        userId: detailForm.userId,
        ...(canEditSelectedRole ? { role: detailForm.role } : {}),
        ...(canEditSelectedAuthority ? {
          status: detailForm.status,
          quotaLimit: detailForm.quotaLimit ?? null,
          rateLimitPerMinute: detailForm.rateLimitPerMinute ?? null,
        } : {}),
        notes: detailForm.notes.trim() || null,
      }, "workspace.member.manage");
      if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
      setInitialDetailForm({ ...detailForm, permissions: [...detailForm.permissions] });
      setDetailVisible(false);
      setSelectedMember(null);
      toast({ title: "成员配置已保存", tone: "success" });
      await loadSubaccounts(operationWorkspaceId);
    } catch (error) {
      if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
      const message = errorMessage(error, "成员配置保存失败，请稍后重试。");
      setDetailSubmitError(message);
    } finally {
      detailSubmittingRef.current = false;
      if (operationWorkspaceId === activeWorkspaceIdRef.current) setSavingDetail(false);
    }
  }

  function openOwnerTransfer() {
    if (
      !isCurrentWorkspaceOwner
      || !selectedMember?.userId
      || selectedMember.isWorkspaceOwner
      || selectedMember.status !== "active"
      || !selectedMember.ownerInvariantValid
    ) return;
    setOwnerTransferForm(createOwnerTransferForm());
    setOwnerTransferError("");
    setOwnerTransferVisible(true);
  }

  function closeOwnerTransfer() {
    if (ownerTransferSaving) return;
    setOwnerTransferVisible(false);
    setOwnerTransferError("");
  }

  async function submitOwnerTransfer() {
    if (
      ownerTransferSaving
      || !isCurrentWorkspaceOwner
      || !selectedMember?.userId
      || selectedMember.isWorkspaceOwner
      || selectedMember.status !== "active"
      || !selectedMember.ownerInvariantValid
      || !currentWorkspaceId
    ) return;

    setOwnerTransferSaving(true);
    setOwnerTransferError("");
    try {
      await apiPostWithStepUp("/workspace/owner/transfer", {
        workspaceId: currentWorkspaceId,
        targetUserId: selectedMember.userId,
        formerOwnerRole: ownerTransferForm.formerOwnerRole,
        idempotencyKey: ownerTransferForm.idempotencyKey,
        reason: ownerTransferForm.reason.trim() || null,
      }, "workspace.owner.transfer");
      setOwnerTransferVisible(false);
      setDetailVisible(false);
      toast({
        title: "工作区所有权已转移",
        message: "双方旧会话已安全失效，请重新登录确认新角色。",
        tone: "success",
      });
      // The API deliberately revokes both principals. Clear the now-stale
      // browser session immediately so RouteGuard takes the former owner back
      // to login instead of showing a misleading permission error.
      useAuthStore.getState().logout();
    } catch (error) {
      setOwnerTransferError(errorMessage(error, "所有权转移失败，请确认目标成员状态后重试。"));
    } finally {
      setOwnerTransferSaving(false);
    }
  }

  function revokeInvitation(row: Subaccount) {
    if (!canManageMembers) return;
    if (!row.invitationId) {
      toast({ title: "缺少邀请 ID，无法撤销邀请", tone: "danger" });
      return;
    }
    const operationWorkspaceId = currentWorkspaceId;
    setConfirmAction({
      title: "撤销邀请链接",
      description: `撤销 ${row.email} 的邀请后，原链接将无法继续用于加入当前工作区。`,
      confirmLabel: "撤销邀请",
      tone: "danger",
      onConfirm: async () => {
        await apiPostWithStepUp("/workspace/invitations/revoke", {
          workspaceId: operationWorkspaceId || undefined,
          invitationId: row.invitationId,
        }, "workspace.member.manage");
        if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
        toast({ title: "邀请已撤销", tone: "success" });
        await loadSubaccounts(operationWorkspaceId);
      },
    });
  }

  function disableMember(row: Subaccount) {
    if (!canManageMembers) return;
    if (!row.userId) {
      toast({ title: "缺少用户 ID，无法停用成员", tone: "danger" });
      return;
    }
    const operationWorkspaceId = currentWorkspaceId;
    setConfirmAction({
      title: "停用成员",
      description: `停用 ${row.name} 后，该成员将无法继续使用当前工作区能力。`,
      confirmLabel: "停用成员",
      tone: "danger",
      onConfirm: async () => {
        await apiPostWithStepUp("/workspace/subaccounts/disable", {
          workspaceId: operationWorkspaceId || undefined,
          userId: row.userId,
        }, "workspace.member.manage");
        if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
        toast({ title: "成员已停用", tone: "success" });
        await loadSubaccounts(operationWorkspaceId);
      },
    });
  }

  async function enableMember(row: Subaccount) {
    if (!row.userId || rowActionKey || !canManageMembers) return;
    const operationWorkspaceId = currentWorkspaceId;
    const actionKey = `enable-${row.userId}`;
    setRowActionKey(actionKey);
    try {
      await apiPostWithStepUp("/workspace/subaccounts/update", {
        workspaceId: operationWorkspaceId || undefined,
        userId: row.userId,
        status: "active",
      }, "workspace.member.manage");
      if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
      toast({ title: "成员已启用", tone: "success" });
      await loadSubaccounts(operationWorkspaceId);
    } catch (error) {
      if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
      const message = errorMessage(error, "成员启用失败，请稍后重试。");
      toast({ title: message, tone: "danger" });
    } finally {
      if (operationWorkspaceId === activeWorkspaceIdRef.current) setRowActionKey("");
    }
  }

  async function copyInviteLink() {
    if (copyingLink) return;
    const operationWorkspaceId = currentWorkspaceId;
    setCopyingLink(true);
    setCopyLinkError("");
    try {
      if (!navigator.clipboard) throw new Error("当前浏览器未授权访问剪贴板。");
      await navigator.clipboard.writeText(inviteLink);
      if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
      toast({ title: "邀请链接已复制", tone: "success" });
    } catch (error) {
      if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
      setCopyLinkError(errorMessage(error, "复制失败，请手动选择链接。"));
    } finally {
      if (operationWorkspaceId === activeWorkspaceIdRef.current) setCopyingLink(false);
    }
  }

  function discardFormChanges() {
    const target = discardTarget;
    setDiscardTarget(null);
    if (target === "invite") closeInvite();
    if (target === "detail") closeDetail();
  }

  async function runConfirmAction() {
    if (!confirmAction) return false;
    await confirmAction.onConfirm();
    return true;
  }

  const columns: DataTableColumn<Subaccount>[] = [
    {
      id: "member",
      header: "成员",
      priority: "primary",
      minWidth: "180px",
      sortable: true,
      sortValue: (row) => row.name,
      cell: (row) => (
        <div className="enterpriseMembersIdentity">
          <span className="enterpriseMembersAvatar" aria-hidden="true">{avatarText(row.name)}</span>
          <span className="enterpriseMembersIdentityCopy">
            <strong>{row.name}</strong>
            <Tooltip>
              <TooltipTrigger className="enterpriseMembersEmail">{row.email || "未提供邮箱"}</TooltipTrigger>
              <TooltipContent align="start">{row.email || "未提供邮箱"}</TooltipContent>
            </Tooltip>
          </span>
        </div>
      ),
    },
    {
      id: "role",
      header: "角色",
      priority: "secondary",
      minWidth: "110px",
      sortable: true,
      sortValue: (row) => row.role,
      cell: (row) => <Badge tone={roleTone(row.role)} icon={<ShieldCheck size={14} />}>{roleLabel(row.role)}</Badge>,
    },
    {
      id: "status",
      header: "状态",
      priority: "secondary",
      minWidth: "110px",
      sortable: true,
      sortValue: (row) => row.status,
      cell: (row) => <Badge tone={statusTone(row.status)} icon={statusIcon(row.status)}>{statusLabel(row.status)}</Badge>,
    },
    {
      id: "quota",
      header: "额度 / 限速",
      priority: "detail",
      minWidth: "150px",
      cell: (row) => (
        <span className="enterpriseMembersStackedValue">
          <strong>{row.quotaLimit === null ? "额度不限制" : `${row.quotaLimit.toLocaleString()} / 月`}</strong>
          <span>{row.rateLimitPerMinute === null ? "不限速" : `${row.rateLimitPerMinute} 次 / 分`}</span>
        </span>
      ),
    },
    {
      id: "permissions",
      header: "权限策略",
      priority: "detail",
      minWidth: "190px",
      cell: (row) => row.permissionsInherited ? (
        <span className="enterpriseMembersMuted">角色预设</span>
      ) : (
        <Badge tone="warning">自定义权限按无权限处理</Badge>
      ),
    },
    {
      id: "lastActive",
      header: "最近活跃",
      priority: "detail",
      minWidth: "150px",
      sortable: true,
      sortValue: (row) => row.lastActiveAt,
      accessor: (row) => row.lastActiveAt || "-",
    },
    {
      id: "actions",
      header: (
        <span>
          <span aria-hidden="true">操作</span>
          <span className="consoleSrOnly">行操作</span>
        </span>
      ),
      headerLabel: "行操作",
      priority: "primary",
      hideable: false,
      minWidth: "144px",
      cell: (row) => {
        const isSelf = Number(row.userId) === Number(currentUser?.id || 0);
        const hasMoreAction = canManageMembers
          && row.ownerInvariantValid
          && (row.status === "invited" || (
            !row.isWorkspaceOwner
            && !isSelf
            && (isCurrentWorkspaceOwner || !row.canManageMembers)
            && (row.status === "disabled" || row.status === "active")
          ));
        const enabling = rowActionKey === `enable-${row.userId}`;
        return (
          <div className="enterpriseMembersRowActions">
            <Button
              variant="secondary"
              icon={<Settings2 size={16} />}
              aria-label={`${row.status === "invited" ? "查看邀请" : canManageMembers ? "管理成员" : "查看成员"}：${row.name}`}
              onClick={() => openMemberDetail(row)}
            >
              {row.status === "invited" || !canManageMembers ? "查看" : "管理"}
            </Button>
            {hasMoreAction ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={(
                    <Button
                      variant="secondary"
                      size="compact"
                      icon={<Ellipsis aria-hidden="true" size={17} />}
                      aria-label={`更多操作：${row.name}`}
                    />
                  )}
                />
                <DropdownMenuContent align="end" aria-label={`${row.name} 的更多操作`}>
                  {row.status === "invited" ? (
                    <DropdownMenuItem tone="danger" onClick={() => revokeInvitation(row)}>
                      <Ban aria-hidden="true" size={16} />撤销邀请
                    </DropdownMenuItem>
                  ) : row.status === "disabled" ? (
                    <DropdownMenuItem disabled={Boolean(rowActionKey)} onClick={() => void enableMember(row)}>
                      <CheckCircle2 aria-hidden="true" size={16} />{enabling ? "启用中…" : "启用成员"}
                    </DropdownMenuItem>
                  ) : !row.isWorkspaceOwner ? (
                    <DropdownMenuItem tone="danger" onClick={() => disableMember(row)}>
                      <Ban aria-hidden="true" size={16} />停用成员
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        );
      },
    },
  ];

  const selectedIsInvitation = selectedMember?.status === "invited";
  const selectedIsOwner = !selectedIsInvitation && Boolean(selectedMember?.isWorkspaceOwner);
  const canEditSelectedMember = canManageMembers
    && !selectedIsOwner
    && Number(selectedMember?.userId) !== Number(currentUser?.id)
    && selectedMember?.ownerInvariantValid !== false;
  const canEditSelectedAuthority = canEditSelectedMember
    && (isCurrentWorkspaceOwner || !selectedMember?.canManageMembers);
  const canEditSelectedRole = canEditSelectedAuthority;
  const allowedRoleProfiles = roleProfiles.filter(role => assignableRoles.includes(role.value));
  const canTransferToSelected = isCurrentWorkspaceOwner
    && canEditSelectedMember
    && selectedMember?.status === "active"
    && Boolean(selectedMember?.userId);

  return (
    <section className="enterpriseMembers" aria-labelledby="enterprise-members-directory-title">
      <div className="enterpriseMembersHeader">
        <div>
          <h2 id="enterprise-members-directory-title">成员目录</h2>
          <p>集中管理角色、状态、额度、API 权限和工作区访问范围。</p>
        </div>
        <Button icon={<MailPlus size={18} />} disabled={!canManageMembers} onClick={openInvite}>邀请成员</Button>
      </div>


      <MetricStrip metrics={memberMetrics} ariaLabel="成员概览" />

      <Accordion className="enterpriseMembersRoleGuide">
        <AccordionItem value="workspace-role-permission-baseline">
          <AccordionTrigger>
            <span><ShieldCheck aria-hidden="true" size={18} />角色权限基线</span>
            <span className="enterpriseMembersRoleGuideHint">查看默认权限预设</span>
          </AccordionTrigger>
          <AccordionContent contentClassName="enterpriseMembersRoleGuideContent">
            <div className="enterpriseMembersRoleGrid">
              {roleProfiles.map((role) => (
                <article key={role.value}>
                  <header><Badge tone={roleTone(role.value)}>{role.label}</Badge><span>{role.desc}</span></header>
                  <p>{role.permissions.map(permissionLabel).join(" / ")}</p>
                </article>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <DataTable
        className="enterpriseMembersTable"
        rows={subaccounts}
        columns={columns}
        getRowId={(row, index) => row.invitationId || row.userId || `${row.email}-${index}`}
        ariaLabel="工作区成员列表"
        caption="工作区成员、邀请、角色、状态与访问配置"
        loading={subaccountLoading}
        error={loadError || undefined}
        onRetry={() => void loadSubaccounts()}
        emptyState="暂无成员；邀请第一位成员开始协作。"
        onRowClick={openMemberDetail}
        getRowAriaLabel={(row) => `${row.status === "invited" ? "查看邀请" : canManageMembers ? "管理成员" : "查看成员"} ${row.name}`}
        defaultPageSize={20}
        defaultSort={{ columnId: "member", direction: "ascending" }}
      />

      <Dialog
        open={inviteVisible}
        title="邀请成员"
        description="创建一次性邀请链接，并为成员选择初始角色。"
        size="md"
        dirty={inviteDirty}
        loading={inviteSaving}
        initialFocusRef={inviteEmailRef}
        closeLabel="关闭邀请成员对话框"
        onOpenChange={(open) => { if (!open) closeInvite(); }}
        footer={(
          <div className="enterpriseMembersOverlayActions">
            <Button variant="secondary" disabled={inviteSaving} onClick={requestInviteCancel}>取消</Button>
            <Button type="submit" form="enterprise-member-invite-form" icon={<MailPlus size={17} />} loading={inviteSaving}>发送邀请</Button>
          </div>
        )}
      >
        <form
          id="enterprise-member-invite-form"
          className="enterpriseMembersFormStack"
          onSubmit={(event) => {
            event.preventDefault();
            void submitInvite();
          }}
        >
          <FormField label="成员邮箱" required optionalLabel={null} error={inviteEmailError || undefined} help="邀请链接仅在本次创建成功后显示。">
            <Input
              ref={inviteEmailRef}
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="ops@example.com"
              value={inviteForm.email}
              onChange={(event) => {
                const email = event.currentTarget.value;
                setInviteForm((current) => ({ ...current, email }));
                setInviteEmailError("");
                setInviteSubmitError("");
              }}
            />
          </FormField>
          <FormField label="初始角色" required optionalLabel={null} help={roleProfiles.find((role) => role.value === inviteForm.role)?.desc}>
            <Select
              value={inviteForm.role}
              onChange={(event) => {
                const role = event.currentTarget.value;
                setInviteForm((current) => ({ ...current, role }));
                setInviteSubmitError("");
              }}
            >
              {allowedRoleProfiles.map((role) => (
                <option key={role.value} value={role.value}>{role.label}</option>
              ))}
            </Select>
          </FormField>
          {inviteSubmitError ? <Alert tone="danger" title="邀请创建失败">{inviteSubmitError}</Alert> : null}
        </form>
      </Dialog>

      <Drawer
        open={detailVisible && Boolean(selectedMember)}
        title={selectedIsInvitation ? "邀请详情" : canEditSelectedMember ? "成员精细管理" : "成员详情"}
        description={selectedMember ? `${selectedMember.name} · ${selectedMember.email || "未提供邮箱"}` : undefined}
        size="min(640px, 100vw)"
        dirty={detailDirty}
        loading={savingDetail}
        initialFocusRef={selectedIsInvitation || selectedIsOwner ? undefined : detailRoleRef}
        closeLabel={selectedIsInvitation ? "关闭邀请详情" : "关闭成员精细管理"}
        onOpenChange={(open) => { if (!open) closeDetail(); }}
        footer={selectedIsInvitation ? (
          <div className="enterpriseMembersOverlayActions">
            <Button variant="secondary" onClick={closeDetail}>关闭</Button>
          </div>
        ) : canEditSelectedMember ? (
          <div className="enterpriseMembersOverlayActions">
            {canTransferToSelected ? (
              <Button
                type="button"
                variant="danger"
                icon={<Crown aria-hidden="true" size={16} />}
                disabled={savingDetail}
                onClick={openOwnerTransfer}
              >
                转移所有权
              </Button>
            ) : null}
            <Button variant="secondary" disabled={savingDetail} onClick={requestDetailCancel}>取消</Button>
            <Button type="submit" form="enterprise-member-detail-form" loading={savingDetail} disabled={!canEditSelectedMember || !detailDirty || Boolean(quotaError || rateLimitError)}>
              保存配置
            </Button>
          </div>
        ) : (
          <div className="enterpriseMembersOverlayActions"><Button variant="secondary" onClick={closeDetail}>关闭</Button></div>
        )}
      >
        {selectedMember ? (
          <form
            id="enterprise-member-detail-form"
            className="enterpriseMembersFormStack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!selectedIsInvitation && canEditSelectedMember) void submitDetail();
            }}
          >
            <div className="enterpriseMembersIdentityCard">
              <span className="enterpriseMembersIdentityAvatar" aria-hidden="true">{avatarText(selectedMember.name)}</span>
              <span><strong>{selectedMember.name}</strong><small>{selectedMember.email || "未提供邮箱"}</small></span>
              <Badge tone={statusTone(selectedMember.status)} icon={statusIcon(selectedMember.status)}>{statusLabel(selectedMember.status)}</Badge>
            </div>

            {selectedIsInvitation ? (
              <dl className="enterpriseMembersDetailList">
                <div><dt>邀请邮箱</dt><dd>{selectedMember.email || "-"}</dd></div>
                <div><dt>初始角色</dt><dd>{roleLabel(selectedMember.role)}</dd></div>
                <div><dt>邀请状态</dt><dd>{statusLabel(selectedMember.status)}</dd></div>
                <div><dt>创建时间</dt><dd>{selectedMember.createdAt || "-"}</dd></div>
              </dl>
            ) : (
              <>
                {selectedIsOwner ? (
                  <Alert tone="info" title="所有者需通过独立转移流程管理">
                    通用成员配置不会停用、降级或替换工作区所有者。
                  </Alert>
                ) : null}
                <FieldGroup legend="身份与状态" description="角色变更会同步载入对应的默认权限预设。" disabled={savingDetail || !canEditSelectedMember}>
                  <div className="enterpriseMembersFormGrid">
                    <FormField label="角色" required optionalLabel={null}>
                      <Select
                        ref={detailRoleRef}
                        value={detailForm.role}
                        disabled={!canEditSelectedRole || savingDetail}
                        onChange={(event) => {
                          const role = event.currentTarget.value;
                          setDetailForm((current) => ({
                            ...current,
                            role,
                          }));
                          setDetailSubmitError("");
                        }}
                      >
                        {(canEditSelectedRole ? allowedRoleProfiles : roleProfiles.filter(role => role.value === detailForm.role)).map((role) => (
                          <option key={role.value} value={role.value}>
                            {role.label}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <FormField label="账号状态" required optionalLabel={null}>
                      <Select
                        value={detailForm.status}
                        disabled={!canEditSelectedAuthority || savingDetail}
                        onChange={(event) => {
                          const status = event.currentTarget.value as DetailForm["status"];
                          setDetailForm((current) => ({ ...current, status }));
                          setDetailSubmitError("");
                        }}
                      >
                        <option value="active">启用</option>
                        <option value="disabled">停用</option>
                      </Select>
                    </FormField>
                  </div>
                </FieldGroup>

                <FieldGroup legend="额度与限速" description="留空表示不单独限制，继续采用工作区级策略。" disabled={savingDetail || !canEditSelectedMember}>
                  <div className="enterpriseMembersFormGrid">
                    <FormField label="月度额度上限" error={quotaError || undefined} help="单位为当前工作区计费额度。">
                      <Input
                        ref={detailQuotaRef}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        placeholder="不限制"
                        value={detailForm.quotaLimit ?? ""}
                        disabled={!canEditSelectedAuthority || savingDetail}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setDetailForm((current) => ({ ...current, quotaLimit: value ? Number(value) : undefined }));
                          setDetailSubmitError("");
                        }}
                      />
                    </FormField>
                    <FormField label="每分钟请求上限" error={rateLimitError || undefined} help="用于限制该成员的 API 请求频率。">
                      <Input
                        ref={detailRateLimitRef}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        placeholder="不限制"
                        value={detailForm.rateLimitPerMinute ?? ""}
                        disabled={!canEditSelectedAuthority || savingDetail}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setDetailForm((current) => ({ ...current, rateLimitPerMinute: value ? Number(value) : undefined }));
                          setDetailSubmitError("");
                        }}
                      />
                    </FormField>
                  </div>
                </FieldGroup>

                <Alert tone="info" title="v0.0.7 使用角色权限预设">
                  当前版本不开放成员级自定义授权；已配置的自定义权限按无权限处理并保留原值。
                </Alert>

                <FieldGroup legend="运营备注" description="记录临时额度、职责范围或内部交接信息。" disabled={savingDetail || !canEditSelectedMember}>
                  <FormField label="备注" optionalLabel="可选">
                    <textarea
                      className="enterpriseMembersTextarea"
                      rows={4}
                      value={detailForm.notes}
                      placeholder="例如：市场团队临时额度"
                      onChange={(event) => {
                        const notes = event.currentTarget.value;
                        setDetailForm((current) => ({ ...current, notes }));
                        setDetailSubmitError("");
                      }}
                    />
                  </FormField>
                </FieldGroup>

                <dl className="enterpriseMembersMetadata">
                  <div><dt>最近活跃</dt><dd>{selectedMember.lastActiveAt || "-"}</dd></div>
                  <div><dt>加入时间</dt><dd>{selectedMember.createdAt || "-"}</dd></div>
                  <div><dt>最后更新</dt><dd>{selectedMember.updatedAt || "-"}</dd></div>
                </dl>
                {detailSubmitError ? <Alert tone="danger" title="成员配置未保存">{detailSubmitError}</Alert> : null}
              </>
            )}
          </form>
        ) : null}
      </Drawer>

      <Dialog
        open={ownerTransferVisible && Boolean(selectedMember)}
        title="转移工作区所有权"
        description={selectedMember
          ? `将唯一所有者身份转移给 ${selectedMember.name}`
          : undefined}
        size="md"
        loading={ownerTransferSaving}
        initialFocusRef={ownerTransferRoleRef}
        closeLabel="关闭所有权转移对话框"
        onOpenChange={(open) => { if (!open) closeOwnerTransfer(); }}
        footer={(
          <div className="enterpriseMembersOverlayActions">
            <Button variant="secondary" disabled={ownerTransferSaving} onClick={closeOwnerTransfer}>取消</Button>
            <Button
              type="submit"
              form="enterprise-owner-transfer-form"
              variant="danger"
              icon={<Crown aria-hidden="true" size={16} />}
              loading={ownerTransferSaving}
            >
              确认转移
            </Button>
          </div>
        )}
      >
        <form
          id="enterprise-owner-transfer-form"
          className="enterpriseMembersFormStack"
          onSubmit={(event) => {
            event.preventDefault();
            void submitOwnerTransfer();
          }}
        >
          <Alert tone="warning" title="这是单一所有者变更">
            完成后不会出现第二个所有者；当前账号会降级为所选角色，双方旧会话与工作区 API Key 会立即失效。
          </Alert>
          <FormField label="当前所有者转移后的角色" required optionalLabel={null}>
            <Select
              ref={ownerTransferRoleRef}
              value={ownerTransferForm.formerOwnerRole}
              onChange={(event) => {
                const formerOwnerRole = event.currentTarget.value as FormerOwnerRole;
                setOwnerTransferForm((current) => ({
                  ...current,
                  formerOwnerRole,
                }));
                setOwnerTransferError("");
              }}
            >
              {roleProfiles
                .filter((role): role is (typeof roleProfiles)[number] & { value: FormerOwnerRole } => role.value !== "owner")
                .map((role) => (
                  <option key={role.value} value={role.value}>{role.label}</option>
                ))}
            </Select>
          </FormField>
          <FormField label="交接说明" optionalLabel="可选" help="说明会写入审计日志，不会授予额外权限。">
            <textarea
              className="enterpriseMembersTextarea"
              rows={3}
              maxLength={500}
              value={ownerTransferForm.reason}
              placeholder="例如：团队负责人交接"
              onChange={(event) => {
                const reason = event.currentTarget.value;
                setOwnerTransferForm((current) => ({ ...current, reason }));
                setOwnerTransferError("");
              }}
            />
          </FormField>
          {ownerTransferError ? <Alert tone="danger" title="所有权转移失败">{ownerTransferError}</Alert> : null}
        </form>
      </Dialog>

      <Dialog
        open={inviteLinkVisible}
        title="邀请链接已创建"
        description="请通过可信渠道发送给成员；链接只在本次响应中显示。"
        size="md"
        initialFocusRef={inviteLink ? copyLinkRef : undefined}
        closeLabel="关闭邀请链接对话框"
        onOpenChange={(open) => { if (!open && !copyingLink) setInviteLinkVisible(false); }}
        footer={(
          <div className="enterpriseMembersOverlayActions">
            <Button ref={copyLinkRef} icon={<Copy size={17} />} loading={copyingLink} disabled={!inviteLink} onClick={() => void copyInviteLink()}>
              复制邀请链接
            </Button>
            <Button variant="secondary" disabled={copyingLink} onClick={() => setInviteLinkVisible(false)}>完成</Button>
          </div>
        )}
      >
        <div className="enterpriseMembersFormStack">
          <FormField label="邀请链接" optionalLabel={null} help="若自动复制不可用，可手动选择并复制。">
            <textarea readOnly rows={3} value={inviteLink} />
          </FormField>
          {copyLinkError ? <Alert tone="danger" title="邀请链接复制失败">{copyLinkError}</Alert> : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(discardTarget)}
        title="放弃未保存的更改？"
        description="关闭后，本次尚未保存的表单内容将丢失。"
        confirmLabel="放弃更改"
        tone="danger"
        onCancel={() => setDiscardTarget(null)}
        onConfirm={() => {
          discardFormChanges();
          return true;
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={confirmAction?.title || "确认操作"}
        description={confirmAction?.description}
        confirmLabel={confirmAction?.confirmLabel || "确认"}
        tone={confirmAction?.tone}
        onCancel={() => {
          setConfirmAction(null);
        }}
        onConfirm={runConfirmAction}
        onConfirmError={(error) => toast({ title: errorMessage(error, "操作失败，请稍后重试。"), tone: "danger" })}
      />
    </section>
  );
}
