import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Clapperboard, Eye, Pencil, Plus, RefreshCcw, Search, ShieldAlert, Trash2, XCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useAuthStore } from "../../../stores/authStore";
import { isPlatformAdmin } from "../../../utils/permissions";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  Drawer,
  FilterBar,
  FormField,
  Input,
  MetricStrip,
  Select,
  useToast,
  type DataTableColumn,
} from "../../../ui/console";
import { createModelRoute, deleteModelRoute, disableModelRoute, preflightModelRoute, updateModelRoute } from "./api";
import { useModelRoutes } from "./hooks";
import { ModelRouteFormDrawer } from "./ModelRouteFormDrawer";
import { ModelRouteReadinessBadge, ModelRouteReadinessPanel } from "./ModelRouteReadiness";
import type { ModelRouteFilters, ModelRouteForm, ModelRouteReadiness, ModelRouteRow } from "./types";
import {
  emptyModelRouteFilters,
  emptyModelRouteForm,
  endpointLabel,
  filterModelRouteRows,
  modelRouteFormFromRoute,
  modelRoutePayloadFromForm,
  normalizeModelRoute,
  safeJson,
} from "./utils";
import "./styles.css";

function readFilters(params: URLSearchParams): ModelRouteFilters {
  return {
    keyword: params.get("q") || "",
    endpointType: params.get("capability") || "",
    provider: params.get("provider") || "",
    status: params.get("status") || "",
  };
}

function RouteStatus({ status }: { status: ModelRouteRow["status"] }) {
  return status === "enabled"
    ? <Badge tone="success" icon={<CheckCircle2 size={14} />}>启用</Badge>
    : <Badge tone="neutral" icon={<XCircle size={14} />}>停用</Badge>;
}

function RouteDetail({ row }: { row: ModelRouteRow }) {
  return (
    <div className="adminModelsDetail">
      <section aria-labelledby="model-route-overview-heading">
        <h3 id="model-route-overview-heading">路由关系</h3>
        <dl>
          <div><dt>路由 ID</dt><dd><code>{row.id}</code></dd></div>
          <div><dt>名称 / 模型</dt><dd>{row.name} / <code>{row.model}</code></dd></div>
          <div><dt>显示名</dt><dd>{row.displayName || <span className="adminModelsMuted">未设置，前台显示原名</span>}{row.enhanceDisplayName ? ` · 超分：${row.enhanceDisplayName}` : ""}</dd></div>
          <div><dt>能力</dt><dd>{endpointLabel(row.endpointType)} <span className="adminModelsMuted">{row.endpointType}</span></dd></div>
          <div><dt>供应商 / 通道</dt><dd>{row.provider} / <code>{row.channelId}</code></dd></div>
          <div><dt>范围</dt><dd>{row.scope}</dd></div>
          <div><dt>优先级 / 回退顺序</dt><dd>{row.priority} / {row.fallbackOrder}</dd></div>
          <div><dt>状态</dt><dd><RouteStatus status={row.status} /></dd></div>
        </dl>
      </section>
      <section aria-labelledby="model-route-readiness-heading">
        <h3 id="model-route-readiness-heading">生产就绪与用户目录</h3>
        {row.readiness
          ? <ModelRouteReadinessPanel readiness={row.readiness} />
          : <p className="adminModelsMuted">尚未完成只读生产预检，请刷新后重试。</p>}
      </section>
      <section aria-labelledby="model-route-capability-heading">
        <h3 id="model-route-capability-heading">能力配置</h3>
        <dl>
          <div><dt>支持分辨率</dt><dd>{row.resolutions.length ? row.resolutions.join(" / ") : "-"}</dd></div>
          <div><dt>默认分辨率</dt><dd>{row.defaultResolution || "-"}</dd></div>
        </dl>
        <Accordion className="adminModelsAdvanced">
          <AccordionItem value="model-route-config">
            <AccordionTrigger>完整路由配置</AccordionTrigger>
            <AccordionContent><pre className="adminModelsCode">{safeJson(row.source.routeConfig)}</pre></AccordionContent>
          </AccordionItem>
        </Accordion>
      </section>
    </div>
  );
}

type AdminModelRoutesPageProps = {
  title?: string;
  description?: string;
  sectionNavigation?: ReactNode;
  onConfigureVideoRecipes?: (row: ModelRouteRow) => void;
};

export default function AdminModelRoutesPage({
  title = "模型路由",
  description = "扫描模型、能力、供应商和优先级关系，并集中维护路由拓扑与能力配置。",
  sectionNavigation,
  onConfigureVideoRecipes,
}: AdminModelRoutesPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramsKey = searchParams.toString();
  const activeFilters = useMemo(() => readFilters(searchParams), [paramsKey]);
  const [draft, setDraft] = useState(activeFilters);
  const user = useAuthStore((store) => store.user);
  const workspace = useAuthStore((store) => store.currentWorkspace);
  const state = useModelRoutes(workspace?.id ? String(workspace.id) : null);
  const allRows = useMemo(() => state.data.map(normalizeModelRoute), [state.data]);
  const rows = useMemo(() => filterModelRouteRows(allRows, activeFilters), [activeFilters, allRows]);
  const providers = useMemo(() => Array.from(new Set(allRows.map((row) => row.provider).filter((value) => value !== "-"))).sort(), [allRows]);
  const endpointTypes = useMemo(() => Array.from(new Set(allRows.map((row) => row.endpointType).filter((value) => value !== "-"))).sort(), [allRows]);
  const enabled = allRows.filter((row) => row.status === "enabled").length;
  const productionReady = allRows.filter((row) => row.readiness?.productionReady).length;
  const catalogSubmittable = allRows.filter((row) => row.readiness?.canSubmit).length;
  const [detailRow, setDetailRow] = useState<ModelRouteRow | null>(null);
  const [disableRow, setDisableRow] = useState<ModelRouteRow | null>(null);
  const [deleteRow, setDeleteRow] = useState<ModelRouteRow | null>(null);
  const [form, setForm] = useState<ModelRouteForm | null>(null);
  const [initialForm, setInitialForm] = useState<ModelRouteForm | null>(null);
  const [formError, setFormError] = useState("");
  const [preflight, setPreflight] = useState<ModelRouteReadiness | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState("");
  const { toast } = useToast();
  const canMutate = isPlatformAdmin({ user, workspace });

  useEffect(() => setDraft(activeFilters), [paramsKey]);

  function writeFilters(filters: ModelRouteFilters) {
    const next = new URLSearchParams();
    if (filters.keyword.trim()) next.set("q", filters.keyword.trim());
    if (filters.endpointType) next.set("capability", filters.endpointType);
    if (filters.provider) next.set("provider", filters.provider);
    if (filters.status) next.set("status", filters.status);
    setSearchParams(next);
  }

  function openCreateRoute() {
    const next = emptyModelRouteForm();
    setForm(next);
    setInitialForm(next);
    setFormError("");
    setPreflight(null);
  }

  function openEditRoute(row: ModelRouteRow) {
    const next = modelRouteFormFromRoute(row);
    setForm(next);
    setInitialForm(next);
    setFormError("");
    setPreflight(row.readiness);
  }

  function closeRouteForm() {
    setForm(null);
    setInitialForm(null);
    setFormError("");
    setPreflight(null);
  }

  async function runRoutePreflight(target: ModelRouteForm): Promise<ModelRouteReadiness | null> {
    let payload: Record<string, unknown>;
    try {
      payload = modelRoutePayloadFromForm(target);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "模型路由表单无效。");
      return null;
    }
    setPreflighting(true);
    setFormError("");
    try {
      const result = await preflightModelRoute(
        { ...(target.id ? { id: target.id } : {}), ...payload },
        workspace?.id ? String(workspace.id) : null,
      );
      setPreflight(result);
      return result;
    } catch (error) {
      setPreflight(null);
      setFormError(error instanceof Error ? error.message : "模型路由只读预检失败。");
      return null;
    } finally {
      setPreflighting(false);
    }
  }

  async function saveRoute() {
    if (!form) return;
    let payload: Record<string, unknown>;
    try {
      payload = modelRoutePayloadFromForm(form);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "模型路由表单无效。");
      return;
    }
    const readiness = await runRoutePreflight(form);
    if (!readiness) return;
    if (!form.disabled && !readiness.productionReady) {
      setFormError("生产预检未通过。请修复失败项，或先将路由保存为停用状态。");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      if (form.id) await updateModelRoute(form.id, payload);
      else await createModelRoute(payload);
      toast({
        title: form.id ? "模型路由已保存" : "模型路由已创建",
        message: `${form.name} 的拓扑配置已写入。`,
        tone: "success",
      });
      closeRouteForm();
      setDetailRow(null);
      state.reload();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : form.id ? "模型路由保存失败。" : "模型路由创建失败。");
    } finally { setSaving(false); }
  }

  async function enableRoute(row: ModelRouteRow) {
    setActionId(row.id);
    try {
      const enabledForm = { ...modelRouteFormFromRoute(row), disabled: false };
      const payload = modelRoutePayloadFromForm(enabledForm);
      const readiness = await preflightModelRoute(
        { id: row.id, ...payload },
        workspace?.id ? String(workspace.id) : null,
      );
      if (!readiness.productionReady) {
        toast({
          title: "路由尚未达到生产就绪",
          message: readiness.reasons[0] || "请先修复预检失败项，再启用路由。",
          tone: "danger",
        });
        return;
      }
      await updateModelRoute(row.id, { disabled: 0 });
      toast({ title: "模型路由已启用", message: `${row.model} 将重新参与匹配。`, tone: "success" });
      setDetailRow(null);
      state.reload();
    } catch (error) {
      toast({ title: "启用失败", message: error instanceof Error ? error.message : "请稍后重试。", tone: "danger" });
    } finally { setActionId(""); }
  }

  async function confirmDisable() {
    if (!disableRow) return false;
    setActionId(disableRow.id);
    try {
      await disableModelRoute(disableRow.id);
      toast({ title: "模型路由已停用", message: `${disableRow.model} 不再参与新的路由匹配。`, tone: "success" });
      setDetailRow(null);
      state.reload();
      return true;
    } catch (error) {
      toast({ title: "停用失败", message: error instanceof Error ? error.message : "请稍后重试。", tone: "danger" });
      return false;
    } finally { setActionId(""); }
  }

  async function confirmDelete() {
    if (!deleteRow) return false;
    setActionId(deleteRow.id);
    try {
      await deleteModelRoute(deleteRow.id);
      toast({
        title: "模型路由已永久删除",
        message: `${deleteRow.model} 的老旧路由配置已移除。`,
        tone: "success",
      });
      setDetailRow(null);
      state.reload();
      return true;
    } catch (error) {
      toast({
        title: "删除失败",
        message: error instanceof Error ? error.message : "请检查路由是否已停用且没有生产认证记录。",
        tone: "danger",
      });
      return false;
    } finally { setActionId(""); }
  }

  const columns = useMemo<DataTableColumn<ModelRouteRow>[]>(() => [
    { id: "model", header: "模型", priority: "primary", minWidth: "220px", sortable: true, sortValue: (row) => row.model, cell: (row) => <div className="adminModelsIdentity"><strong>{row.name}</strong><code>{row.model}</code></div> },
    { id: "displayName", header: "显示名", priority: "secondary", sortable: true, sortValue: (row) => row.displayName || row.name, cell: (row) => <div className="adminModelsIdentity"><strong>{row.displayName || <span className="adminModelsMuted">原名</span>}</strong>{row.enhanceDisplayName ? <span className="adminModelsMuted">超分 · {row.enhanceDisplayName}</span> : null}</div> },
    { id: "capability", header: "能力", priority: "primary", sortable: true, sortValue: (row) => row.endpointType, cell: (row) => <div className="adminModelsIdentity"><strong>{endpointLabel(row.endpointType)}</strong><span className="adminModelsMuted">{row.endpointType}</span></div> },
    { id: "provider", header: "供应商", priority: "secondary", sortable: true, accessor: "provider" },
    { id: "priority", header: "优先级", priority: "primary", align: "end", sortable: true, sortValue: (row) => row.priority, cell: (row) => <span className="adminModelsPriority"><strong>{row.priority}</strong><span className="adminModelsMuted">回退 {row.fallbackOrder}</span></span> },
    { id: "scope", header: "范围", priority: "secondary", accessor: "scope" },
    { id: "resolutions", header: "分辨率", priority: "detail", cell: (row) => row.resolutions.length ? row.resolutions.join(" / ") : "-" },
    { id: "status", header: "状态", priority: "secondary", cell: (row) => <RouteStatus status={row.status} /> },
    { id: "readiness", header: "生产就绪", priority: "primary", sortable: true, sortValue: (row) => row.readiness?.canSubmit ? 2 : row.readiness?.productionReady ? 1 : 0, cell: (row) => <ModelRouteReadinessBadge readiness={row.readiness} /> },
    {
      id: "actions",
      header: "操作",
      headerLabel: "行操作",
      priority: "primary",
      hideable: false,
      minWidth: "172px",
      cell: (row) => (
        <div className="adminModelsRowActions">
          <Button size="compact" variant="secondary" icon={<Eye size={16} />} onClick={() => setDetailRow(row)}>查看</Button>
          {canMutate ? (
            <Button
              size="compact"
              variant="danger"
              icon={<Trash2 size={15} />}
              loading={actionId === row.id}
              disabled={row.status === "enabled" || Boolean(actionId)}
              title={row.status === "enabled" ? "请先停用该模型路由，再执行永久删除" : "永久删除该老旧模型路由"}
              aria-label={row.status === "enabled" ? `删除 ${row.name}（请先停用）` : `永久删除模型路由 ${row.name}`}
              onClick={(event) => { event.stopPropagation(); setDeleteRow(row); }}
            >删除</Button>
          ) : null}
        </div>
      ),
    },
  ], [actionId, canMutate]);

  return (
    <ConsolePage
      title={title}
      description={description}
      primaryAction={(
        <div className="adminModelsActions">
          <Button variant="secondary" icon={<RefreshCcw size={17} />} loading={state.loading} onClick={state.reload}>刷新</Button>
          {canMutate ? <Button icon={<Plus size={17} />} onClick={openCreateRoute}>新增模型路由</Button> : null}
        </div>
      )}
      layoutWidth="dashboard"
    >
      {sectionNavigation}
      <MetricStrip metrics={[
        { id: "total", label: "路由总数", value: state.loading ? "加载中" : allRows.length.toLocaleString(), hint: "含停用路由" },
        { id: "enabled", label: "启用路由", value: state.loading ? "-" : enabled.toLocaleString(), hint: "参与当前匹配", tone: "positive" },
        { id: "ready", label: "生产就绪", value: state.loading ? "-" : productionReady.toLocaleString(), hint: "依赖检查全部通过", tone: "positive" },
        { id: "submittable", label: "目录可提交", value: state.loading ? "-" : catalogSubmittable.toLocaleString(), hint: "评估工作区真实生效" },
      ]} />
      <FilterBar actions={<div className="adminModelsActions"><Button icon={<Search size={16} />} onClick={() => writeFilters(draft)}>查询</Button><Button variant="ghost" onClick={() => { setDraft(emptyModelRouteFilters); writeFilters(emptyModelRouteFilters); }}>清除</Button></div>}>
        <FormField className="adminModelsField adminModelsField--keyword" label="模型或路由" optionalLabel={null}><Input value={draft.keyword} onChange={(event) => setDraft((current) => ({ ...current, keyword: event.target.value }))} placeholder="名称、模型、通道或范围" onKeyDown={(event) => { if (event.key === "Enter") writeFilters(draft); }} /></FormField>
        <FormField className="adminModelsField" label="能力" optionalLabel={null}><Select value={draft.endpointType} onChange={(event) => setDraft((current) => ({ ...current, endpointType: event.target.value }))}><option value="">全部能力</option>{endpointTypes.map((value) => <option key={value} value={value}>{endpointLabel(value)}</option>)}</Select></FormField>
        <FormField className="adminModelsField" label="供应商" optionalLabel={null}><Select value={draft.provider} onChange={(event) => setDraft((current) => ({ ...current, provider: event.target.value }))}><option value="">全部供应商</option>{providers.map((value) => <option key={value} value={value}>{value}</option>)}</Select></FormField>
        <FormField className="adminModelsField" label="状态" optionalLabel={null}><Select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}><option value="">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option></Select></FormField>
      </FilterBar>
      <DataTable columns={columns} rows={rows} getRowId={(row) => row.id} caption="模型路由列表" loading={state.loading} error={state.error || undefined} onRetry={state.reload} emptyState="当前条件下暂无模型路由" onRowClick={setDetailRow} getRowAriaLabel={(row) => `查看模型路由 ${row.name} 详情`} defaultSort={{ columnId: "priority", direction: "ascending" }} />
      <Drawer open={Boolean(detailRow)} title={detailRow ? `路由详情 · ${detailRow.name}` : "路由详情"} description="查看模型、能力、供应商、优先级和完整路由配置。" size="min(640px, 100vw)" loading={Boolean(actionId)} onOpenChange={(open) => { if (!open && !actionId) setDetailRow(null); }} footer={detailRow && canMutate ? <div className="adminModelsDrawerActions">{detailRow.endpointType === "video_generation" && onConfigureVideoRecipes ? <Button icon={<Clapperboard size={16} />} disabled={Boolean(actionId)} onClick={() => onConfigureVideoRecipes(detailRow)}>配置视频配方</Button> : null}<Button variant="secondary" icon={<Pencil size={16} />} disabled={Boolean(actionId)} onClick={() => openEditRoute(detailRow)}>编辑路由</Button>{detailRow.status === "enabled" ? <Button variant="danger" icon={<ShieldAlert size={16} />} disabled={Boolean(actionId)} onClick={() => setDisableRow(detailRow)}>停用路由</Button> : <><Button icon={<CheckCircle2 size={16} />} loading={actionId === detailRow.id} onClick={() => void enableRoute(detailRow)}>启用路由</Button><Button variant="danger" icon={<Trash2 size={16} />} disabled={Boolean(actionId)} onClick={() => setDeleteRow(detailRow)}>永久删除</Button></>}</div> : undefined}>
        {detailRow ? <RouteDetail row={detailRow} /> : null}
      </Drawer>
      {form && initialForm ? (
        <ModelRouteFormDrawer
          open
          form={form}
          initialForm={initialForm}
          saving={saving}
          preflighting={preflighting}
          preflight={preflight}
          error={formError}
          onChange={(next) => { setForm(next); setFormError(""); setPreflight(null); }}
          onPreflight={() => { if (form) void runRoutePreflight(form); }}
          onSave={() => void saveRoute()}
          onOpenChange={(open) => { if (!open && !saving && !preflighting) closeRouteForm(); }}
        />
      ) : null}
      <ConfirmDialog open={Boolean(disableRow)} title="停用模型路由？" description={disableRow ? `停用后，模型 ${disableRow.model} 将不再通过此路由处理新的请求；已有任务不受影响。` : undefined} confirmLabel="确认停用" tone="danger" loading={Boolean(actionId)} onCancel={() => { if (!actionId) setDisableRow(null); }} onConfirm={confirmDisable} />
      <ConfirmDialog
        open={Boolean(deleteRow)}
        title="永久删除模型路由？"
        description={deleteRow ? `将永久删除 ${deleteRow.name}（${deleteRow.model}）的路由配置，且无法恢复。历史任务和计费记录不会被删除；包含生产认证证据的路由会被系统阻止删除。` : undefined}
        confirmLabel="确认永久删除"
        tone="danger"
        loading={Boolean(actionId)}
        onCancel={() => { if (!actionId) setDeleteRow(null); }}
        onConfirm={confirmDelete}
      />
    </ConsolePage>
  );
}
