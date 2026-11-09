import { CommunityUpdateEntry } from "./CommunityUpdateEntry";
import { apiGet } from "../../../api/http";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ChevronDown,
  ChevronUp,
  PackageOpen,
  Plus,
  RefreshCcw,
  Search,
  ServerCog,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  DescriptionList,
  Dialog,
  Drawer,
  EmptyState,
  FilterBar,
  FormField,
  FormGrid,
  Input,
  MetricStrip,
  Select,
  Skeleton,
  useToast,
} from "../../../ui/console";
import { useFinanceQuery } from "../finance/hooks";
import { useV4Theme } from "../../../ui/useV4Theme";
import {
  archivePlatformRelease,
  listPlatformReleases,
  listReleaseDeployments,
  savePlatformRelease,
} from "./api";
import { DeploymentDrawer } from "./DeploymentDrawer";
import {
  DEPLOYMENT_POLL_INTERVAL_MS,
  deploymentProgress,
  deploymentStatusLabels,
  deploymentStatusTone,
  isDeploymentActive,
  phaseLabel,
  shouldPollDeployment,
} from "./deploymentState";
import { releaseDraftChanged, releaseDraftFromRecord } from "./formState";
import type {
  PlatformReleaseChannel,
  PlatformReleaseDraft,
  PlatformReleasePage,
  PlatformReleaseRecord,
  PlatformReleaseStatus,
  ReleaseDeploymentDetail,
  ReleaseDeploymentPage,
  ReleaseDeploymentRecord,
} from "./types";
import "./styles.css";

const RELEASE_CONTROL_THEME_MESSAGE = "fanjin.release-control.theme/v1";

const channelLabels: Record<PlatformReleaseChannel, string> = {
  stable: "稳定版",
  beta: "Beta",
  internal: "内部版",
};

const statusLabels: Record<PlatformReleaseStatus, string> = {
  draft: "草稿",
  deploying: "发布中",
  published: "已发布",
  archived: "已归档",
};

const emptyDraft: PlatformReleaseDraft = {
  version: "",
  title: "",
  channel: "stable",
  summary: "",
  releaseNotes: "",
};

const emptyPage: PlatformReleasePage = {
  items: [],
  total: 0,
  pageNum: 1,
  pageSize: 20,
  summary: { currentStable: null, draftCount: 0, betaCount: 0, latestPublishedAt: null },
};

const emptyDeploymentPage: ReleaseDeploymentPage = {
  items: [],
  total: 0,
  pageNum: 1,
  pageSize: 20,
};

function statusTone(status: PlatformReleaseStatus) {
  if (status === "published") return "success" as const;
  if (status === "deploying") return "info" as const;
  if (status === "draft") return "warning" as const;
  return "neutral" as const;
}

function channelTone(channel: PlatformReleaseChannel) {
  if (channel === "stable") return "info" as const;
  if (channel === "beta") return "warning" as const;
  return "neutral" as const;
}

function formatDate(value: number | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function metricValue(loading: boolean, value: string) {
  return loading ? <Skeleton width="5rem" height="1.5rem" /> : value;
}

type FormErrors = Partial<Record<keyof PlatformReleaseDraft, string>>;
type SelectedDeployment = {
  id: string;
  releaseId: string;
  initial?: ReleaseDeploymentDetail | null;
} | null;

export default function ReleasesPage(props: { initialReleaseControlOpen?: boolean } = {}) {
  const [managed, setManaged] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void apiGet<{ managed: boolean }>("/admin/releases/community-update")
      .then(value => { if (active) setManaged(value.managed); })
      .catch(() => { if (active) setManaged(false); });
    return () => { active = false; };
  }, []);
  if (managed === null) return <ConsolePage title="版本与更新"><Skeleton width="100%" height="8rem" /></ConsolePage>;
  if (managed) return <ConsolePage title="版本与更新"><CommunityUpdateEntry /></ConsolePage>;
  return <PlatformReleasesPage {...props} />;
}

function PlatformReleasesPage({ initialReleaseControlOpen = true }: { initialReleaseControlOpen?: boolean } = {}) {
  const { toast } = useToast();
  const theme = useV4Theme();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [queryDraft, setQueryDraft] = useState("");
  const [filters, setFilters] = useState<{
    query: string;
    channel: "all" | PlatformReleaseChannel;
    status: "all" | PlatformReleaseStatus;
  }>({ query: "", channel: "all", status: "all" });
  const [detail, setDetail] = useState<PlatformReleaseRecord | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PlatformReleaseRecord | null>(null);
  const [draft, setDraft] = useState<PlatformReleaseDraft>(emptyDraft);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<PlatformReleaseRecord | null>(null);
  const [selectedDeployment, setSelectedDeployment] = useState<SelectedDeployment>(null);
  const [releaseControlOpen, setReleaseControlOpen] = useState(initialReleaseControlOpen);
  const releaseControlFrameRef = useRef<HTMLIFrameElement>(null);
  const releaseControlTheme = theme.mode === "dark" ? "dark" : "light";
  const releaseControlInitialSrcRef = useRef(
    `/release-control/index.html?theme=${releaseControlTheme}`,
  );
  const versionRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const initialDraftRef = useRef<PlatformReleaseDraft>(emptyDraft);

  const payload = useMemo(() => ({
    pageNum: page,
    pageSize,
    query: filters.query || null,
    channel: filters.channel === "all" ? null : filters.channel,
    status: filters.status === "all" ? null : filters.status,
  }), [filters, page, pageSize]);
  const releases = useFinanceQuery(
    () => listPlatformReleases(payload),
    JSON.stringify(payload),
    emptyPage,
  );
  const deployments = useFinanceQuery(
    () => listReleaseDeployments({ pageNum: 1, pageSize: 20 }),
    "release-deployments",
    emptyDeploymentPage,
  );
  const draftDirty = useMemo(
    () => editorOpen && releaseDraftChanged(initialDraftRef.current, draft),
    [draft, editorOpen],
  );
  const deploymentItems = deployments.data.items || [];
  const activeDeployment = deploymentItems.find((item) => shouldPollDeployment(item.status, item.phase)) || null;
  const highlightedDeployment = activeDeployment || deploymentItems[0] || null;

  useEffect(() => {
    if (!activeDeployment || deployments.loading) return;
    const timer = window.setTimeout(() => void deployments.reload(), DEPLOYMENT_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [activeDeployment?.id, activeDeployment?.phase, activeDeployment?.status, activeDeployment?.updatedAt, deployments.loading, deployments.reload]);

  const syncReleaseControlTheme = useCallback(() => {
    releaseControlFrameRef.current?.contentWindow?.postMessage({
      type: RELEASE_CONTROL_THEME_MESSAGE,
      theme: releaseControlTheme,
    }, window.location.origin);
  }, [releaseControlTheme]);

  useEffect(() => {
    if (releaseControlOpen) syncReleaseControlTheme();
  }, [releaseControlOpen, syncReleaseControlTheme]);

  const reloadReleaseSurfaces = useCallback(() => {
    void Promise.all([releases.reload(), deployments.reload()]);
  }, [deployments.reload, releases.reload]);

  function applySearch() {
    setPage(1);
    setFilters((current) => ({ ...current, query: queryDraft.trim() }));
  }

  function openCreate() {
    const nextDraft = { ...emptyDraft };
    setEditing(null);
    initialDraftRef.current = nextDraft;
    setDraft(nextDraft);
    setFormErrors({});
    setFormError("");
    submittingRef.current = false;
    setEditorOpen(true);
  }

  function openEdit(item: PlatformReleaseRecord) {
    const nextDraft = releaseDraftFromRecord(item);
    setEditing(item);
    initialDraftRef.current = nextDraft;
    setDraft(nextDraft);
    setFormErrors({});
    setFormError("");
    submittingRef.current = false;
    setEditorOpen(true);
  }

  function updateDraft<Key extends keyof PlatformReleaseDraft>(key: Key, value: PlatformReleaseDraft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setFormErrors((current) => ({ ...current, [key]: undefined }));
  }

  function validateDraft() {
    const errors: FormErrors = {};
    const version = draft.version.trim().replace(/^v(?=\d)/i, "");
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
      errors.version = "请输入符合 SemVer 的版本号，例如 1.8.0 或 1.9.0-beta.1。";
    }
    if (draft.title.trim().length < 2) errors.title = "版本标题至少需要 2 个字符。";
    if (draft.summary.trim().length < 4) errors.summary = "版本摘要至少需要 4 个字符。";
    if (draft.releaseNotes.trim().length < 4) errors.releaseNotes = "完整更新说明至少需要 4 个字符。";
    setFormErrors(errors);
    if (Object.keys(errors).length) {
      if (errors.version) versionRef.current?.focus();
      return null;
    }
    return { ...draft, version };
  }

  async function submitDraft() {
    if (submittingRef.current) return;
    const payload = validateDraft();
    if (!payload) return;
    submittingRef.current = true;
    setSaving(true);
    setFormError("");
    try {
      const saved = await savePlatformRelease(payload, editing);
      toast({
        title: editing ? "版本草稿已更新" : "版本草稿已创建",
        message: `${saved.version} 已保存，可在核对后正式发布。`,
        tone: "success",
      });
      setEditorOpen(false);
      setEditing(null);
      await releases.reload();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "版本草稿保存失败");
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  async function confirmArchive() {
    if (!pendingArchive) return false;
    const updated = await archivePlatformRelease(pendingArchive);
    toast({
      title: "版本已归档",
      message: `${updated.version} 已更新为${statusLabels[updated.status]}。`,
      tone: "success",
    });
    if (detail?.id === updated.id) setDetail(updated);
    await releases.reload();
    return true;
  }

  function openDeployment(item: ReleaseDeploymentRecord, initial?: ReleaseDeploymentDetail | null) {
    setDetail(null);
    setSelectedDeployment({ id: item.id, releaseId: item.releaseId, initial });
  }

  const rows = releases.data.items || [];
  const summary = releases.data.summary || emptyPage.summary;
  const highlightedRelease = highlightedDeployment
    ? rows.find((item) => item.id === highlightedDeployment.releaseId)
      || (summary.currentStable?.id === highlightedDeployment.releaseId ? summary.currentStable : null)
    : null;
  const selectedReleaseVersion = selectedDeployment
    ? rows.find((item) => item.id === selectedDeployment.releaseId)?.version
      || (summary.currentStable?.id === selectedDeployment.releaseId ? summary.currentStable.version : undefined)
    : undefined;
  return (
    <ConsolePage
      className="releasePage"
      breadcrumbs={[{ label: "系统治理" }, { label: "版本发布" }]}
      title="版本发布"
      description="统一发布器负责生产变更；下方版本目录只维护更新说明，并保留旧发布任务的只读历史。"
      primaryAction={<Button icon={<Plus size={17} />} onClick={openCreate}>登记版本</Button>}
      layoutWidth="dashboard"
    >
      <section className="releaseControlModule" aria-labelledby="release-control-title">
        <div className="releaseControlModule__heading">
          <div className="releaseControlModule__identity">
            <span className="releaseControlModule__icon" aria-hidden="true"><ServerCog size={18} /></span>
            <div>
              <h2 id="release-control-title">统一发布器</h2>
              <p>在独立发布器中验证候选并执行滚动发布；本页保留版本目录与发布入口。</p>
            </div>
          </div>
          <Button
            icon={releaseControlOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            size="compact"
            variant="secondary"
            aria-expanded={releaseControlOpen}
            aria-controls="release-control-frame"
            onClick={() => setReleaseControlOpen((open) => !open)}
          >
            {releaseControlOpen ? "收起发布器" : "展开发布器"}
          </Button>
        </div>
        {releaseControlOpen ? (
          <div className="releaseControlModule__frame" id="release-control-frame">
            <iframe
              ref={releaseControlFrameRef}
              src={releaseControlInitialSrcRef.current}
              title="Fanjin 模块化发布器"
              loading="eager"
              referrerPolicy="same-origin"
              onLoad={syncReleaseControlTheme}
            />
          </div>
        ) : null}
      </section>
      <MetricStrip metrics={[
        {
          id: "stable",
          label: "当前稳定版",
          value: metricValue(releases.loading, summary.currentStable?.version || "尚未发布"),
          hint: summary.currentStable ? summary.currentStable.title : "暂无稳定版记录",
          tone: summary.currentStable ? "positive" : "neutral",
        },
        {
          id: "drafts",
          label: "待发布草稿",
          value: metricValue(releases.loading, summary.draftCount.toLocaleString()),
          hint: "需要核对后发布",
          tone: summary.draftCount ? "warning" : "neutral",
        },
        {
          id: "beta",
          label: "Beta 版本",
          value: metricValue(releases.loading, summary.betaCount.toLocaleString()),
          hint: "当前已发布 Beta",
          tone: "info",
        },
        {
          id: "recent",
          label: "最近发布时间",
          value: metricValue(releases.loading, formatDate(summary.latestPublishedAt)),
          hint: "以正式发布操作为准",
        },
      ]} />

      <section className="releaseActivity" aria-labelledby="release-activity-title">
        <div className="releaseActivity__heading">
          <div>
            <h2 id="release-activity-title">{activeDeployment ? "旧发布任务仍在执行" : "旧发布器历史"}</h2>
            <p>{activeDeployment ? "仅保留查看、取消和安全收敛能力，不再从此页面创建新任务。" : "这里仅用于查询收敛前的服务器发布记录。"}</p>
          </div>
          {activeDeployment ? <span className="releaseLiveRefresh">活动任务每 2 秒更新</span> : null}
        </div>
        {deployments.loading && !highlightedDeployment ? (
          <div className="releaseActivitySkeleton"><Skeleton height="92px" /></div>
        ) : deployments.error && !highlightedDeployment ? (
          <Alert tone="danger">
            <span>{deployments.error}</span>
            <Button size="compact" variant="secondary" onClick={() => void deployments.reload()}>重新读取</Button>
          </Alert>
        ) : highlightedDeployment ? (
          <article className={`releaseActivityCard ${shouldPollDeployment(highlightedDeployment.status, highlightedDeployment.phase) ? "is-active" : ""}`}>
            <div className="releaseActivityCard__main">
              <span className="releaseActivityCard__icon" aria-hidden="true"><Activity size={19} /></span>
              <div>
                <div className="releaseActivityCard__title">
                  <strong>{highlightedRelease?.version || "版本记录"}</strong>
                  <Badge tone={deploymentStatusTone(highlightedDeployment.status)}>{deploymentStatusLabels[highlightedDeployment.status]}</Badge>
                </div>
                <span>{phaseLabel(highlightedDeployment.phase)}</span>
                <small>任务 {highlightedDeployment.id}</small>
              </div>
            </div>
            <div className="releaseActivityCard__progress">
              <div>
                <span>节点进度</span>
                <strong>{highlightedDeployment.completedTargetCount} / {highlightedDeployment.targetCount}</strong>
              </div>
              <div className="releaseDeploymentProgress" role="progressbar" aria-label="活动发布节点进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={deploymentProgress(highlightedDeployment.completedTargetCount, highlightedDeployment.targetCount)}>
                <span style={{ width: `${deploymentProgress(highlightedDeployment.completedTargetCount, highlightedDeployment.targetCount)}%` }} />
              </div>
            </div>
            <Button variant="secondary" icon={<ServerCog size={16} />} onClick={() => openDeployment(highlightedDeployment)}>
              {shouldPollDeployment(highlightedDeployment.status, highlightedDeployment.phase) ? "查看进度" : "查看记录"}
            </Button>
          </article>
        ) : (
          <div className="releaseActivityEmpty">
            <ServerCog size={19} aria-hidden="true" />
            <div><strong>没有旧发布任务</strong><span>新发布请使用页面顶部的统一发布器。</span></div>
          </div>
        )}
      </section>

      <section className="releaseData" aria-label="版本发布数据">
        <FilterBar
          actions={(
            <div className="releaseFilterActions">
              <Button variant="secondary" icon={<Search size={16} />} onClick={applySearch}>查询</Button>
              <Button
                variant="secondary"
                icon={<RefreshCcw size={16} />}
                loading={releases.loading}
                onClick={() => void releases.reload()}
              >
                刷新
              </Button>
            </div>
          )}
        >
          <label className="releaseFilter releaseFilterSearch">
            <span>版本搜索</span>
            <Input
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") applySearch(); }}
              placeholder="版本号或标题"
            />
          </label>
          <label className="releaseFilter">
            <span>发布渠道</span>
            <Select value={filters.channel} onChange={(event) => {
              setPage(1);
              setFilters((current) => ({ ...current, channel: event.target.value as typeof filters.channel }));
            }}>
              <option value="all">全部渠道</option>
              {Object.entries(channelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </label>
          <label className="releaseFilter">
            <span>发布状态</span>
            <Select value={filters.status} onChange={(event) => {
              setPage(1);
              setFilters((current) => ({ ...current, status: event.target.value as typeof filters.status }));
            }}>
              <option value="all">全部状态</option>
              {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </label>
        </FilterBar>

        <DataTable<PlatformReleaseRecord>
          className="releaseTable"
          ariaLabel="版本发布列表"
          caption="版本发布历史"
          captionMode="visible"
          scrollMode="contained"
          rows={rows}
          getRowId={(row) => row.id}
          loading={releases.loading}
          error={releases.error || undefined}
          onRetry={releases.reload}
          emptyState={<EmptyState icon={PackageOpen} title="暂无版本记录" description="创建首个版本草稿后，发布历史会显示在这里。" action={<Button onClick={openCreate}>创建版本</Button>} />}
          onRowClick={setDetail}
          getRowAriaLabel={(row) => `查看版本 ${row.version}`}
          page={page}
          pageSize={pageSize}
          totalRows={Number(releases.data.total || 0)}
          manualPagination
          onPageChange={setPage}
          onPageSizeChange={(value) => { setPage(1); setPageSize(value); }}
          columns={[
            {
              id: "release",
              header: "版本",
              priority: "primary",
              minWidth: "220px",
              cell: (row) => <span className="releasePrimary"><strong>{row.version}</strong><span>{row.title}</span></span>,
            },
            { id: "channel", header: "渠道", priority: "primary", cell: (row) => <Badge tone={channelTone(row.channel)}>{channelLabels[row.channel]}</Badge> },
            { id: "status", header: "状态", priority: "primary", cell: (row) => <Badge tone={statusTone(row.status)}>{statusLabels[row.status]}</Badge> },
            { id: "summary", header: "版本摘要", priority: "secondary", minWidth: "260px", cell: (row) => <span className="releaseSummary">{row.summary}</span> },
            { id: "updated", header: "更新时间", priority: "detail", minWidth: "150px", cell: (row) => formatDate(row.updatedAt) },
            { id: "published", header: "发布时间", priority: "detail", minWidth: "150px", cell: (row) => formatDate(row.publishedAt) },
            {
              id: "action",
              header: "操作",
              priority: "primary",
              hideable: false,
              width: "190px",
              cell: (row) => (
                <span className="releaseRowActions">
                  {row.status === "draft" ? (
                    <Button size="compact" variant="secondary" onClick={() => openEdit(row)}>编辑说明</Button>
                  ) : row.status === "deploying" ? (
                    <Button
                      size="compact"
                      variant="secondary"
                      icon={<Activity size={14} />}
                      disabled={!deploymentItems.some((item) => item.releaseId === row.id && (isDeploymentActive(item.status) || item.status === "degraded_manual"))}
                      onClick={() => {
                        const item = deploymentItems.find((deployment) => deployment.releaseId === row.id && (isDeploymentActive(deployment.status) || deployment.status === "degraded_manual"));
                        if (item) openDeployment(item);
                      }}
                    >
                      查看进度
                    </Button>
                  ) : row.status === "published" ? (
                    <Button size="compact" variant="secondary" icon={<Archive size={14} />} onClick={() => setPendingArchive(row)}>归档</Button>
                  ) : (
                    <span className="releaseMuted">已归档</span>
                  )}
                </span>
              ),
            },
          ]}
        />
      </section>

      <Dialog
        open={editorOpen}
        title={editing ? "编辑版本草稿" : "创建版本草稿"}
        description={editing ? `更新 ${editing.version} 的版本信息。已发布版本不可再编辑。` : "先保存草稿，核对更新说明后再执行正式发布。"}
        size="lg"
        loading={saving}
        dirty={draftDirty}
        initialFocusRef={versionRef}
        onOpenChange={(open) => { if (!open && !saving) setEditorOpen(false); }}
        footer={({ requestClose, pending }) => (
          <div className="releaseDialogFooter">
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            <div>
              <Button variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>取消</Button>
              <Button type="submit" form="release-editor-form" loading={saving}>{editing ? "保存修改" : "保存草稿"}</Button>
            </div>
          </div>
        )}
      >
        <form id="release-editor-form" className="releaseForm" noValidate onSubmit={(event) => { event.preventDefault(); void submitDraft(); }}>
          <FormGrid columns={2}>
            <FormField label="版本号" required optionalLabel={null} error={formErrors.version} help="使用 SemVer，例如 1.8.0 或 1.9.0-beta.1。">
              <Input ref={versionRef} value={draft.version} maxLength={64} onChange={(event) => updateDraft("version", event.target.value)} placeholder="1.8.0" />
            </FormField>
            <FormField label="发布渠道" required optionalLabel={null} help="稳定版面向全部用户，Beta 用于公开测试，内部版仅用于内部验证。">
              <Select value={draft.channel} onChange={(event) => updateDraft("channel", event.target.value as PlatformReleaseChannel)}>
                {Object.entries(channelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </FormField>
          </FormGrid>
          <FormField label="版本标题" required optionalLabel={null} error={formErrors.title}>
            <Input value={draft.title} maxLength={120} onChange={(event) => updateDraft("title", event.target.value)} placeholder="例如：协作创作与运维能力升级" />
          </FormField>
          <FormField label="版本摘要" required optionalLabel={null} error={formErrors.summary} help="列表和版本概览中显示的简短说明，最多 500 字。">
            <textarea rows={3} maxLength={500} value={draft.summary} onChange={(event) => updateDraft("summary", event.target.value)} placeholder="概括本次版本的主要变化" />
          </FormField>
          <FormField label="完整更新说明" required optionalLabel={null} error={formErrors.releaseNotes} help="支持分行书写功能、优化和修复内容；发布后将作为历史记录保留。">
            <textarea rows={10} maxLength={20_000} value={draft.releaseNotes} onChange={(event) => updateDraft("releaseNotes", event.target.value)} placeholder={"新增\n- ...\n\n优化\n- ...\n\n修复\n- ..."} />
          </FormField>
        </form>
      </Dialog>

      <Drawer
        open={Boolean(detail)}
        title={detail ? `版本 ${detail.version}` : "版本详情"}
        description={detail?.title || "查看发布信息和操作上下文。"}
        size="680px"
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        footer={detail ? (
          <div className="releaseDrawerFooter">
            <Button variant="secondary" onClick={() => setDetail(null)}>关闭</Button>
            {detail.status === "draft" ? (
              <Button variant="secondary" onClick={() => openEdit(detail)}>编辑版本说明</Button>
            ) : detail.status === "deploying" ? (
              <Button
                icon={<Activity size={16} />}
                onClick={() => {
                  const item = deploymentItems.find((deployment) => deployment.releaseId === detail.id && (isDeploymentActive(deployment.status) || deployment.status === "degraded_manual"));
                  if (item) openDeployment(item);
                }}
              >
                查看发布进度
              </Button>
            ) : detail.status === "published" ? (
              <Button variant="secondary" icon={<Archive size={16} />} onClick={() => setPendingArchive(detail)}>归档版本</Button>
            ) : null}
          </div>
        ) : null}
      >
        {detail ? (
          <div className="releaseDetail">
            <DescriptionList items={[
              { label: "版本状态", value: <Badge tone={statusTone(detail.status)}>{statusLabels[detail.status]}</Badge> },
              { label: "发布渠道", value: <Badge tone={channelTone(detail.channel)}>{channelLabels[detail.channel]}</Badge> },
              { label: "版本摘要", value: detail.summary },
              { label: "创建时间", value: formatDate(detail.createdAt) },
              { label: "最后更新", value: formatDate(detail.updatedAt) },
              { label: "正式发布", value: formatDate(detail.publishedAt) },
              { label: "归档时间", value: formatDate(detail.archivedAt) },
              { label: "记录版本", value: `r${detail.revision}` },
            ]} />
            <section className="releaseNotes" aria-labelledby="release-notes-title">
              <h3 id="release-notes-title">完整更新说明</h3>
              <pre>{detail.releaseNotes}</pre>
            </section>
          </div>
        ) : null}
      </Drawer>

      {selectedDeployment ? (
        <DeploymentDrawer
          key={selectedDeployment.id}
          open
          deploymentId={selectedDeployment.id}
          releaseVersion={selectedReleaseVersion}
          initialDeployment={selectedDeployment.initial}
          onOpenChange={(open) => { if (!open) setSelectedDeployment(null); }}
          onDeploymentChanged={reloadReleaseSurfaces}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(pendingArchive)}
        title="确认归档此版本？"
        description={pendingArchive ? `版本 ${pendingArchive.version} 将从当前发布版本中归档，历史记录仍会保留。` : undefined}
        confirmLabel="确认归档"
        tone="danger"
        onCancel={() => setPendingArchive(null)}
        onConfirm={confirmArchive}
        onConfirmError={(error) => toast({
          title: "版本归档失败",
          message: error instanceof Error ? error.message : "操作未完成，请刷新后重试。",
          tone: "danger",
        })}
      />
    </ConsolePage>
  );
}
