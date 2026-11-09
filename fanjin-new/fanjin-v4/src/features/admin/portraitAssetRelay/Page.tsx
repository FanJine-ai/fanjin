import { useCallback, useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  Edit3,
  ExternalLink,
  Fingerprint,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";

import { useAuthStore } from "../../../stores/authStore";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  Drawer,
  FilterBar,
  FormField,
  FormGrid,
  Input,
  MetricStrip,
  Select,
  Switch,
  Tabs,
  useToast,
  type DataTableColumn,
} from "../../../ui/console";
import { listPortraitAssets, newIdempotencyKey, runPortraitAssetAction } from "./api";
import {
  portraitWriteRetryDisposition,
  resolvePortraitWriteKey,
  type PortraitWriteKeyState,
} from "./idempotency";
import type {
  PortraitAssetRow,
  PortraitGroupRow,
  PortraitRelayResponse,
  PortraitRelaySnapshot,
  PortraitRelayTime,
} from "./types";
import "./styles.css";

const emptySnapshot: PortraitRelaySnapshot = {
  groups: [],
  assets: [],
  refreshedAt: null,
  metrics: {
    groupCount: 0,
    assetCount: 0,
    activeAssetCount: 0,
    processingAssetCount: 0,
    failedAssetCount: 0,
  },
};

type GroupForm = {
  id: string;
  name: string;
  description: string;
  groupType: "AIGC" | "LivenessFace";
};

type AssetForm = {
  id: string;
  groupId: string;
  name: string;
  assetType: "Image" | "Video" | "Audio";
  url: string;
  consent: boolean;
};

const emptyGroup: GroupForm = { id: "", name: "", description: "", groupType: "AIGC" };
const emptyAsset: AssetForm = {
  id: "",
  groupId: "",
  name: "",
  assetType: "Image",
  url: "",
  consent: false,
};

function parseTime(value: PortraitRelayTime): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTime(value: PortraitRelayTime) {
  const timestamp = parseTime(value);
  return timestamp === null
    ? "-"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(timestamp);
}

function groupTypeLabel(value: string): string {
  if (value === "AIGC") return "虚拟人像";
  if (value === "LivenessFace") return "真人人像";
  return value || "未知";
}

function assetTypeLabel(value: string): string {
  if (value === "Image") return "图片";
  if (value === "Video") return "视频";
  if (value === "Audio") return "音频";
  return value || "未知";
}

function editableAssetType(value: string): AssetForm["assetType"] {
  return value === "Video" || value === "Audio" ? value : "Image";
}

function StatusBadge({ status }: { status: string | null }) {
  if (status === "Active") return <Badge tone="success">可用</Badge>;
  if (status === "Failed") return <Badge tone="danger">失败</Badge>;
  if (status === "Processing") return <Badge tone="warning">处理中</Badge>;
  return <Badge tone="neutral">未知</Badge>;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function safeResponseJson(value: unknown): string {
  return JSON.stringify(value, (key, item) => {
    const normalizedKey = key.toLowerCase();
    return normalizedKey.includes("token") || normalizedKey.includes("link")
      ? "[已隐藏]"
      : item;
  }, 2);
}

function writeFailureFeedback(caught: unknown): { message: string; retainKey: boolean } {
  const message = caught instanceof Error ? caught.message : "请稍后重试";
  const retainKey = portraitWriteRetryDisposition(caught) === "retain-key";
  return {
    retainKey,
    message: retainKey
      ? `${message}。本次幂等键已保留，不会自动生成新的上游变更；请先人工核查火山状态，再以同一操作重试幂等结果。`
      : `${message}。本次已明确失败或未发往上游；修复配置或输入后，下次点击将使用新幂等键发起“新尝试”。`,
  };
}

export default function AdminPortraitAssetRelayPage() {
  const currentWorkspace = useAuthStore((state) => state.currentWorkspace) as { id?: string } | null;
  const initialWorkspaceId = String(currentWorkspace?.id || "");
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [draftWorkspaceId, setDraftWorkspaceId] = useState(initialWorkspaceId);
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("groups");
  const [groupForm, setGroupForm] = useState<GroupForm | null>(null);
  const [initialGroupForm, setInitialGroupForm] = useState<GroupForm | null>(null);
  const [assetForm, setAssetForm] = useState<AssetForm | null>(null);
  const [initialAssetForm, setInitialAssetForm] = useState<AssetForm | null>(null);
  const [livenessOpen, setLivenessOpen] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [bytedToken, setBytedToken] = useState("");
  const [h5Link, setH5Link] = useState("");
  const [livenessResult, setLivenessResult] = useState<PortraitRelayResponse | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: "group" | "asset";
    id: string;
    label: string;
  } | null>(null);
  const requestSequence = useRef(0);
  const writeKeyState = useRef<PortraitWriteKeyState | null>(null);
  const { toast } = useToast();
  const actionPending = pendingAction !== null;
  const groupSavePending = pendingAction === "group:save";
  const assetSavePending = pendingAction === "asset:save";
  const livenessPending = pendingAction === "liveness:create" || pendingAction === "liveness:result";
  const groupDirty = Boolean(groupForm && initialGroupForm)
    && JSON.stringify(groupForm) !== JSON.stringify(initialGroupForm);
  const assetDirty = Boolean(assetForm && initialAssetForm)
    && JSON.stringify(assetForm) !== JSON.stringify(initialAssetForm);

  const openGroupForm = (nextForm: GroupForm) => {
    setInitialGroupForm({ ...nextForm });
    setGroupForm({ ...nextForm });
  };

  const closeGroupForm = () => {
    writeKeyState.current = null;
    setGroupForm(null);
    setInitialGroupForm(null);
  };

  const openAssetForm = (nextForm: AssetForm) => {
    setInitialAssetForm({ ...nextForm });
    setAssetForm({ ...nextForm });
  };

  const closeAssetForm = () => {
    writeKeyState.current = null;
    setAssetForm(null);
    setInitialAssetForm(null);
  };

  const reload = useCallback(async (signal?: AbortSignal) => {
    const selectedWorkspaceId = workspaceId.trim();
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    if (!selectedWorkspaceId) {
      setSnapshot(emptySnapshot);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    setSnapshot(emptySnapshot);
    try {
      const nextSnapshot = await listPortraitAssets(selectedWorkspaceId, signal);
      if (requestSequence.current === requestId) setSnapshot(nextSnapshot);
    } catch (caught) {
      if (signal?.aborted) return;
      if (requestSequence.current === requestId) {
        setError(caught instanceof Error ? caught.message : "人像资产读取失败");
      }
    } finally {
      if (requestSequence.current === requestId) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const currentId = String(currentWorkspace?.id || "").trim();
    if (!currentId || workspaceId || draftWorkspaceId) return;
    setWorkspaceId(currentId);
    setDraftWorkspaceId(currentId);
  }, [currentWorkspace?.id, draftWorkspaceId, workspaceId]);

  const requireWorkspace = () => {
    if (workspaceId.trim()) return true;
    toast({
      title: "需要工作区",
      message: "先输入并查询一个工作区 ID，再执行人像资产操作。",
      tone: "warning",
    });
    return false;
  };

  const applyWorkspaceFilter = () => {
    const nextWorkspaceId = draftWorkspaceId.trim();
    if (!nextWorkspaceId) {
      toast({ title: "请输入工作区 ID", message: "该页面不支持跨工作区聚合查询。", tone: "warning" });
      return;
    }
    if (nextWorkspaceId === workspaceId) {
      void reload();
      return;
    }
    setSnapshot(emptySnapshot);
    setError("");
    setWorkspaceId(nextWorkspaceId);
  };

  const runAction = async (
    Action: Parameters<typeof runPortraitAssetAction>[0]["Action"],
    Body: Record<string, unknown>,
    options: { consent?: boolean; write?: boolean } = {},
  ) => {
    if (!requireWorkspace()) throw new Error("需要工作区 ID");
    const operation = {
      Action,
      Body,
      workspaceId,
      consentConfirmed: options.consent,
    };
    if (!options.write) return runPortraitAssetAction(operation);
    const keyState = resolvePortraitWriteKey(
      writeKeyState.current,
      {
        action: Action,
        body: Body,
        workspaceId,
        consentConfirmed: options.consent,
      },
      newIdempotencyKey,
    );
    writeKeyState.current = keyState;
    const response = await runPortraitAssetAction({ ...operation, idempotencyKey: keyState.key });
    if (writeKeyState.current?.fingerprint === keyState.fingerprint) writeKeyState.current = null;
    return response;
  };

  const saveGroup = async () => {
    if (!groupForm || !groupForm.name.trim() || actionPending) return;
    setPendingAction("group:save");
    try {
      if (groupForm.id) {
        await runAction("UpdateAssetGroup", {
          Id: groupForm.id,
          Name: groupForm.name.trim(),
          Description: groupForm.description.trim(),
        }, { write: true });
      } else {
        await runAction("CreateAssetGroup", {
          Name: groupForm.name.trim(),
          Description: groupForm.description.trim(),
          GroupType: "AIGC",
        }, { write: true });
      }
      toast({ title: groupForm.id ? "火山资产组已更新" : "火山资产组已创建", tone: "success" });
      closeGroupForm();
      await reload();
    } catch (caught) {
      const failure = writeFailureFeedback(caught);
      if (!failure.retainKey) writeKeyState.current = null;
      toast({
        title: "资产组保存失败",
        message: failure.message,
        tone: "danger",
      });
    } finally {
      setPendingAction(null);
    }
  };

  const saveAsset = async () => {
    if (!assetForm || !assetForm.name.trim() || actionPending) return;
    setPendingAction("asset:save");
    try {
      if (assetForm.id) {
        await runAction("UpdateAsset", {
          Id: assetForm.id,
          Name: assetForm.name.trim(),
        }, { write: true });
      } else {
        await runAction("CreateAsset", {
          GroupId: assetForm.groupId,
          Name: assetForm.name.trim(),
          AssetType: assetForm.assetType,
          URL: assetForm.url.trim(),
        }, { consent: assetForm.consent, write: true });
      }
      toast({
        title: assetForm.id ? "火山资产名称已更新" : "素材已提交给火山处理",
        message: assetForm.id ? undefined : "素材会先处于处理中，请刷新查看上游状态。",
        tone: "success",
      });
      closeAssetForm();
      await reload();
    } catch (caught) {
      const failure = writeFailureFeedback(caught);
      if (!failure.retainKey) writeKeyState.current = null;
      toast({
        title: "资产保存失败",
        message: failure.message,
        tone: "danger",
      });
    } finally {
      setPendingAction(null);
    }
  };

  const refreshResource = async (kind: "group" | "asset", id: string) => {
    if (actionPending) return;
    setPendingAction(`${kind}:refresh:${id}`);
    try {
      await runAction(kind === "group" ? "GetAssetGroup" : "GetAsset", { Id: id });
      await reload();
      toast({ title: "已读取最新上游状态", tone: "success" });
    } catch (caught) {
      toast({
        title: "刷新失败",
        message: caught instanceof Error ? caught.message : "请稍后重试",
        tone: "danger",
      });
    } finally {
      setPendingAction(null);
    }
  };

  const deleteResource = async () => {
    if (!deleteTarget || actionPending) return false;
    setPendingAction(`${deleteTarget.kind}:delete:${deleteTarget.id}`);
    try {
      await runAction(
        deleteTarget.kind === "group" ? "DeleteAssetGroup" : "DeleteAsset",
        { Id: deleteTarget.id },
        { write: true },
      );
      toast({
        title: deleteTarget.kind === "group" ? "火山资产组已删除" : "火山资产已删除",
        tone: "success",
      });
      setDeleteTarget(null);
      await reload();
      return true;
    } catch (caught) {
      const failure = writeFailureFeedback(caught);
      if (!failure.retainKey) writeKeyState.current = null;
      toast({
        title: "删除失败",
        message: failure.message,
        tone: "danger",
      });
      return false;
    } finally {
      setPendingAction(null);
    }
  };

  const createLiveness = async () => {
    if (!isHttpsUrl(callbackUrl.trim()) || actionPending) return;
    setH5Link("");
    setLivenessResult(null);
    setPendingAction("liveness:create");
    try {
      const response = await runAction(
        "CreateVisualValidateSession",
        { CallbackURL: callbackUrl.trim() },
        { write: true },
      );
      setLivenessResult(response);
      const token = String(response.Result.BytedToken || "").trim();
      const link = String(response.Result.H5Link || "").trim();
      if (token) setBytedToken(token);
      setH5Link(isHttpsUrl(link) ? link : "");
      toast({ title: "真人认证会话已创建", message: "请在有效期内完成上游 H5 认证。", tone: "success" });
    } catch (caught) {
      const failure = writeFailureFeedback(caught);
      if (!failure.retainKey) writeKeyState.current = null;
      toast({
        title: "认证会话创建失败",
        message: failure.message,
        tone: "danger",
      });
    } finally {
      setPendingAction(null);
    }
  };

  const getLivenessResult = async () => {
    if (!bytedToken.trim() || actionPending) return;
    setPendingAction("liveness:result");
    try {
      const response = await runAction("GetVisualValidateResult", { BytedToken: bytedToken.trim() });
      setLivenessResult(response);
      await reload();
      toast({ title: "已读取真人认证结果", tone: "success" });
    } catch (caught) {
      toast({
        title: "认证结果读取失败",
        message: caught instanceof Error ? caught.message : "请稍后重试",
        tone: "danger",
      });
    } finally {
      setPendingAction(null);
    }
  };

  const groupColumns: DataTableColumn<PortraitGroupRow>[] = [
    {
      id: "name",
      header: "资产组",
      priority: "primary",
      minWidth: "210px",
      cell: (row) => (
        <div className="portraitRelayIdentity">
          <strong>{row.name || "未命名资产组"}</strong>
          <code title={row.upstreamGroupId}>{row.upstreamGroupId}</code>
        </div>
      ),
    },
    {
      id: "type",
      header: "类型",
      priority: "primary",
      cell: (row) => groupTypeLabel(row.groupType),
    },
    { id: "project", header: "火山项目", accessor: (row) => row.projectName || "服务端绑定", priority: "secondary" },
    {
      id: "updated",
      header: "上游更新时间",
      priority: "secondary",
      cell: (row) => formatTime(row.updateTime),
      sortValue: (row) => parseTime(row.updateTime),
      sortable: true,
    },
    {
      id: "actions",
      header: "操作",
      hideable: false,
      priority: "primary",
      minWidth: "220px",
      cell: (row) => (
        <div className="portraitRelayRowActions">
          <Button
            size="compact"
            variant="ghost"
            icon={<RefreshCcw size={15} />}
            disabled={actionPending}
            loading={pendingAction === `group:refresh:${row.upstreamGroupId}`}
            onClick={() => void refreshResource("group", row.upstreamGroupId)}
          >
            刷新
          </Button>
          <Button
            size="compact"
            variant="secondary"
            icon={<Edit3 size={15} />}
            disabled={actionPending}
            onClick={() => openGroupForm({
              id: row.upstreamGroupId,
              name: row.name || "",
              description: row.description || "",
              groupType: row.groupType === "LivenessFace" ? "LivenessFace" : "AIGC",
            })}
          >
            编辑
          </Button>
          <Button
            size="compact"
            variant="danger"
            icon={<Trash2 size={15} />}
            disabled={actionPending}
            onClick={() => setDeleteTarget({
              kind: "group",
              id: row.upstreamGroupId,
              label: row.name || row.upstreamGroupId,
            })}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  const assetColumns: DataTableColumn<PortraitAssetRow>[] = [
    {
      id: "name",
      header: "资产",
      priority: "primary",
      minWidth: "210px",
      cell: (row) => (
        <div className="portraitRelayIdentity">
          <strong>{row.name || "未命名资产"}</strong>
          <code title={row.upstreamAssetId}>{row.upstreamAssetId}</code>
        </div>
      ),
    },
    { id: "type", header: "媒体", priority: "secondary", cell: (row) => assetTypeLabel(row.assetType) },
    {
      id: "status",
      header: "上游状态",
      priority: "primary",
      minWidth: "150px",
      cell: (row) => (
        <div className="portraitRelayStateCell">
          <StatusBadge status={row.upstreamStatus} />
          {row.errorMessage ? <small title={row.errorMessage}>{row.errorMessage}</small> : null}
        </div>
      ),
    },
    {
      id: "group",
      header: "所属资产组",
      priority: "detail",
      cell: (row) => <code className="portraitRelayInlineCode" title={row.groupId}>{row.groupId || "-"}</code>,
    },
    {
      id: "updated",
      header: "上游更新时间",
      priority: "secondary",
      cell: (row) => formatTime(row.updateTime),
      sortValue: (row) => parseTime(row.updateTime),
      sortable: true,
    },
    {
      id: "actions",
      header: "操作",
      hideable: false,
      priority: "primary",
      minWidth: "220px",
      cell: (row) => (
        <div className="portraitRelayRowActions">
          <Button
            size="compact"
            variant="ghost"
            icon={<RefreshCcw size={15} />}
            disabled={actionPending}
            loading={pendingAction === `asset:refresh:${row.upstreamAssetId}`}
            onClick={() => void refreshResource("asset", row.upstreamAssetId)}
          >
            刷新
          </Button>
          <Button
            size="compact"
            variant="secondary"
            icon={<Edit3 size={15} />}
            disabled={actionPending}
            onClick={() => openAssetForm({
              ...emptyAsset,
              id: row.upstreamAssetId,
              name: row.name || "",
              assetType: editableAssetType(row.assetType),
            })}
          >
            编辑
          </Button>
          <Button
            size="compact"
            variant="danger"
            icon={<Trash2 size={15} />}
            disabled={actionPending}
            onClick={() => setDeleteTarget({
              kind: "asset",
              id: row.upstreamAssetId,
              label: row.name || row.upstreamAssetId,
            })}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  const metrics = snapshot.metrics;
  const workspaceSelected = Boolean(workspaceId.trim());
  const canCreateAsset = workspaceSelected && snapshot.groups.length > 0;
  const tableError = error
    ? `${error}。请核对工作区 ID、火山视频通道及服务端人像凭据后重试。`
    : undefined;

  return (
    <ConsolePage
      title="人像资产中转"
      description="按工作区实时调用火山方舟资产组、资产和真人认证接口。0.1.5 不建立本地素材镜像或归属副本，AK/SK 仅在服务端签名。"
      primaryAction={(
        <Button
          icon={<Plus size={17} />}
          disabled={actionPending || !workspaceSelected || (tab === "assets" && !canCreateAsset)}
          title={tab === "assets" && !canCreateAsset ? "请先创建或读取一个资产组" : undefined}
          onClick={() => tab === "groups"
            ? openGroupForm({ ...emptyGroup })
            : openAssetForm({ ...emptyAsset, groupId: snapshot.groups[0]?.upstreamGroupId || "" })}
        >
          {tab === "groups" ? "新建资产组" : "添加资产"}
        </Button>
      )}
      layoutWidth="dashboard"
    >
      <MetricStrip metrics={[
        {
          id: "groups",
          label: "上游资产组",
          value: loading ? "加载中" : metrics.groupCount,
          hint: snapshot.refreshedAt ? `刷新于 ${formatTime(snapshot.refreshedAt)}` : "等待工作区查询",
        },
        { id: "assets", label: "上游资产", value: loading ? "-" : metrics.assetCount, hint: "当前工作区实时结果" },
        {
          id: "active",
          label: "可用资产",
          value: loading ? "-" : metrics.activeAssetCount,
          hint: `上游 Active；处理中 ${metrics.processingAssetCount}`,
          tone: "positive",
        },
        {
          id: "failed",
          label: "失败资产",
          value: loading ? "-" : metrics.failedAssetCount,
          hint: metrics.failedAssetCount ? "查看上游错误说明" : "当前未返回失败项",
          tone: metrics.failedAssetCount ? "danger" : "neutral",
        },
      ]} />

      <section className="portraitRelayWorkbench" aria-label="人像资产中转工作台">
        <FilterBar actions={(
          <>
            <Button disabled={actionPending || !draftWorkspaceId.trim()} onClick={applyWorkspaceFilter}>查询</Button>
            <Button variant="secondary" icon={<Fingerprint size={16} />} disabled={actionPending || !workspaceSelected} onClick={() => setLivenessOpen(true)}>真人认证</Button>
            <Button variant="ghost" icon={<RefreshCcw size={16} />} disabled={actionPending || !workspaceSelected} loading={loading} onClick={() => void reload()}>刷新</Button>
          </>
        )}>
          <FormField
            className="portraitRelayWorkspaceField"
            label="工作区 ID"
            required
            optionalLabel={null}
            help="必填；服务端据此选择该工作区绑定的火山通道，不支持跨工作区聚合。"
          >
            <Input
              value={draftWorkspaceId}
              disabled={actionPending}
              onChange={(event) => setDraftWorkspaceId(event.target.value)}
              placeholder="输入工作区 ID"
              onKeyDown={(event) => {
                if (event.key === "Enter") applyWorkspaceFilter();
              }}
            />
          </FormField>
        </FilterBar>

        {!workspaceSelected ? (
          <Alert tone="info" title="先选择工作区">
            人像资产中转必须绑定到一个工作区，页面不会读取或合并其他工作区的数据。
          </Alert>
        ) : null}

        <Tabs
          ariaLabel="人像资产中转视图"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: "groups", label: `资产组 ${snapshot.groups.length}` },
            { value: "assets", label: `资产 ${snapshot.assets.length}` },
          ]}
        />
        {tab === "groups" ? (
          <DataTable
            columns={groupColumns}
            rows={snapshot.groups}
            getRowId={(row) => row.id}
            caption="火山方舟人像资产组实时列表"
            loading={loading}
            error={tableError}
            onRetry={workspaceSelected ? () => void reload() : undefined}
            emptyState={workspaceSelected ? "当前工作区未返回人像资产组" : "请输入工作区 ID 后查询"}
            defaultPageSize={20}
          />
        ) : (
          <DataTable
            columns={assetColumns}
            rows={snapshot.assets}
            getRowId={(row) => row.id}
            caption="火山方舟人像资产实时列表"
            loading={loading}
            error={tableError}
            onRetry={workspaceSelected ? () => void reload() : undefined}
            emptyState={workspaceSelected ? "当前工作区未返回人像资产" : "请输入工作区 ID 后查询"}
            defaultPageSize={20}
          />
        )}
      </section>

      <Drawer
        open={Boolean(groupForm)}
        title={groupForm?.id ? "编辑火山资产组" : "新建火山资产组"}
        description="变更会直接提交到当前工作区绑定的火山项目；繁境 0.1.5 不保存资产组镜像。"
        size="min(620px, 100vw)"
        loading={groupSavePending}
        dirty={groupDirty}
        onOpenChange={(open) => {
          if (!open && !groupSavePending) closeGroupForm();
        }}
        footer={<Button loading={groupSavePending} disabled={actionPending || !groupForm?.name.trim()} onClick={() => void saveGroup()}>保存资产组</Button>}
      >
        {groupForm ? (
          <fieldset className="portraitRelayFormLock" disabled={groupSavePending}>
            <legend className="cuiVisuallyHidden">火山资产组配置</legend>
            <FormGrid columns={1}>
              <FormField label="名称" required optionalLabel={null}>
                <Input autoFocus value={groupForm.name} maxLength={64} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} />
              </FormField>
              <FormField label="描述">
                <Input value={groupForm.description} maxLength={300} onChange={(event) => setGroupForm({ ...groupForm, description: event.target.value })} />
              </FormField>
              <FormField label="资产组类型" required optionalLabel={null} help="公开创建固定为 AIGC；LivenessFace 资产组由真人认证结果生成。">
                <Select disabled value={groupForm.groupType}>
                  <option value="AIGC">AIGC（虚拟人像）</option>
                  <option value="LivenessFace">LivenessFace（真人人像）</option>
                </Select>
              </FormField>
            </FormGrid>
          </fieldset>
        ) : null}
      </Drawer>

      <Drawer
        open={Boolean(assetForm)}
        title={assetForm?.id ? "编辑火山资产" : "添加火山资产"}
        description={assetForm?.id
          ? "仅更新上游资产名称，繁境不保存本地资产副本。"
          : "HTTPS 地址会作为请求参数直接提交给火山处理；繁境 0.1.5 不下载、镜像或持久化素材文件。"}
        size="min(640px, 100vw)"
        loading={assetSavePending}
        dirty={assetDirty}
        onOpenChange={(open) => {
          if (!open && !assetSavePending) closeAssetForm();
        }}
        footer={(
          <Button
            icon={<Upload size={16} />}
            loading={assetSavePending}
            disabled={actionPending || !assetForm?.name.trim() || (
              !assetForm.id
              && (!assetForm.groupId || !isHttpsUrl(assetForm.url.trim()) || !assetForm.consent)
            )}
            onClick={() => void saveAsset()}
          >
            {assetForm?.id ? "保存名称" : "确认并提交"}
          </Button>
        )}
      >
        {assetForm ? (
          <fieldset className="portraitRelayFormLock" disabled={assetSavePending}>
            <legend className="cuiVisuallyHidden">火山资产配置</legend>
            <FormGrid columns={1}>
              <FormField label="名称" required optionalLabel={null}>
                <Input autoFocus value={assetForm.name} maxLength={64} onChange={(event) => setAssetForm({ ...assetForm, name: event.target.value })} />
              </FormField>
              {!assetForm.id ? (
                <>
                <FormField label="所属资产组" required optionalLabel={null}>
                  <Select value={assetForm.groupId} onChange={(event) => setAssetForm({ ...assetForm, groupId: event.target.value })}>
                    <option value="">请选择资产组</option>
                    {snapshot.groups.map((group) => (
                      <option key={group.id} value={group.upstreamGroupId}>{group.name || group.upstreamGroupId}</option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="媒体类型" required optionalLabel={null}>
                  <Select
                    value={assetForm.assetType}
                    onChange={(event) => setAssetForm({ ...assetForm, assetType: event.target.value as AssetForm["assetType"] })}
                  >
                    <option value="Image">图片</option>
                    <option value="Video">视频</option>
                    <option value="Audio">音频</option>
                  </Select>
                </FormField>
                <FormField
                  label="HTTPS 素材地址"
                  required
                  optionalLabel={null}
                  help="请使用你方可控、在火山异步处理期间持续有效的 HTTPS 地址。"
                  error={assetForm.url && !isHttpsUrl(assetForm.url.trim()) ? "必须填写有效的 HTTPS 地址" : undefined}
                >
                  <Input type="url" value={assetForm.url} placeholder="https://..." onChange={(event) => setAssetForm({ ...assetForm, url: event.target.value })} />
                </FormField>
                <Switch
                  checked={assetForm.consent}
                  onCheckedChange={(consent) => setAssetForm({ ...assetForm, consent })}
                  label="我确认已取得合法肖像、声音和素材授权"
                  description="该确认随本次受审计的管理操作提交；素材文件不会被繁境本地复制。"
                />
                </>
              ) : null}
            </FormGrid>
          </fieldset>
        ) : null}
      </Drawer>

      <Drawer
        open={livenessOpen}
        title="火山真人认证会话"
        description="创建火山 H5 真人认证会话，并使用 BytedToken 查询上游认证结果。"
        size="min(680px, 100vw)"
        loading={livenessPending}
        onOpenChange={(open) => {
          if (!open && !livenessPending) {
            writeKeyState.current = null;
            setLivenessOpen(false);
            setBytedToken("");
            setH5Link("");
            setLivenessResult(null);
          }
        }}
        footer={(
          <div className="portraitRelayDrawerActions">
            <Button variant="secondary" icon={<ShieldCheck size={16} />} disabled={actionPending || !isHttpsUrl(callbackUrl.trim())} loading={pendingAction === "liveness:create"} onClick={() => void createLiveness()}>创建会话</Button>
            <Button icon={<BadgeCheck size={16} />} disabled={actionPending || !bytedToken.trim()} loading={pendingAction === "liveness:result"} onClick={() => void getLivenessResult()}>查询结果</Button>
          </div>
        )}
      >
        <fieldset className="portraitRelayFormLock" disabled={livenessPending}>
          <legend className="cuiVisuallyHidden">火山真人认证配置</legend>
          <FormGrid columns={1}>
          <FormField
            label="回调 HTTPS 地址"
            required
            optionalLabel={null}
            help="上游会向该地址回调认证结果，请使用业务方控制且能够接收回调的 HTTPS 地址。"
            error={callbackUrl && !isHttpsUrl(callbackUrl.trim()) ? "必须填写有效的 HTTPS 地址" : undefined}
          >
            <Input type="url" value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="https://example.com/portrait-callback" />
          </FormField>
          <FormField
            label="BytedToken"
            required
            optionalLabel={null}
            help="创建会话后会自动填入，也可粘贴已有令牌；页面不在本地持久化该值。"
          >
            <Input type="password" autoComplete="off" value={bytedToken} onChange={(event) => setBytedToken(event.target.value)} />
          </FormField>
          </FormGrid>
        </fieldset>
        {h5Link ? (
          <Alert tone="warning" title="认证链接已生成">
            <a className="portraitRelayExternalLink" href={h5Link} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
              打开火山真人认证页面
              <ExternalLink aria-hidden="true" size={15} />
            </a>
            <span>链接可能包含短期凭据，请勿转发或记录到工单。</span>
          </Alert>
        ) : null}
        {livenessResult ? (
          <Alert tone="info" title="上游响应（敏感字段已隐藏）">
            <pre className="portraitRelayResponse">{safeResponseJson(livenessResult)}</pre>
          </Alert>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`删除火山${deleteTarget?.kind === "group" ? "资产组" : "资产"}？`}
        description={deleteTarget
          ? `将直接向火山方舟提交删除「${deleteTarget.label}」。繁境 0.1.5 不保留本地镜像或恢复副本，请先确认没有业务仍在使用该资源。`
          : undefined}
        confirmLabel="确认删除"
        tone="danger"
        loading={Boolean(deleteTarget && pendingAction === `${deleteTarget.kind}:delete:${deleteTarget.id}`)}
        onCancel={() => {
          if (!actionPending) {
            writeKeyState.current = null;
            setDeleteTarget(null);
          }
        }}
        onConfirm={deleteResource}
      />
    </ConsolePage>
  );
}
