import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Copy,
  Download,
  Eye,
  KeyRound,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  RotateCw,
  Trash2,
} from "lucide-react";
import { apiPost, readApiSettings, toApiErrorView } from "../../../api/http";
import { apiPostWithStepUp, stepUpRequestOptions, withStepUpProofs } from "../../../api/stepUp";
import { useAuthStore } from "../../../stores/authStore";
import { useAuthorizedProjectSelection } from "../../../hooks/useAuthorizedProjectSelection";
import { canManageDeveloperApiKeys } from "../../../utils/permissions";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  Badge,
  Button,
  Checkbox,
  CodeEditor,
  ConfirmDialog,
  DataTable,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Drawer,
  FieldGroup,
  FilterBar,
  FormField,
  Input,
  NumberInput,
  Select,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useToast,
  type DataTableColumn,
} from "../../../ui/console";
import {
  buildApiKeyConnectionInfo,
  buildTextApiKeyConnectionInfo,
  resolveApiKeyConnectionModel,
  resolveApiKeyTextConnectionModel,
  sanitizeApiKeyConnectionEndpoint,
} from "./apiKeyConnectionInfo";
import "./apiKeyManagement.css";
import ToolConnectionSetup from "./ToolConnectionSetup";
import { TOOL_READ_PERMISSIONS, applyToolPermissionPreset, toolPermissionPreset, buildToolConnectionConfig } from "./toolConnectionConfig";

type ApiKeyStatus = "active" | "rotating" | "disabled";
type DrawerMode = "create" | "edit";

interface RawApiKeyRow {
  id: string;
  name?: string;
  key?: string;
  keyPrefix?: string;
  maskedKey?: string;
  scope?: string;
  workspaceId?: string | null;
  permissions?: string[];
  quotaUnit?: string;
  quotaLimit?: number | null;
  quotaUsed?: number | null;
  quotaReserved?: number | null;
  rateLimitPerMinute?: number | null;
  expiresAt?: number | null;
  modelAllowlist?: string[];
  ipAllowlist?: string[];
  lastUsedAt?: number | string | null;
  disabled?: number | boolean;
  revokedAt?: number | string | null;
  createTime?: number | string | null;
  updateTime?: number | string | null;
  apiKey?: string;
}

interface ApiKeyItem {
  id: string;
  name: string;
  status: ApiKeyStatus;
  statusLabel: "已启用" | "已停用" | "已过期" | "已撤销";
  prefix: string;
  raw: RawApiKeyRow;
  quotaUnit: "gu_micros" | "request";
  quotaLimit: number | null;
  quotaUsed: number;
  quotaReserved: number;
  modelAllowlist: string[];
  ipAllowlist: string[];
  permissions: string[];
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  rateLimitPerMinute: number | null;
}

interface ApiKeyForm {
  name: string;
  unlimitedQuota: boolean;
  quotaLimit: number;
  rateLimitPerMinute: number;
  expiryMode: "never" | "custom";
  expiryPreset: string;
  expiresAt: number | null;
  modelAllowlist: string[];
  permissions: string[];
  ipAllowlistText: string;
}

export const API_KEY_PUBLIC_ENDPOINT_TYPES = [
  "text",
  "embedding",
  "multimodal_embedding",
  "transcription",
  "tts",
  "rerank",
  "video_generation",
  "image_generation",
] as const;

export type ApiKeyPublicEndpointType = (typeof API_KEY_PUBLIC_ENDPOINT_TYPES)[number];

export type ApiKeyModelOption = {
  selectionKey: string;
  label: string;
  value: string;
  endpointType: ApiKeyPublicEndpointType;
  status: "active";
};

export type ApiKeyModelCatalogParseResult =
  | { state: "ready"; workspaceId: string; options: ApiKeyModelOption[] }
  | { state: "empty"; workspaceId: string; options: [] }
  | {
    state: "contract-conflict";
    workspaceId: string;
    options: ApiKeyModelOption[];
    conflictingModels: string[];
  }
  | { state: "malformed"; options: [] };

type ApiKeyModelCatalogState =
  | "idle"
  | "loading"
  | ApiKeyModelCatalogParseResult["state"]
  | "error";

export const API_KEY_MODEL_ALLOWLIST_ENDPOINT_CONTRACT_CR =
  "CR-T9-MODEL-ALLOWLIST-ENDPOINT-TUPLE：共享 API Key 契约需将 modelAllowlist:string[] 升级为 { model, endpointType }[]，并同步读写、鉴权与迁移；升级前遇到同名跨接口模型时前端拒绝保存。";

const API_KEY_PUBLIC_ENDPOINT_SET = new Set<string>(API_KEY_PUBLIC_ENDPOINT_TYPES);
const MISSING_CATALOG_PROPERTY = Symbol("missing-catalog-property");

function readOwnDataProperty(value: unknown, key: PropertyKey): unknown | typeof MISSING_CATALOG_PROPERTY {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return MISSING_CATALOG_PROPERTY;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : MISSING_CATALOG_PROPERTY;
  } catch {
    return MISSING_CATALOG_PROPERTY;
  }
}

function readCatalogArray(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = readOwnDataProperty(value, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 2_000) {
      return null;
    }
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = readOwnDataProperty(value, String(index));
      if (item === MISSING_CATALOG_PROPERTY) return null;
      items.push(item);
    }
    return items;
  } catch {
    return null;
  }
}

function isCatalogArray(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return true;
  }
}

function isBoundedCatalogText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isApiKeyPublicEndpointType(value: unknown): value is ApiKeyPublicEndpointType {
  return typeof value === "string" && API_KEY_PUBLIC_ENDPOINT_SET.has(value);
}

export function parseApiKeyModelCatalog(
  payload: unknown,
  expectedWorkspaceId?: string,
): ApiKeyModelCatalogParseResult {
  const responseWorkspaceId = readOwnDataProperty(payload, "workspaceId");
  const rawItems = readOwnDataProperty(payload, "items");
  if (
    !isBoundedCatalogText(responseWorkspaceId, 256)
    || (expectedWorkspaceId && responseWorkspaceId !== expectedWorkspaceId)
  ) {
    return { state: "malformed", options: [] };
  }

  const items = readCatalogArray(rawItems);
  if (!items) return { state: "malformed", options: [] };
  if (!items.length) return { state: "empty", workspaceId: responseWorkspaceId, options: [] };

  const dedup = new Map<string, {
    model: string;
    name: string;
    endpointType: ApiKeyPublicEndpointType;
  }>();
  for (const item of items) {
    if (!item || typeof item !== "object" || isCatalogArray(item)) {
      return { state: "malformed", options: [] };
    }

    const model = readOwnDataProperty(item, "model");
    const name = readOwnDataProperty(item, "name");
    const endpointType = readOwnDataProperty(item, "endpointType");
    const status = readOwnDataProperty(item, "status");
    if (
      !isBoundedCatalogText(model, 256)
      || !isBoundedCatalogText(name, 120)
      || !isApiKeyPublicEndpointType(endpointType)
      || (status !== "active" && status !== "unavailable")
    ) {
      return { state: "malformed", options: [] };
    }
    if (status !== "active") continue;
    const selectionKey = JSON.stringify([endpointType, model]);
    if (dedup.has(selectionKey)) continue;
    dedup.set(selectionKey, {
      model,
      name,
      endpointType,
    });
  }

  const options: ApiKeyModelOption[] = [];
  for (const [selectionKey, item] of dedup) {
    options.push({
      selectionKey,
      value: item.model,
      label: `${item.name} (${item.model} · ${item.endpointType})`,
      endpointType: item.endpointType,
      status: "active",
    });
  }
  if (!options.length) return { state: "empty", workspaceId: responseWorkspaceId, options: [] };

  const endpointsByModel = new Map<string, Set<ApiKeyPublicEndpointType>>();
  for (const option of options) {
    const endpoints = endpointsByModel.get(option.value) ?? new Set<ApiKeyPublicEndpointType>();
    endpoints.add(option.endpointType);
    endpointsByModel.set(option.value, endpoints);
  }
  const conflictingModels = Array.from(endpointsByModel.entries())
    .filter(([, endpoints]) => endpoints.size > 1)
    .map(([model]) => model);
  if (conflictingModels.length) {
    return {
      state: "contract-conflict",
      workspaceId: responseWorkspaceId,
      options,
      conflictingModels,
    };
  }

  return { state: "ready", workspaceId: responseWorkspaceId, options };
}

function modelCatalogRequestErrorMessage(caught: unknown): string {
  const { status } = toApiErrorView(caught);
  if (status === 401) return "模型目录认证已失效（401），请重新登录后重试。";
  if (status === 403) return "当前工作区无权读取模型目录（403），请联系管理员。";
  if (status === 503) return "模型目录服务暂不可用（503），请稍后重试。";
  return "模型目录请求失败，已清除旧数据；请重试。";
}

type ConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "default" | "danger";
  onConfirm: () => Promise<void>;
};

const RELAY_PERMISSION_OPTIONS = [
  { value: "relay:text", label: "文本、向量与音频能力" },
  { value: "relay:image_generation", label: "图像生成" },
  { value: "relay:video_generation", label: "视频生成" },
  { value: "relay:portrait_assets:read", label: "人像资产只读" },
  { value: "relay:portrait_assets:write", label: "人像资产写入" },
  { value: "relay:portrait_assets:liveness", label: "人像真人认证" },
  { value: "mcp:connect", label: "MCP 连接" },
  { value: "project:read", label: "查询项目与画布" },
  { value: "project:create", label: "创建项目" },
  { value: "project:write", label: "写入项目画布" },
  { value: "model:read", label: "查询模型能力" },
  { value: "billing:read", label: "余额与资金流水" },
  { value: "usage:read", label: "查询本密钥用量" },
  { value: "usage:read:workspace", label: "查询工作区用量（受成员权限限制）" },
  { value: "account:read", label: "查询本人账号钱包与明细（跨本人工作区）" },
  { value: "asset:read", label: "查询素材" },
  { value: "asset:write", label: "上传与重命名素材" },
  { value: "asset:download", label: "下载作品" },
  { value: "generation:quote", label: "生成报价" },
  { value: "generation:create", label: "提交已批准的生成" },
  { value: "project:delete", label: "删除项目与模板" },
  { value: "workflow:execute", label: "执行制作流程与 Agent 任务" },
  { value: "workspace:write", label: "修改工作区资料" },
  { value: "member:read", label: "读取成员与邀请" },
  { value: "member:write", label: "管理成员与邀请" },
  { value: "billing:request:create", label: "创建充值与服务申请" },
  { value: "account:write", label: "修改本人资料与提交反馈" },
  { value: "generation:read", label: "查询生成任务与历史" },
] as const;
const ALL_RELAY_PERMISSIONS = RELAY_PERMISSION_OPTIONS.map(
  (permission) => permission.value,
);
const DEFAULT_RELAY_API_KEY_PERMISSIONS = ["relay:video_generation"] as const;
const RELAY_PERMISSION_SET = new Set<string>(ALL_RELAY_PERMISSIONS);
const hasApiRelayPermission = (permissions: readonly string[]) => permissions.some((value) => value.startsWith("relay:") && RELAY_PERMISSION_SET.has(value));

function exactRelayPermissions(values: readonly string[]): string[] {
  const requested = new Set(
    values.filter((value) => RELAY_PERMISSION_SET.has(value)),
  );
  return ALL_RELAY_PERMISSIONS.filter((permission) => (
    requested.has(permission)
  ));
}

const EXPIRY_PRESETS = [
  { label: "永不过期", value: "never" },
  { label: "1 个月", value: "30d" },
  { label: "1 天", value: "1d" },
  { label: "1 小时", value: "1h" },
];

function createEmptyForm(): ApiKeyForm {
  return {
    name: "",
    unlimitedQuota: true,
    quotaLimit: 10000,
    rateLimitPerMinute: 0,
    expiryMode: "never",
    expiryPreset: "never",
    expiresAt: null,
    modelAllowlist: [],
    permissions: [...DEFAULT_RELAY_API_KEY_PERMISSIONS],
    ipAllowlistText: "",
  };
}

function ApiKeyOptionChecklist({
  id,
  disabled,
  required: _required,
  children,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-errormessage": ariaErrorMessage,
  "aria-invalid": ariaInvalid,
}: {
  id?: string;
  disabled?: boolean;
  required?: boolean;
  children: ReactNode;
  "aria-label": string;
  "aria-describedby"?: string;
  "aria-errormessage"?: string;
  "aria-invalid"?: boolean | "false" | "true";
}) {
  return (
    <div
      id={id}
      role="group"
      className="apiKeyOptionChecklist"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      aria-describedby={ariaDescribedBy}
      aria-errormessage={ariaErrorMessage}
      aria-invalid={ariaInvalid}
    >
      {children}
    </div>
  );
}

function formFingerprint(form: ApiKeyForm) {
  return JSON.stringify(form);
}

function cleanStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function selectableModelAllowlist(
  values: readonly string[],
  options: readonly ApiKeyModelOption[],
): string[] | null {
  const selectableModels = new Set(options.map((option) => option.value));
  const normalized = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return normalized.every((value) => selectableModels.has(value)) ? normalized : null;
}

function formatTime(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toApiKeyItem(row: RawApiKeyRow): ApiKeyItem {
  const revoked = Boolean(row.revokedAt);
  const disabled = Boolean(row.disabled);
  const expiresAt = Number(row.expiresAt || 0);
  const expired = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now();
  const permissions = exactRelayPermissions(cleanStringList(row.permissions));
  const modelAllowlist = cleanStringList(row.modelAllowlist);
  const ipAllowlist = cleanStringList(row.ipAllowlist);
  const keyPrefix = String(row.keyPrefix || row.maskedKey || row.key || "");
  return {
    id: String(row.id),
    name: String(row.name || "未命名密钥"),
    status: revoked || disabled || expired ? "disabled" : "active",
    statusLabel: revoked ? "已撤销" : expired ? "已过期" : disabled ? "已停用" : "已启用",
    prefix: keyPrefix.replace(/_?\*+$/, ""),
    raw: row,
    quotaUnit: row.quotaUnit === "gu_micros" ? "gu_micros" : "request",
    quotaLimit: row.quotaLimit === null || row.quotaLimit === undefined ? null : Number(row.quotaLimit),
    quotaUsed: Number(row.quotaUsed || 0),
    quotaReserved: Number(row.quotaReserved || 0),
    rateLimitPerMinute: row.rateLimitPerMinute === null || row.rateLimitPerMinute === undefined ? null : Number(row.rateLimitPerMinute),
    modelAllowlist,
    ipAllowlist,
    permissions,
    createdAt: formatTime(row.createTime),
    lastUsedAt: formatTime(row.lastUsedAt),
    expiresAt: row.expiresAt ? formatTime(row.expiresAt) : "永久",
  };
}

function isRevokedApiKey(row: ApiKeyItem): boolean {
  return Boolean(row.raw.revokedAt);
}

function isExpiredApiKey(row: ApiKeyItem): boolean {
  return row.statusLabel === "已过期";
}

function parseIpText(value: string): string[] {
  return Array.from(new Set(value.split(/\n|,/).map((item) => item.trim()).filter(Boolean)));
}

function fallbackCopyText(text: string) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.className = "apiKeyClipboardFallback";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

async function copyText(text: string) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return fallbackCopyText(text);
  }
}

export default function ApiKeyManagement({ connections = false }: { connections?: boolean }) {
  const { toast } = useToast();
  const currentUser = useAuthStore((state) => state.user);
  const currentWorkspace = useAuthStore((state) => state.currentWorkspace);
  const currentWorkspaceId = currentWorkspace?.id ? String(currentWorkspace.id) : "";
  const activeWorkspaceIdRef = useRef(currentWorkspaceId);
  activeWorkspaceIdRef.current = currentWorkspaceId;
  const keyLoadRef = useRef<{ sequence: number; controller: AbortController | null }>({ sequence: 0, controller: null });
  const modelLoadRef = useRef<{ sequence: number; controller: AbortController | null }>({ sequence: 0, controller: null });
  const canWriteKeys = canManageDeveloperApiKeys({ user: currentUser, workspace: currentWorkspace });
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | ApiKeyStatus>("all");
  const [nameFilter, setNameFilter] = useState("");
  const [prefixFilter, setPrefixFilter] = useState("");
  const [loadError, setLoadError] = useState("");
  const [secretVisible, setSecretVisible] = useState(false);
  const [secretTitle, setSecretTitle] = useState("API 密钥已创建");
  const [visibleSecret, setVisibleSecret] = useState("");
  const [secretIsTool, setSecretIsTool] = useState(false);
  const [secretHasRelay, setSecretHasRelay] = useState(false);
  const saveInFlight = useRef(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerMode, setDrawerMode] = useState<DrawerMode>("create");
  const [editingKey, setEditingKey] = useState<ApiKeyItem | null>(null);
  const [detailKey, setDetailKey] = useState<ApiKeyItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [formSubmitted, setFormSubmitted] = useState(false);
  const [formError, setFormError] = useState("");
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [rotatingIds, setRotatingIds] = useState<Set<string>>(() => new Set());
  const [revokingIds, setRevokingIds] = useState<Set<string>>(() => new Set());
  const [statusChangingIds, setStatusChangingIds] = useState<Set<string>>(() => new Set());
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [modelCatalogState, setModelCatalogState] = useState<ApiKeyModelCatalogState>("idle");
  const [modelLoadError, setModelLoadError] = useState("");
  const [modelOptions, setModelOptions] = useState<ApiKeyModelOption[]>([]);
  const [modelCatalogWorkspaceId, setModelCatalogWorkspaceId] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [developerEndpoint, setDeveloperEndpoint] = useState("");
  const [developerEndpointRejected, setDeveloperEndpointRejected] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [form, setForm] = useState<ApiKeyForm>(() => createEmptyForm());
  const [initialForm, setInitialForm] = useState<ApiKeyForm>(() => createEmptyForm());

  const modelLoading = modelCatalogState === "loading";
  const modelCatalogReady = modelCatalogState === "ready"
    && modelCatalogWorkspaceId === currentWorkspaceId;
  const endpointUrl = useMemo(() => {
    if (developerEndpointRejected) return "";
    if (developerEndpoint) return sanitizeApiKeyConnectionEndpoint(developerEndpoint) ?? "";
    const baseUrl = readApiSettings().baseUrl.replace(/\/api\/?$/, "");
    return sanitizeApiKeyConnectionEndpoint(`${baseUrl}/api/v3/contents/generations/tasks`) ?? "";
  }, [developerEndpoint, developerEndpointRejected]);
  const endpointConfigurationRejected = developerEndpointRejected;
  const {
    projects: connectionProjects,
    selectedProjectId: connectionProjectId,
    selectProject: selectConnectionProject,
    loading: connectionProjectsLoading,
    error: connectionProjectsError,
    retry: retryConnectionProjects,
  } = useAuthorizedProjectSelection(currentWorkspaceId);

  const filteredKeys = useMemo(() => {
    const name = nameFilter.trim().toLowerCase();
    const prefix = prefixFilter.trim().toLowerCase();
    return apiKeys.filter((item) => {
      if (connections && !item.permissions.includes("mcp:connect")) return false;
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (name && !item.name.toLowerCase().includes(name)) return false;
      if (prefix && !String(item.prefix || item.raw.key || "").toLowerCase().includes(prefix)) return false;
      return true;
    });
  }, [apiKeys, nameFilter, prefixFilter, statusFilter, connections]);

  const selectedRows = useMemo(() => {
    const selected = new Set(selectedRowKeys);
    return filteredKeys.filter((item) => selected.has(item.id));
  }, [filteredKeys, selectedRowKeys]);
  const connectionModelFor = (row: ApiKeyItem) => resolveApiKeyConnectionModel(
    row.modelAllowlist,
    modelCatalogReady ? modelOptions : [],
  );
  const isMcpKey = (row: ApiKeyItem) => row.permissions.includes("mcp:connect");
  const hasRelayKey = (row: ApiKeyItem) => hasApiRelayPermission(row.permissions);
  const selectedConnectionInfoUnavailable = selectedRows.some(row => !connectionInfoText(row));
  const detailConnectionInfoUnavailable = Boolean(detailKey && hasRelayKey(detailKey) && !relayConnectionInfoText(detailKey));
  const formNeedsModelCatalog = form.modelAllowlist.length > 0 || form.permissions.some(p => p.startsWith("relay:") || p === "generation:create");
  const editingHasUnknownPermissions = drawerMode === "edit" && Boolean(editingKey
    && cleanStringList(editingKey.raw.permissions).some((permission) => !RELAY_PERMISSION_SET.has(permission)));
  const allFilteredSelected = filteredKeys.length > 0 && selectedRows.length === filteredKeys.length;
  const someFilteredSelected = !allFilteredSelected && selectedRows.length > 0;

  const formDirty = drawerVisible && formFingerprint(form) !== formFingerprint(initialForm);
  const advancedSettingCount = [
    form.modelAllowlist.length > 0,
    exactRelayPermissions(form.permissions).join("\u0000")
      !== DEFAULT_RELAY_API_KEY_PERMISSIONS.join("\u0000"),
    form.rateLimitPerMinute > 0,
    parseIpText(form.ipAllowlistText).length > 0,
  ].filter(Boolean).length;

  useEffect(() => {
    const emptyForm = createEmptyForm();
    setApiKeys([]);
    setDeveloperEndpoint("");
    setDeveloperEndpointRejected(false);
    setModelOptions([]);
    setModelCatalogWorkspaceId(null);
    setModelCatalogState("idle");
    setLoadError("");
    setModelLoadError("");
    setSelectedRowKeys([]);
    setEditingKey(null);
    setDetailKey(null);
    setDrawerVisible(false);
    setDrawerMode("create");
    setForm(emptyForm);
    setInitialForm(emptyForm);
    setFormSubmitted(false);
    setFormError("");
    setSecretVisible(false);
    setVisibleSecret("");
    setConfirmAction(null);
    setRotatingIds(new Set());
    setRevokingIds(new Set());
    setStatusChangingIds(new Set());
    setBatchDeleting(false);
    setSaving(false);

    void loadKeys(currentWorkspaceId);
    void loadModelCatalog(currentWorkspaceId);

    return () => {
      keyLoadRef.current.controller?.abort();
      modelLoadRef.current.controller?.abort();
    };
  }, [currentWorkspaceId]);

  useEffect(() => {
    const visibleIds = new Set(filteredKeys.map((item) => item.id));
    setSelectedRowKeys((keys) => keys.filter((id) => visibleIds.has(id)));
  }, [filteredKeys]);

  async function loadKeys(workspaceId = currentWorkspaceId) {
    if (workspaceId !== activeWorkspaceIdRef.current) return;
    const sequence = keyLoadRef.current.sequence + 1;
    keyLoadRef.current.controller?.abort();
    const controller = new AbortController();
    keyLoadRef.current = { sequence, controller };
    setLoadError("");
    setApiKeyLoading(true);
    try {
      const [rows, config] = await Promise.all([
        apiPost<RawApiKeyRow[]>("/apiKeys/list", workspaceId ? { workspaceId } : {}, undefined, { signal: controller.signal }),
        apiPost<{ endpoint?: string }>("/developer/config", {}, undefined, { signal: controller.signal }).catch(() => null),
      ]);
      if (controller.signal.aborted || sequence !== keyLoadRef.current.sequence || workspaceId !== activeWorkspaceIdRef.current) return;
      setApiKeys((Array.isArray(rows) ? rows : []).map(toApiKeyItem));
      const configuredEndpoint = typeof config?.endpoint === "string" ? config.endpoint.trim() : "";
      const safeEndpoint = configuredEndpoint
        ? sanitizeApiKeyConnectionEndpoint(configuredEndpoint)
        : null;
      setDeveloperEndpoint(safeEndpoint ?? "");
      setDeveloperEndpointRejected(Boolean(configuredEndpoint && !safeEndpoint));
    } catch (caught: unknown) {
      if (controller.signal.aborted || sequence !== keyLoadRef.current.sequence || workspaceId !== activeWorkspaceIdRef.current) return;
      const message = caught instanceof Error ? caught.message : "API 密钥数据加载失败";
      setLoadError(message);
      setApiKeys([]);
    } finally {
      if (!controller.signal.aborted && sequence === keyLoadRef.current.sequence && workspaceId === activeWorkspaceIdRef.current) {
        keyLoadRef.current.controller = null;
        setApiKeyLoading(false);
      }
    }
  }

  async function loadModelCatalog(workspaceId = currentWorkspaceId) {
    if (workspaceId !== activeWorkspaceIdRef.current) return;
    const sequence = modelLoadRef.current.sequence + 1;
    modelLoadRef.current.controller?.abort();
    const controller = new AbortController();
    modelLoadRef.current = { sequence, controller };
    setModelCatalogState("loading");
    setModelLoadError("");
    setModelOptions([]);
    setModelCatalogWorkspaceId(null);
    try {
      const data = await apiPost<unknown>("/developer/models", workspaceId ? { workspaceId } : {}, undefined, { signal: controller.signal });
      if (controller.signal.aborted || sequence !== modelLoadRef.current.sequence || workspaceId !== activeWorkspaceIdRef.current) return;
      const parsed = parseApiKeyModelCatalog(data, workspaceId || undefined);
      setModelCatalogState(parsed.state);
      if (parsed.state === "ready") {
        setModelOptions(parsed.options);
        setModelCatalogWorkspaceId(parsed.workspaceId);
        return;
      }

      setModelOptions([]);
      setModelCatalogWorkspaceId(null);
      if (parsed.state === "empty") {
        setModelLoadError("当前工作区没有可用的 active 模型。");
      } else if (parsed.state === "contract-conflict") {
        setModelLoadError(API_KEY_MODEL_ALLOWLIST_ENDPOINT_CONTRACT_CR);
      } else {
        setModelLoadError("模型目录响应格式非法，已拒绝使用并清除旧数据。");
      }
    } catch (caught: unknown) {
      if (controller.signal.aborted || sequence !== modelLoadRef.current.sequence || workspaceId !== activeWorkspaceIdRef.current) return;
      setModelOptions([]);
      setModelCatalogWorkspaceId(null);
      setModelCatalogState("error");
      setModelLoadError(modelCatalogRequestErrorMessage(caught));
    } finally {
      if (!controller.signal.aborted && sequence === modelLoadRef.current.sequence && workspaceId === activeWorkspaceIdRef.current) {
        modelLoadRef.current.controller = null;
      }
    }
  }

  function openCreateKey() {
    if (!canWriteKeys) return;
    const next = createEmptyForm();
    if (connections) {
      next.permissions = [...TOOL_READ_PERMISSIONS];
      next.expiryMode = "custom";
      next.expiryPreset = "30d";
      next.expiresAt = Date.now() + 30 * 86400000;
    }
    setDrawerMode("create");
    setEditingKey(null);
    setForm(next);
    setInitialForm(next);
    setFormSubmitted(false);
    setFormError("");
    setDrawerVisible(true);
    void loadModelCatalog();
  }

  function openEditKey(row: ApiKeyItem) {
    if (!canWriteKeys) return;
    const expiresAt = Number(row.raw.expiresAt || 0) || null;
    const next: ApiKeyForm = {
      name: row.name,
      unlimitedQuota: !row.quotaLimit,
      quotaLimit: row.quotaLimit || 10000,
      rateLimitPerMinute: row.rateLimitPerMinute || 0,
      expiryMode: expiresAt ? "custom" : "never",
      expiryPreset: expiresAt ? "custom" : "never",
      expiresAt,
      modelAllowlist: [...row.modelAllowlist],
      permissions: exactRelayPermissions(row.permissions),
      ipAllowlistText: row.ipAllowlist.join("\n"),
    };
    setDrawerMode("edit");
    setEditingKey(row);
    setForm(next);
    setInitialForm(next);
    setFormSubmitted(false);
    setFormError("");
    setDrawerVisible(true);
    void loadModelCatalog();
  }

  const statusText = (row: ApiKeyItem) => row.status === "rotating" ? "轮换中" : row.statusLabel;
  const maskedKey = (row: ApiKeyItem) => String(row.raw.key || row.raw.maskedKey || (row.prefix ? `${row.prefix}_****` : "-"));
  const quotaText = (row: ApiKeyItem) => {
    if (row.quotaUnit === "request") {
      return !row.quotaLimit
        ? `旧版任务次数：${row.quotaUsed.toLocaleString()}（不限）`
        : `旧版任务次数：${row.quotaUsed.toLocaleString()} / ${row.quotaLimit.toLocaleString()}`;
    }
    const used = `${row.quotaUsed.toLocaleString(undefined, { maximumFractionDigits: 6 })} GU`;
    const reserved = row.quotaReserved > 0
      ? `，冻结 ${row.quotaReserved.toLocaleString(undefined, { maximumFractionDigits: 6 })} GU`
      : "";
    return !row.quotaLimit
      ? `已用 ${used}${reserved}（不限额）`
      : `已用 ${used}${reserved} / ${row.quotaLimit.toLocaleString()} GU`;
  };
  const modelText = (row: ApiKeyItem) => !row.modelAllowlist.length ? "无限制" : `${row.modelAllowlist.length} 个模型`;

  function applyExpiryPreset(value: string) {
    if (value === "custom") return;
    setForm((current) => {
      const next = { ...current, expiryPreset: value };
      if (value === "never") {
        next.expiryMode = "never";
        next.expiresAt = null;
      } else {
        next.expiryMode = "custom";
        const durations: Record<string, number> = { "30d": 30 * 86400000, "1d": 86400000, "1h": 3600000 };
        next.expiresAt = Date.now() + (durations[value] || 0);
      }
      return next;
    });
  }

  async function copyWithToast(text: string, silent = false) {
    const source = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const copied = await copyText(text);
    if (!silent) toast({
      title: copied ? "已复制" : "复制失败，请手动复制",
      tone: copied ? "success" : "danger",
    });
    // Clipboard promises and portalled toast updates can move focus to the
    // document body in Chromium. Keep keyboard users on the control that
    // initiated the copy action; notifications must remain non-modal.
    queueMicrotask(() => {
      if (source?.isConnected) source.focus();
    });
    return copied;
  }

  async function handleSaveKey() {
    if (saveInFlight.current || !canWriteKeys) return;
    setFormSubmitted(true);
    setFormError("");
    if (!form.name.trim()) {
      nameInputRef.current?.focus();
      return;
    }
    if (!form.permissions.length) {
      setFormError("保存失败：至少选择一项接口权限。");
      return;
    }
    if (editingHasUnknownPermissions) {
      setFormError("此密钥包含当前界面无法识别的权限，已阻止编辑以免意外改写。请联系管理员核对权限。");
      return;
    }
    if (formNeedsModelCatalog && !modelCatalogReady) {
      setFormError(`保存失败：${modelLoadError || "模型目录尚未就绪，请重试。"}`);
      return;
    }
    const validatedModelAllowlist = selectableModelAllowlist(form.modelAllowlist, modelOptions);
    if (!validatedModelAllowlist) {
      setFormError("保存失败：模型限制包含当前目录中 unavailable 或不可见的旧模型。请先选择“全部模型”，再重新勾选当前 active 模型。");
      return;
    }
    const editingStartedWithStaleModelRestriction = drawerMode === "edit"
      && Boolean(editingKey?.modelAllowlist.length)
      && selectableModelAllowlist(editingKey?.modelAllowlist ?? [], modelOptions) === null;
    if (editingStartedWithStaleModelRestriction && validatedModelAllowlist.length === 0) {
      setFormError("保存失败：清除旧模型后，必须至少重新选择一个当前 active 模型；此编辑不能直接改为“全部模型”。");
      return;
    }

    if (!currentWorkspaceId) { setFormError("请先选择工作区。"); return; }
    if (!form.permissions.length) { setFormError("请至少选择一项接口权限。"); return; }
    if (connections && !form.permissions.includes("mcp:connect")) { setFormError("MCP / CLI 专用密钥须保留 MCP 连接权限。"); return; }
    const operationWorkspaceId = currentWorkspaceId;
    saveInFlight.current = true;
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      quotaLimit: form.unlimitedQuota ? null : Number(form.quotaLimit || 0),
      rateLimitPerMinute: form.rateLimitPerMinute ? Number(form.rateLimitPerMinute) : null,
      expiresAt: form.expiryMode === "never" ? null : form.expiresAt,
      permissions: exactRelayPermissions(form.permissions),
      modelAllowlist: validatedModelAllowlist,
      ipAllowlist: parseIpText(form.ipAllowlistText),
    };

    try {
      if (drawerMode === "create") {
        const data = await apiPostWithStepUp<RawApiKeyRow>("/apiKeys/create", {
          ...payload,
          scope: "workspace",
          workspaceId: operationWorkspaceId || null,
        }, "api_key.create");
        if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
        setSecretTitle("API 密钥已创建");
        setSecretIsTool(form.permissions.includes("mcp:connect"));
        setSecretHasRelay(hasApiRelayPermission(form.permissions));
        setVisibleSecret(String(data.apiKey || ""));
        setSecretVisible(true);
        if (!form.permissions.includes("mcp:connect")) toast({ title: "API 密钥创建成功", tone: "success" });
      } else if (editingKey) {
        await apiPostWithStepUp("/apiKeys/update", {
          id: editingKey.id,
          workspaceId: operationWorkspaceId || null,
          ...payload,
        }, "api_key.update");
        if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
        toast({ title: "API 密钥已更新", message: editingKey.name, tone: "success" });
      }
      if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
      setInitialForm(form);
      setDrawerVisible(false);
      await loadKeys(operationWorkspaceId);
    } catch (caught: unknown) {
      if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
      const message = caught instanceof Error ? caught.message : "保存失败";
      setFormError(`保存失败：${message}`);
    } finally {
      saveInFlight.current = false;
      if (operationWorkspaceId === activeWorkspaceIdRef.current) setSaving(false);
    }
  }

  function handleRotate(row: ApiKeyItem) {
    if (!canWriteKeys) return;
    const operationWorkspaceId = currentWorkspaceId;
    setConfirmAction({
      title: "轮换 API 密钥",
      description: `确认轮换「${row.name}」？旧密钥会立即失效，使用旧密钥的 API 请求将无法继续通过认证。`,
      confirmLabel: "确认轮换",
      tone: "danger",
      onConfirm: async () => {
        setRotatingIds((ids) => new Set([...ids, row.id]));
        try {
          const data = await apiPostWithStepUp<RawApiKeyRow>("/apiKeys/rotate", {
            id: row.id,
            workspaceId: operationWorkspaceId || null,
          }, "api_key.rotate");
          if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
          setSecretTitle("API 密钥已轮换");
          setSecretIsTool(row.permissions.includes("mcp:connect"));
          setSecretHasRelay(hasRelayKey(row));
          setVisibleSecret(String(data.apiKey || ""));
          setSecretVisible(true);
          if (!row.permissions.includes("mcp:connect")) toast({ title: "API 密钥已轮换", message: row.name, tone: "success" });
          await loadKeys(operationWorkspaceId);
        } finally {
          if (operationWorkspaceId === activeWorkspaceIdRef.current) {
            setRotatingIds((ids) => {
              const next = new Set(ids);
              next.delete(row.id);
              return next;
            });
          }
        }
      },
    });
  }

  function handleDisabledChange(row: ApiKeyItem) {
    if (!canWriteKeys || isRevokedApiKey(row) || isExpiredApiKey(row)) return;
    const operationWorkspaceId = currentWorkspaceId;
    const disabled = !Boolean(row.raw.disabled);
    const actionLabel = disabled ? "停用" : "启用";
    setConfirmAction({
      title: `${actionLabel} API 密钥`,
      description: disabled
        ? `确认停用「${row.name}」？停用后 API 请求会立即失败，之后仍可重新启用。`
        : `确认重新启用「${row.name}」？启用后该密钥会恢复 API 访问能力。`,
      confirmLabel: `确认${actionLabel}`,
      tone: disabled ? "danger" : "default",
      onConfirm: async () => {
        setStatusChangingIds((ids) => new Set([...ids, row.id]));
        try {
          await apiPostWithStepUp("/apiKeys/update", {
            id: row.id,
            workspaceId: operationWorkspaceId || null,
            disabled,
          }, "api_key.update");
          if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
          toast({ title: `API 密钥已${actionLabel}`, message: row.name, tone: "success" });
          await loadKeys(operationWorkspaceId);
        } finally {
          if (operationWorkspaceId === activeWorkspaceIdRef.current) {
            setStatusChangingIds((ids) => {
              const next = new Set(ids);
              next.delete(row.id);
              return next;
            });
          }
        }
      },
    });
  }

  function handleRevoke(row: ApiKeyItem) {
    if (!canWriteKeys || isRevokedApiKey(row)) return;
    const operationWorkspaceId = currentWorkspaceId;
    setConfirmAction({
      title: "撤销 API 密钥",
      description: `确认永久撤销「${row.name}」？撤销后无法重新启用，使用该密钥的 API 请求会立即失败。`,
      confirmLabel: "确认撤销",
      tone: "danger",
      onConfirm: async () => {
        setRevokingIds((ids) => new Set([...ids, row.id]));
        try {
          await apiPostWithStepUp("/apiKeys/revoke", {
            id: row.id,
            workspaceId: operationWorkspaceId || null,
          }, "api_key.revoke");
          if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
          setSelectedRowKeys((keys) => keys.filter((id) => id !== row.id));
          toast({ title: "API 密钥已撤销", message: row.name, tone: "success" });
          await loadKeys(operationWorkspaceId);
        } finally {
          if (operationWorkspaceId === activeWorkspaceIdRef.current) {
            setRevokingIds((ids) => {
              const next = new Set(ids);
              next.delete(row.id);
              return next;
            });
          }
        }
      },
    });
  }

  function handleBatchRevoke() {
    if (!canWriteKeys) {
      toast({ title: "当前工作区仅授予 API 密钥读取权限", tone: "warning" });
      return;
    }
    if (!selectedRows.length) {
      toast({ title: "请选择要撤销的密钥", tone: "warning" });
      return;
    }
    const rowsToRevoke = selectedRows.filter((row) => !isRevokedApiKey(row));
    if (!rowsToRevoke.length) {
      toast({ title: "所选密钥均已撤销", tone: "warning" });
      return;
    }
    const operationWorkspaceId = currentWorkspaceId;
    setConfirmAction({
      title: "批量撤销 API 密钥",
      description: `确认永久撤销已选择的 ${rowsToRevoke.length} 个 API 密钥？撤销后无法重新启用。`,
      confirmLabel: "确认撤销",
      tone: "danger",
      onConfirm: async () => {
        setBatchDeleting(true);
        try {
          await withStepUpProofs(
            rowsToRevoke.map(() => "api_key.revoke"),
            (proof, index) => apiPost(
              "/apiKeys/revoke",
              {
                id: rowsToRevoke[index].id,
                workspaceId: operationWorkspaceId || null,
              },
              readApiSettings(),
              stepUpRequestOptions(proof),
            ),
            `批量撤销 ${rowsToRevoke.length} 个 API 密钥。`,
          );
          if (operationWorkspaceId !== activeWorkspaceIdRef.current) return;
          setSelectedRowKeys([]);
          toast({ title: `已撤销 ${rowsToRevoke.length} 个 API 密钥`, tone: "success" });
          await loadKeys(operationWorkspaceId);
        } finally {
          if (operationWorkspaceId === activeWorkspaceIdRef.current) setBatchDeleting(false);
        }
      },
    });
  }

  function relayConnectionInfoText(row: ApiKeyItem): string | null {
    if (!hasRelayKey(row)) return null;
    const base = routeEndpoint("/v1");
    if (!base) return null;
    const parts: string[] = [`API Base URL: ${base}\n已授权权限: ${row.permissions.filter((value) => value.startsWith("relay:")).join("、")}`];
    if (row.permissions.includes("relay:text")) {
      const model = resolveApiKeyTextConnectionModel(row.modelAllowlist, modelCatalogReady ? modelOptions : []);
      const info = model && buildTextApiKeyConnectionInfo(readApiSettings().baseUrl, model);
      parts.push(info ? `文本 API\n${info}` : "文本 API：当前尚无可用于此密钥的 active 文本模型，请先检查模型目录。Endpoint: " + routeEndpoint("/v1/chat/completions"));
    }
    if (row.permissions.includes("relay:video_generation")) {
      const model = connectionModelFor(row);
      const info = !developerEndpointRejected && model && connectionProjectId !== null
        ? buildApiKeyConnectionInfo(endpointUrl, model, connectionProjectId)
        : null;
      if ((!model || developerEndpointRejected) && !row.permissions.some(permission => permission !== "relay:video_generation" && permission.startsWith("relay:"))) return null;
      if (info) parts.push(`视频 API\n所需权限: relay:video_generation\n${info}`);
      else if (!developerEndpointRejected) parts.push(`视频 API：请求示例待配置 active 视频模型与当前工作区项目。${endpointUrl ? `Endpoint: ${endpointUrl}` : "视频 Endpoint 尚未配置。"}`);
      else if (!row.permissions.some((permission) => permission !== "relay:video_generation" && permission.startsWith("relay:"))) return null;
      else parts.push("视频 API：配置的 Endpoint 未通过安全检查，视频请求示例暂不可用。");
    }
    for (const [permission, path, label] of [
      ["relay:image_generation", "/v1/images/generations", "图像 API"],
      ["relay:portrait_assets:read", "/api/v3/portrait-assets", "人像资产 API"],
      ["relay:portrait_assets:write", "/api/v3/portrait-assets", "人像资产 API"],
      ["relay:portrait_assets:liveness", "/api/v3/portrait-assets", "人像资产 API"],
    ]) {
      if (!row.permissions.includes(permission) || parts.some((part) => part.startsWith(label))) continue;
      const url = routeEndpoint(path);
      if (!url) return null;
      const granted = label === "人像资产 API"
        ? row.permissions.filter((value) => value.startsWith("relay:portrait_assets:")).join("、")
        : permission;
      parts.push(`${label}\nEndpoint: ${url}\n已授权权限: ${granted}；请求格式见开发者文档。`);
    }
    return parts.join("\n\n");
  }

  function routeEndpoint(path: string): string {
    try {
      return sanitizeApiKeyConnectionEndpoint(new URL(path, readApiSettings().baseUrl).toString()) || "";
    } catch { return ""; }
  }

  function toolConnectionInfoText(row: ApiKeyItem): string | null {
    if (!isMcpKey(row)) return null;
    try {
      const config = buildToolConnectionConfig(readApiSettings().baseUrl);
      return `MCP URL: ${config.mcpUrl}\nAPI Key: 使用创建或轮换时保存的完整工作区密钥\n\n${config.cli}\n\n本地 MCP:\n${config.stdio}`;
    } catch { return null; }
  }

  function connectionInfoText(row: ApiKeyItem): string | null {
    const relay = relayConnectionInfoText(row);
    const tool = toolConnectionInfoText(row);
    if (hasRelayKey(row) && !relay) return null;
    if (isMcpKey(row) && !tool) return null;
    return [relay && `API 中转\n${relay}`, tool && `MCP / CLI\n${tool}`].filter(Boolean).join("\n\n---\n\n") || null;
  }

  async function copyConnectionInfo(rows: ApiKeyItem[], channel?: "relay" | "tool") {
    const entries = rows.map((row) => ({ row, connectionInfo: channel === "relay"
      ? relayConnectionInfoText(row)
      : channel === "tool" ? toolConnectionInfoText(row) : connectionInfoText(row) }));
    if (entries.some((entry) => !entry.connectionInfo)) {
      toast({
        title: "暂无可复制的连接示例",
        message: modelLoadError ? "模型目录加载失败，请刷新后重试。" : "当前工作区没有适用于所选密钥的真实模型。",
        tone: "warning",
      });
      return false;
    }
    const text = entries
      .map(({ row, connectionInfo }) => [`# ${row.name}`, connectionInfo].join("\n"))
      .join("\n\n---\n\n");
    await copyWithToast(text);
    return true;
  }

  function exportSelectedCsv() {
    if (!selectedRows.length) {
      toast({ title: "请先选择 API 密钥", tone: "warning" });
      return;
    }
    const escapeCsvCell = (value: unknown) => {
      const text = String(value ?? "");
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csvRows = [
      ["名称", "状态", "API 密钥", "额度", "模型", "IP 限制", "创建时间", "最后使用时间", "过期"],
      ...selectedRows.map((row) => [
        row.name,
        statusText(row),
        maskedKey(row),
        quotaText(row),
        modelText(row),
        row.ipAllowlist.length ? row.ipAllowlist.join(";") : "无限制",
        row.createdAt,
        row.lastUsedAt,
        row.expiresAt,
      ]),
    ];
    const content = `\uFEFF${csvRows.map((row) => row.map(escapeCsvCell).join(",")).join("\n")}`;
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fanjin-api-keys-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast({ title: `已导出 ${selectedRows.length} 个密钥`, tone: "success" });
  }

  const columns = useMemo<DataTableColumn<ApiKeyItem>[]>(() => [
    {
      id: "selection",
      header: (
        <label className="apiKeySelectionControl">
          <span className="consoleSrOnly">选择全部当前筛选结果</span>
          <Checkbox
            size="compact"
            aria-label="选择全部当前筛选结果"
            checked={allFilteredSelected}
            indeterminate={someFilteredSelected}
            onCheckedChange={(checked) => setSelectedRowKeys(checked ? filteredKeys.map((item) => item.id) : [])}
          />
        </label>
      ),
      priority: "secondary",
      hideable: false,
      className: "apiKeySelectionColumn",
      cell: (row) => (
        <label className="apiKeySelectionControl">
          <span className="consoleSrOnly">选择 {row.name}</span>
          <Checkbox
            size="compact"
            aria-label={`选择 ${row.name}`}
            checked={selectedRowKeys.includes(row.id)}
            onCheckedChange={(checked) => {
              setSelectedRowKeys((keys) => checked ? [...keys, row.id] : keys.filter((id) => id !== row.id));
            }}
          />
        </label>
      ),
    },
    {
      id: "name",
      header: "名称",
      priority: "primary",
      sortable: true,
      sortValue: (row) => row.name,
      className: "apiKeyNameColumn",
      cell: (row) => <div className="apiKeyNameCell"><strong>{row.name}</strong><code>{row.prefix || "-"}</code></div>,
    },
    {
      id: "status",
      header: "状态",
      priority: "primary",
      sortable: true,
      sortValue: (row) => row.status,
      className: "apiKeyStatusColumn",
      cell: (row) => <Badge tone={row.status === "active" ? "success" : row.status === "rotating" ? "warning" : "neutral"}>{statusText(row)}</Badge>,
    },
    {
      id: "access",
      header: "接入方式",
      priority: "secondary",
      cell: (row) => <span className="apiKeyAccessKinds">
        {hasApiRelayPermission(row.permissions) && <Badge tone="info">API 中转</Badge>}
        {row.permissions.includes("mcp:connect") && <Badge tone="neutral">MCP / CLI</Badge>}
      </span>,
    },
    {
      id: "key",
      header: "API 密钥",
      priority: "secondary",
      className: "apiKeyValueColumn",
      cell: (row) => (
        <Tooltip>
          <TooltipTrigger className="apiKeyMaskedValue"><code>{maskedKey(row)}</code></TooltipTrigger>
          <TooltipContent>{maskedKey(row)}</TooltipContent>
        </Tooltip>
      ),
    },
    { id: "quota", header: "GU 额度", priority: "secondary", sortValue: (row) => row.quotaLimit, sortable: true, cell: quotaText },
    { id: "models", header: "模型", priority: "detail", cell: modelText },
    { id: "ip", header: "IP", priority: "detail", cell: (row) => row.ipAllowlist.length ? `${row.ipAllowlist.length} 条` : "无限制" },
    { id: "createdAt", header: "创建时间", priority: "detail", accessor: "createdAt" },
    { id: "lastUsedAt", header: "最后使用", priority: "detail", accessor: "lastUsedAt" },
    { id: "expiresAt", header: "过期", priority: "detail", accessor: "expiresAt" },
    {
      id: "actions",
      header: "操作",
      priority: "primary",
      hideable: false,
      className: "apiKeyActionsColumn",
      cell: (row) => {
        const revoked = isRevokedApiKey(row);
        const expired = isExpiredApiKey(row);
        const changingStatus = statusChangingIds.has(row.id);
        return (
        <div className="apiKeyRowActions">
          {!revoked ? (
            <Button size="compact" variant="secondary" icon={<Pencil aria-hidden="true" size={15} />} disabled={!canWriteKeys} onClick={() => openEditKey(row)}>编辑</Button>
          ) : (
            <Button size="compact" variant="secondary" icon={<Eye aria-hidden="true" size={15} />} onClick={() => setDetailKey(row)}>查看</Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(
                <Button
                  variant="secondary"
                  size="compact"
                  icon={<MoreHorizontal aria-hidden="true" size={17} />}
                  aria-label={`更多操作：${row.name}`}
                />
              )}
            />
            <DropdownMenuContent align="end" aria-label={`${row.name} 的更多操作`}>
              <DropdownMenuItem onClick={() => setDetailKey(row)}><Eye aria-hidden="true" size={16} />查看详情</DropdownMenuItem>
              {!revoked && !expired ? <DropdownMenuItem disabled={!canWriteKeys || changingStatus} onClick={() => handleDisabledChange(row)}>{row.raw.disabled ? <Play aria-hidden="true" size={16} /> : <Pause aria-hidden="true" size={16} />}{changingStatus ? "处理中" : row.raw.disabled ? "启用密钥" : "停用密钥"}</DropdownMenuItem> : null}
              <DropdownMenuItem disabled={!canWriteKeys || row.status === "disabled" || rotatingIds.has(row.id)} onClick={() => handleRotate(row)}><RotateCw aria-hidden="true" size={16} />{rotatingIds.has(row.id) ? "轮换中" : "轮换密钥"}</DropdownMenuItem>
              {!revoked ? <DropdownMenuItem tone="danger" disabled={!canWriteKeys || revokingIds.has(row.id)} onClick={() => handleRevoke(row)}><Trash2 aria-hidden="true" size={16} />{revokingIds.has(row.id) ? "撤销中" : "撤销密钥"}</DropdownMenuItem> : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        );
      },
    },
  ], [allFilteredSelected, canWriteKeys, filteredKeys, revokingIds, rotatingIds, selectedRowKeys, someFilteredSelected, statusChangingIds]);

  const hasFilters = Boolean(nameFilter || prefixFilter || statusFilter !== "all");
  const closeSecret = () => {
    setSecretVisible(false);
    setVisibleSecret("");
  };

  return (
    <section
      className="apiKeyManagement"
      aria-labelledby="api-key-list-heading"
      data-model-catalog-state={modelCatalogState}
      data-model-catalog-workspace={modelCatalogWorkspaceId ?? ""}
    >
      {!canWriteKeys && <Alert tone="info">当前工作区仅授予 API 密钥读取权限，可查看连接配置；请联系工作区所有者创建或修改密钥。</Alert>}
      <header className="apiKeyPanelHeader">
        <div className="apiKeyPanelHeading">
          <div className="apiKeyPanelTitleRow">
            <h2 id="api-key-list-heading">密钥列表</h2>
            <Badge tone="info">{apiKeyLoading ? "同步中" : `${filteredKeys.length} 条`}</Badge>
          </div>
          <p>{connections ? "按设备或自动化任务单独创建，随时停用、轮换或撤销。" : "创建、轮换、撤销和筛选当前工作区 API 密钥。"}</p>
        </div>
        <Button icon={<Plus aria-hidden="true" size={17} />} disabled={!canWriteKeys || !currentWorkspaceId} onClick={openCreateKey}>{connections ? "创建连接密钥" : "创建 API 密钥"}</Button>
      </header>

      {modelCatalogState !== "idle" && modelCatalogState !== "ready" ? (
        <Alert
          className="apiKeyConnectionAlert"
          tone={modelLoading ? "info" : modelCatalogState === "empty" ? "warning" : "danger"}
          title={modelLoading ? "模型目录加载中" : modelCatalogState === "empty" ? "模型目录为空" : "模型目录不可用"}
        >
          <span>{modelLoading ? "正在读取当前工作区的公开模型目录。" : modelLoadError}</span>
          {!modelLoading ? (
            <Button
              size="compact"
              variant="secondary"
              icon={<RefreshCcw aria-hidden="true" size={14} />}
              onClick={() => void loadModelCatalog()}
            >
              重试模型目录
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {endpointConfigurationRejected ? (
        <Alert className="apiKeyConnectionAlert" tone="danger" title="连接 Endpoint 已拒绝">
          服务端视频 Endpoint 含凭据、片段或不受支持的格式；视频请求示例已禁用，且不会回显该值。
        </Alert>
      ) : null}
      {apiKeys.some((key) => key.permissions.includes("relay:video_generation")) && <section className="apiKeyProjectAuthority" aria-label="连接示例项目权限">
        <label className="apiKeyFilterField">
          <span>连接示例活动项目</span>
          <Select
            aria-label="连接示例活动项目"
            value={connectionProjectId === null ? "" : String(connectionProjectId)}
            disabled={connectionProjectsLoading || !connectionProjects.length}
            onChange={(event) => selectConnectionProject(event.currentTarget.value || null)}
          >
            <option value="">请选择当前工作区项目</option>
            {connectionProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}（ID: {project.id}）
              </option>
            ))}
          </Select>
        </label>
        <div>
          {connectionProjectsLoading ? "正在验证当前工作区的活动项目权限。" : null}
          {!connectionProjectsLoading && !connectionProjectsError && !connectionProjects.length
            ? "当前工作区没有可用的活动项目，视频请求示例待配置。"
            : null}
          {!connectionProjectsLoading && !connectionProjectsError && connectionProjects.length && connectionProjectId === null
            ? "请选择活动项目以生成可执行的视频请求示例；文本与 MCP 配置仍可复制。"
            : null}
          {connectionProjectsError ? (
            <>
              <span>{connectionProjectsError}</span>
              <Button size="compact" variant="secondary" onClick={retryConnectionProjects}>
                重试项目权限
              </Button>
            </>
          ) : null}
        </div>
      </section>}

      <FilterBar
        advanced={(
          <label className="apiKeyFilterField">
            <span>密钥前缀</span>
            <Input aria-label="按 API 密钥前缀筛选" placeholder="例如 fj_live" value={prefixFilter} onChange={(event) => setPrefixFilter(event.currentTarget.value)} />
          </label>
        )}
        activeAdvancedCount={prefixFilter ? 1 : 0}
        actions={(
          <>
            {hasFilters && <Button variant="ghost" onClick={() => { setNameFilter(""); setPrefixFilter(""); setStatusFilter("all"); }}>重置筛选</Button>}
            <Button variant="secondary" icon={<RefreshCcw aria-hidden="true" size={16} />} loading={apiKeyLoading} onClick={() => void loadKeys()}>刷新</Button>
          </>
        )}
      >
        <label className="apiKeyFilterField">
          <span>名称</span>
          <Input aria-label="按名称筛选 API 密钥" placeholder="搜索密钥名称" value={nameFilter} onChange={(event) => setNameFilter(event.currentTarget.value)} />
        </label>
        <label className="apiKeyFilterField apiKeyFilterField--status">
          <span>状态</span>
          <Select aria-label="按 API 密钥状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as "all" | ApiKeyStatus)}>
            <option value="all">全部状态</option>
            <option value="active">已启用</option>
            <option value="disabled">已停用</option>
          </Select>
        </label>
      </FilterBar>

      {selectedRows.length > 0 && (
        <section className="apiKeyBatchBar" aria-label="API 密钥批量操作">
          <div><strong>已选择 {selectedRows.length} 个密钥</strong><span>批量操作仅作用于当前筛选结果。</span></div>
          <div className="apiKeyBatchActions">
            <Button
              variant="secondary"
              icon={<Copy aria-hidden="true" size={16} />}
              disabled={selectedConnectionInfoUnavailable}
              onClick={() => void copyConnectionInfo(selectedRows)}
            >
              复制连接信息
            </Button>
            <Button variant="secondary" icon={<Download aria-hidden="true" size={16} />} onClick={exportSelectedCsv}>导出清单</Button>
            <Button variant="danger" disabled={!canWriteKeys} icon={<Trash2 aria-hidden="true" size={16} />} loading={batchDeleting} onClick={handleBatchRevoke}>批量撤销</Button>
          </div>
          {selectedConnectionInfoUnavailable ? (
            <Alert className="apiKeyConnectionAlert" tone="warning">
              {modelLoading || connectionProjectsLoading
                ? "正在读取当前工作区模型目录，暂时无法复制连接示例。"
                : connectionProjectsError
                  ? connectionProjectsError
                  : connectionProjectId === null
                    ? "请先明确选择当前工作区的活动项目，无法自动推断项目。"
                : modelLoadError
                  ? "模型目录加载失败，无法确认真实模型；请刷新后重试。"
                  : "所选密钥当前没有可用的真实模型，无法生成连接示例。"}
            </Alert>
          ) : null}
        </section>
      )}

      <DataTable
        rows={filteredKeys}
        columns={columns}
        getRowId={(row) => row.id}
        ariaLabel="API 密钥列表"
        loading={apiKeyLoading}
        error={loadError || undefined}
        onRetry={() => void loadKeys()}
        emptyState={hasFilters ? "没有匹配当前筛选条件的 API 密钥" : "暂无 API 密钥，请先创建密钥"}
        onRowClick={setDetailKey}
        getRowAriaLabel={(row) => `查看 API 密钥 ${row.name} 详情`}
        defaultPageSize={20}
      />

      <Drawer
        open={Boolean(detailKey)}
        title={detailKey?.name || "API 密钥详情"}
        description="查看额度、访问范围、使用时间和连接上下文。"
        size="min(680px, 100vw)"
        className="apiKeyOverlay"
        onOpenChange={(open) => { if (!open) setDetailKey(null); }}
        footer={detailKey ? (
          <div className="apiKeyOverlayActions">
            {hasRelayKey(detailKey) && <Button
              variant="secondary"
              icon={<Copy aria-hidden="true" size={16} />}
              disabled={detailConnectionInfoUnavailable}
              onClick={() => void copyConnectionInfo([detailKey], "relay")}
            >
              {isMcpKey(detailKey) ? "复制 API 中转配置" : "复制连接信息"}
            </Button>}
            {isMcpKey(detailKey) && <Button
              variant="secondary"
              icon={<Copy aria-hidden="true" size={16} />}
              disabled={!toolConnectionInfoText(detailKey)}
              onClick={() => void copyConnectionInfo([detailKey], "tool")}
            >
              复制 MCP / CLI 配置
            </Button>}
            {!isRevokedApiKey(detailKey) ? <Button disabled={!canWriteKeys} icon={<Pencil aria-hidden="true" size={16} />} onClick={() => { const row = detailKey; setDetailKey(null); openEditKey(row); }}>编辑密钥</Button> : null}
          </div>
        ) : undefined}
      >
        {detailKey && (
          <div className="apiKeyDetails">
            <dl>
              <div><dt>状态</dt><dd><Badge tone={detailKey.status === "active" ? "success" : "neutral"}>{statusText(detailKey)}</Badge></dd></div>
              <div><dt>密钥前缀</dt><dd><code>{maskedKey(detailKey)}</code></dd></div>
              <div><dt>额度</dt><dd>{quotaText(detailKey)}</dd></div>
              <div><dt>每分钟限速</dt><dd>{detailKey.rateLimitPerMinute ? `${detailKey.rateLimitPerMinute} 次` : "无限制"}</dd></div>
              <div><dt>模型范围</dt><dd>{detailKey.modelAllowlist.length ? detailKey.modelAllowlist.join("、") : "全部模型"}</dd></div>
              <div><dt>接入方式</dt><dd>{[hasRelayKey(detailKey) && "API 中转", isMcpKey(detailKey) && "MCP / CLI"].filter(Boolean).join("、") || "未授权"}</dd></div>
              <div><dt>接口权限</dt><dd>{detailKey.permissions.length ? detailKey.permissions.join("、") : "无有效接口权限"}</dd></div>
              <div><dt>IP 白名单</dt><dd>{detailKey.ipAllowlist.length ? detailKey.ipAllowlist.join("、") : "无限制"}</dd></div>
              <div><dt>创建时间</dt><dd>{detailKey.createdAt}</dd></div>
              <div><dt>最后使用</dt><dd>{detailKey.lastUsedAt}</dd></div>
              <div><dt>到期时间</dt><dd>{detailKey.expiresAt}</dd></div>
              {detailKey.permissions.includes("relay:text") && <div><dt>文本 API</dt><dd><code>{routeEndpoint("/v1/chat/completions") || "地址尚未配置"}</code></dd></div>}
              {detailKey.permissions.includes("relay:video_generation") && <div><dt>视频 API</dt><dd><code>{developerEndpointRejected ? "地址尚未配置" : endpointUrl || "地址尚未配置"}</code></dd></div>}
              {detailKey.permissions.includes("relay:image_generation") && <div><dt>图像 API</dt><dd><code>{routeEndpoint("/v1/images/generations") || "地址尚未配置"}</code></dd></div>}
              {detailKey.permissions.some((permission) => permission.startsWith("relay:portrait_assets:")) && <div><dt>人像资产 API</dt><dd><code>{routeEndpoint("/api/v3/portrait-assets") || "地址尚未配置"}</code></dd></div>}
              {isMcpKey(detailKey) && <div><dt>MCP Endpoint</dt><dd><code>{`${readApiSettings().baseUrl.replace(/\/+$/, "")}/mcp`}</code></dd></div>}
            </dl>
            {detailConnectionInfoUnavailable ? (
              <Alert className="apiKeyConnectionAlert" tone="warning">
                {modelLoading || connectionProjectsLoading
                  ? "正在读取当前工作区模型目录，暂时无法复制连接示例。"
                  : connectionProjectsError
                    ? connectionProjectsError
                    : connectionProjectId === null
                      ? "请先明确选择当前工作区的活动项目，无法自动推断项目。"
                  : modelLoadError
                    ? "模型目录加载失败，无法确认真实模型；请刷新后重试。"
                    : "此密钥当前没有可用的真实模型，无法生成连接示例。"}
              </Alert>
            ) : null}
          </div>
        )}
      </Drawer>

      <Drawer
        open={drawerVisible}
        title={drawerMode === "create" ? (connections ? "创建连接密钥" : "创建 API 密钥") : "更新 API 密钥"}
        description="配置密钥有效期、额度和访问范围；高级选项默认收起。"
        size="min(900px, 100vw)"
        className="apiKeyOverlay"
        dirty={formDirty}
        loading={saving}
        initialFocusRef={nameInputRef}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setDrawerVisible(false);
            setFormError("");
            setFormSubmitted(false);
          }
        }}
        footer={(
          <div className="apiKeyOverlayActions">
            <Button
              type="submit"
              form="api-key-form"
              icon={<KeyRound aria-hidden="true" size={16} />}
              loading={saving}
              disabled={!form.name.trim() || !form.permissions.length || editingHasUnknownPermissions || (formNeedsModelCatalog && !modelCatalogReady)}
            >
              {drawerMode === "create" ? "创建密钥" : "保存更改"}
            </Button>
          </div>
        )}
      >
        <form id="api-key-form" className="apiKeyForm" onSubmit={(event) => { event.preventDefault(); void handleSaveKey(); }}>
          {formError && <Alert tone="danger" title="API 密钥保存失败">{formError}</Alert>}
          {editingHasUnknownPermissions && <Alert tone="warning">此密钥包含当前界面无法识别的权限，已阻止编辑以免意外改写。请联系管理员核对权限。</Alert>}

          <FieldGroup legend="基本信息" description="名称用于区分调用方；到期策略会在服务端校验。" disabled={saving}>
            <div className="apiKeyFormGrid">
              <FormField label="名称" required error={formSubmitted && !form.name.trim() ? "请输入密钥名称" : undefined}>
                <Input
                  ref={nameInputRef}
                  value={form.name}
                  placeholder="例如：生产环境密钥"
                  autoComplete="off"
                  onChange={(event) => {
                    const name = event.currentTarget.value;
                    setForm((current) => ({ ...current, name }));
                  }}
                />
              </FormField>
              <FormField label="过期策略" help={form.expiryMode === "never" ? "当前密钥不会自动过期。" : form.expiresAt ? `预计到期：${formatTime(form.expiresAt)}` : "请选择有效期。"}>
                <Select value={form.expiryPreset} onChange={(event) => applyExpiryPreset(event.currentTarget.value)}>
                  {EXPIRY_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
                  {form.expiryPreset === "custom" && <option value="custom">保留当前到期时间</option>}
                </Select>
              </FormField>
            </div>
          </FieldGroup>

          {!connections && <FieldGroup legend="API 中转权限" description="按调用接口选择权限；新密钥默认只允许视频生成，不会自动获得文本、图像或 MCP 权限。" disabled={saving}>
            <ApiKeyOptionChecklist aria-label="API 中转权限">
              {RELAY_PERMISSION_OPTIONS.filter((permission) => permission.value.startsWith("relay:")).map((permission) => (
                <label className="apiKeyOptionChecklistItem" key={permission.value}>
                  <Checkbox
                    checked={form.permissions.includes(permission.value)}
                    aria-label={`允许权限 ${permission.label}`}
                    onCheckedChange={(checked) => setForm((current) => ({
                      ...current,
                      permissions: checked
                        ? exactRelayPermissions([...current.permissions, permission.value])
                        : current.permissions.filter((value) => value !== permission.value),
                    }))}
                  />
                  <span><strong>{permission.label}</strong><small>{permission.value}</small></span>
                </label>
              ))}
            </ApiKeyOptionChecklist>
          </FieldGroup>}

          {connections && drawerMode === "edit" && hasApiRelayPermission(form.permissions) && (
            <Alert tone="info">此密钥同时拥有 API 中转权限。调整 MCP / CLI 预设会保留中转权限；如需修改中转范围，请前往 API 中转密钥页面。</Alert>
          )}

          <FieldGroup legend="GU 额度设置" description="与工作区账单使用同一 GU 计费口径；预扣、结算、释放和退款会同步更新。" disabled={saving}>
            <Switch checked={form.unlimitedQuota} onCheckedChange={(checked) => setForm((current) => ({ ...current, unlimitedQuota: checked }))} label="无限额度" description="允许该密钥不受单独 GU 消耗上限限制，但仍记录实际 GU 用量。" />
            {!form.unlimitedQuota && (
              <FormField label="GU 消耗上限" help="按工作区账单实际 GU 成本累计，不再按调用次数计数。">
                <NumberInput value={form.quotaLimit} min={0} step={100} onValueChange={(value) => setForm((current) => ({ ...current, quotaLimit: value ?? 0 }))} />
              </FormField>
            )}
          </FieldGroup>

          {(connections || form.permissions.includes("mcp:connect")) && (
            <FieldGroup legend="工具权限" description="权限与当前成员权限共同生效；创作密钥不能自行批准扣费。" disabled={saving}>
              <div className="toolPermissionPresets">
                {([
                  ["read", "只读查询", "查看项目、模型、素材及审核状态、任务与余额。"],
                  ["create", "完整创作", "增加创建项目、上传并审核素材、报价、生成与下载。"],
                ] as const).map(([value, label, description]) => (
                  <label className="toolPreset" key={value}>
                    <input type="radio" name="tool-permission-preset" value={value}
                      checked={toolPermissionPreset(form.permissions) === value}
                      onChange={() => setForm((current) => ({ ...current, permissions: exactRelayPermissions(applyToolPermissionPreset(current.permissions, value)) }))} />
                    <span><strong>{label}</strong><small>{description}</small></span>
                  </label>
                ))}
              </div>
              {toolPermissionPreset(form.permissions) === "custom" && <p>当前为自定义权限，可在高级设置中调整。</p>}
              <p>人物参考素材上传后由平台处理审核，可通过素材查询查看进度，无需另配火山密钥。需要本人确认的来源或授权，请在项目素材中完成。</p>
              {form.permissions.includes("generation:create") && <Alert tone="info">生成前先报价，再由你登录网页确认本次最高 GU 费用；密钥不能代替你批准。</Alert>}
            </FieldGroup>
          )}

          <Accordion className="apiKeyAdvanced">
            <AccordionItem value="api-key-advanced-settings">
              <AccordionTrigger>
                <span>高级设置</span>
                <small>{advancedSettingCount ? `已配置 ${advancedSettingCount} 项` : "按需配置模型、权限、限速和 IP"}</small>
              </AccordionTrigger>
              <AccordionContent contentClassName="apiKeyAdvancedContent">
                <FieldGroup legend="访问范围与限制" description="留空表示不单独限制；所有设置均由服务端强制执行。" disabled={saving}>
              <div className="apiKeyFormGrid apiKeyFormGrid--advanced" data-responsive-layout="auto-fit">
                <FormField
                  label="模型限制"
                  help={modelLoading ? "模型加载中…" : modelCatalogReady ? "直接勾选允许调用的模型；“全部模型”表示不设置模型白名单。" : modelLoadError}
                  error={!modelLoading && !modelCatalogReady ? modelLoadError || undefined : undefined}
                >
                  <ApiKeyOptionChecklist
                    aria-label="模型限制"
                    disabled={!modelCatalogReady}
                  >
                    <label className="apiKeyOptionChecklistItem apiKeyOptionChecklistItem--all">
                      <Checkbox
                        disabled={!modelCatalogReady}
                        checked={form.modelAllowlist.length === 0}
                        aria-label="允许全部模型"
                        onCheckedChange={() => setForm((current) => ({ ...current, modelAllowlist: [] }))}
                      />
                      <span><strong>全部模型</strong><small>自动包含当前及后续上线模型</small></span>
                    </label>
                    {modelOptions.map((model) => (
                      <label className="apiKeyOptionChecklistItem" key={model.selectionKey}>
                        <Checkbox
                          checked={form.modelAllowlist.includes(model.value)}
                          disabled={!modelCatalogReady}
                          aria-label={`允许模型 ${model.label}`}
                          onCheckedChange={(checked) => setForm((current) => {
                            const modelAllowlist = checked
                              ? Array.from(new Set([...current.modelAllowlist, model.value]))
                              : current.modelAllowlist.filter((value) => value !== model.value);
                            return { ...current, modelAllowlist };
                          })}
                        />
                        <span><strong>{model.label}</strong><small>{model.endpointType} · {model.value}</small></span>
                      </label>
                    ))}
                    {!modelLoading && !modelCatalogReady ? (
                      <Button
                        size="compact"
                        variant="secondary"
                        icon={<RefreshCcw aria-hidden="true" size={14} />}
                        onClick={() => void loadModelCatalog()}
                      >
                        重试模型目录
                      </Button>
                    ) : null}
                  </ApiKeyOptionChecklist>
                </FormField>
                <FormField label="接口权限" help="选择密钥可访问的能力范围；至少保留一项权限。">
                  <ApiKeyOptionChecklist aria-label="接口权限">
                    {RELAY_PERMISSION_OPTIONS.filter(permission => !permission.value.startsWith("relay:")).map((permission) => {
                      const checked = form.permissions.includes(permission.value);
                      return (
                        <label className="apiKeyOptionChecklistItem" key={permission.value}>
                          <Checkbox
                            checked={checked}
                            aria-label={`允许权限 ${permission.label}`}
                            onCheckedChange={(nextChecked) => setForm((current) => {
                              const permissions = nextChecked
                                ? exactRelayPermissions([
                                    ...current.permissions,
                                    permission.value,
                                  ])
                                : current.permissions.filter(
                                    (value) => value !== permission.value,
                                  );
                              return { ...current, permissions };
                            })}
                          />
                          <span><strong>{permission.label}</strong><small>{permission.value}</small></span>
                        </label>
                      );
                    })}
                  </ApiKeyOptionChecklist>
                </FormField>
              </div>
              <FormField label="每分钟限速" help="填 0 表示不单独限制。">
                <NumberInput value={form.rateLimitPerMinute} min={0} step={10} onValueChange={(value) => setForm((current) => ({ ...current, rateLimitPerMinute: value ?? 0 }))} />
              </FormField>
              <FormField label="IP 白名单（支持 CIDR）" help="每行一个 IP 或 CIDR；留空表示不限制来源 IP。">
                <CodeEditor
                  language="text"
                  minRows={4}
                  value={form.ipAllowlistText}
                  placeholder="203.0.113.10&#10;203.0.113.0/24"
                  onChange={(event) => {
                    const ipAllowlistText = event.currentTarget.value;
                    setForm((current) => ({ ...current, ipAllowlistText }));
                  }}
                />
              </FormField>
                </FieldGroup>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </form>
      </Drawer>

      <Dialog
        open={secretVisible}
        title={secretTitle}
        description="明文密钥只显示这一次，请先保存到可信的密钥管理系统。"
        size="lg"
        backdrop="static"
        showCloseButton={false}
        className="apiKeySecretDialog"
        onOpenChange={(open) => { if (!open) closeSecret(); }}
        footer={(
          <div className="apiKeyOverlayActions">
            <Button variant="secondary" icon={<Copy aria-hidden="true" size={16} />} disabled={!visibleSecret} onClick={() => void copyWithToast(visibleSecret)}>复制密钥</Button>
            <Button onClick={closeSecret}>我已安全保存</Button>
          </div>
        )}
      >
        <div className="apiKeySecretContent">
          <Alert tone={visibleSecret ? "warning" : "danger"}>
            {visibleSecret ? "关闭后无法再次查看该明文密钥。" : "服务端未返回明文密钥，请关闭后重新创建或联系管理员。"}
          </Alert>
          {visibleSecret && <code className="apiKeySecretValue">{visibleSecret}</code>}
          {visibleSecret && secretHasRelay && <p className="apiKeySecretAccess">此密钥已开通所选 API 中转权限。请求地址与示例可在 <a href="#/developer/api/docs">API 文档</a> 中查看；请按所授予的 relay 权限调用。</p>}
          {visibleSecret && secretIsTool && <ToolConnectionSetup baseUrl={readApiSettings().baseUrl} secret={visibleSecret} workspaceId={currentWorkspaceId} onCopy={text => copyWithToast(text, true)} />}
          {visibleSecret && !secretIsTool && !secretHasRelay && <p>建议保存到服务器环境变量或专业密钥管理系统，不要通过聊天或邮件明文传输。</p>}
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={confirmAction?.title || "确认操作"}
        description={confirmAction?.description}
        confirmLabel={confirmAction?.confirmLabel}
        tone={confirmAction?.tone}
        onCancel={() => setConfirmAction(null)}
        onConfirm={async () => {
          if (!confirmAction) return false;
          await confirmAction.onConfirm();
          return true;
        }}
        onConfirmError={(caught) => {
          const message = caught instanceof Error ? caught.message : "操作失败，请稍后重试";
          toast({ title: message, tone: "danger" });
        }}
      />
    </section>
  );
}
