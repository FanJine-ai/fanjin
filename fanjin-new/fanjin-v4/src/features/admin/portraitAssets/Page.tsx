import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Eye,
  KeyRound,
  RefreshCcw,
  Search,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  DescriptionList,
  Drawer,
  EmptyState,
  FilterBar,
  FormField,
  Input,
  MetricStrip,
  Section,
  Select,
  Switch,
  type BadgeTone,
  type DataTableColumn,
} from "../../../ui/console";
import { usePortraitAssets } from "./hooks";
import {
  claimPortraitManualReview,
  decidePortraitManualReview,
  getPortraitManualReview,
  loadPortraitManualReviewPreview,
  releasePortraitManualReview,
} from "./api";
import { Link } from "react-router-dom";
import {
  emptyPortraitAssetsFilters,
  type PortraitAssetRow,
  type PortraitAssetsFilters,
  type PortraitConfigurationStatus,
  type PortraitManualReviewDecision,
  type PortraitManualReviewDetail,
} from "./types";
import "./styles.css";

type PortraitAssetsPageProps = {
  title?: string;
  description?: string;
  sectionNavigation?: ReactNode;
};

const subjectLabels: Record<string, string> = {
  pending: "待判定",
  ordinary: "普通素材",
  real_person: "真人",
  virtual_person: "虚拟人物",
  trusted_output: "可信输出",
  ambiguous: "来源不明确",
  multiple_faces: "多人脸",
};

const scanLabels: Record<string, string> = {
  queued: "待扫描",
  scanning: "扫描中",
  no_face: "无人脸",
  single_face: "单人脸",
  multiple_faces: "多人脸",
  uncertain: "不确定",
  failed: "扫描失败",
};

const moderationLabels: Record<string, string> = {
  pending: "待审核",
  checking: "审核中",
  allowed: "审核通过",
  denied: "审核拒绝",
  failed: "审核失败",
};

const complianceLabels: Record<string, string> = {
  pending: "待准入",
  not_required: "无需授权",
  allowed: "已准入",
  denied: "已拒绝",
  expired: "已过期",
  revoked: "已撤销",
};

const syncLabels: Record<string, string> = {
  not_needed: "无需同步",
  queued: "等待同步",
  authorizing: "等待授权",
  creating_group: "创建分组",
  processing: "同步中",
  active: "Active",
  failed: "同步失败",
  stale: "需要重建",
};

const manualReviewLabels: Record<string, string> = {
  not_required: "新版无需人工复核",
  pending: "旧版待迁移",
  in_review: "旧版待迁移",
  completed: "旧版复核记录",
  superseded: "旧版记录已停用",
};

const imageXReviewLabels: Record<string, string> = {
  prepared: "已准备",
  submitting: "提交中",
  submission_unknown: "提交结果未知",
  polling: "轮询中",
  allowed: "审核通过",
  denied: "审核拒绝",
  review_required: "需要人工核查",
  failed: "审核失败",
};

const manualDecisionLabels: Record<PortraitManualReviewDecision, string> = {
  no_face: "全片无人脸",
  single_face: "全片单人脸",
  multiple_faces: "发现多人脸",
  uncertain: "仍无法确认",
};

const configurationReasonLabels: Record<string, string> = {
  not_configured: "尚未配置运行环境。",
  configuration_invalid: "运行环境配置无效，请联系运维人员检查。",
  imagex_review_channel_unavailable: "ImageX 审核通道不可用。",
  imagex_review_worker_tick_failed: "ImageX Worker 最近一次处理失败。",
  imagex_review_worker_not_running: "ImageX Worker 尚未启动。",
  imagex_review_worker_not_observed: "尚未观测到 ImageX Worker 心跳。",
  imagex_review_worker_heartbeat_stale: "ImageX Worker 心跳已过期。",
  imagex_review_worker_heartbeat_future: "ImageX Worker 心跳时间异常。",
  imagex_review_worker_release_mismatch: "ImageX Worker 与当前 API 版本不一致。",
  imagex_review_worker_release_unverifiable: "无法验证 ImageX Worker 的发布版本。",
  imagex_review_worker_unhealthy: "ImageX Worker 已在线但当前不健康。",
  imagex_review_worker_inspection_failed: "ImageX Worker 心跳检查失败。",
};

function label(map: Record<string, string>, value: string) {
  return map[value] || value || "—";
}

function toneForState(value: string): BadgeTone {
  if (["allowed", "not_required", "active", "no_face", "single_face", "completed"].includes(value)) return "success";
  if (["pending", "queued", "prepared", "submitting", "polling", "scanning", "checking", "authorizing", "creating_group", "processing", "in_review"].includes(value)) return "info";
  if (["submission_unknown", "review_required", "uncertain", "stale", "expired", "ambiguous", "multiple_faces"].includes(value)) return "warning";
  if (["denied", "failed", "revoked"].includes(value)) return "danger";
  return "neutral";
}

function readPositiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readFilters(params: URLSearchParams): PortraitAssetsFilters {
  return {
    keyword: params.get("pa_q") || "",
    subjectKind: params.get("pa_subject") || "",
    faceScanState: params.get("pa_scan") || "",
    moderationState: params.get("pa_moderation") || "",
    complianceState: params.get("pa_compliance") || "",
    providerSyncState: params.get("pa_sync") || "",
    manualReviewState: params.get("pa_manual") || "",
    imageXReviewState: params.get("pa_imagex") || "",
    pageNum: readPositiveInteger(params.get("pa_page"), 1),
    pageSize: Math.min(100, readPositiveInteger(params.get("pa_size"), 20)),
  };
}

function formatTimestamp(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 60_000) return "不足 1 分钟";
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时 ${minutes % 60} 分钟`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/**
 * `ended` alone is not evidence that the reviewer watched the full film: a
 * seek to the final frame also fires it. The browser-maintained `played`
 * ranges exclude skipped spans, so require one gap-free coverage chain from
 * the beginning through the duration (with a small media-timestamp tolerance).
 */
export function hasPlayedEntireReviewVideo(
  video: Pick<HTMLVideoElement, "duration" | "played">,
  toleranceSeconds = 0.5,
): boolean {
  const duration = Number(video.duration);
  const tolerance = Number(toleranceSeconds);
  if (
    !Number.isFinite(duration)
    || duration <= 0
    || !Number.isFinite(tolerance)
    || tolerance < 0
    || video.played.length < 1
  ) return false;
  const effectiveTolerance = Math.min(tolerance, duration * 0.01);
  let coveredUntil = 0;
  for (let index = 0; index < video.played.length; index += 1) {
    const start = Number(video.played.start(index));
    const end = Number(video.played.end(index));
    if (
      !Number.isFinite(start)
      || !Number.isFinite(end)
      || start < 0
      || end < start
      || start > coveredUntil + effectiveTolerance
    ) return false;
    coveredUntil = Math.max(coveredUntil, end);
  }
  return coveredUntil >= duration - effectiveTolerance;
}

function ConfigurationCard({
  label: title,
  value,
}: {
  label: string;
  value: PortraitConfigurationStatus;
}) {
  const tone: BadgeTone = value.ready ? "success" : value.configured && !value.valid ? "danger" : "warning";
  const status = value.ready ? "就绪" : value.configured && !value.valid ? "配置无效" : "未配置";
  return (
    <article className="portraitAssetsConfigCard">
      <span className="portraitAssetsConfigCard__icon" aria-hidden="true">
        {value.ready ? <ShieldCheck size={18} /> : <ShieldQuestion size={18} />}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{value.reason
          ? configurationReasonLabels[value.reason] || "运行环境配置尚未就绪。"
          : value.ready
            ? "配置有效，可处理新的素材。"
            : "需要完成运行环境配置。"}</p>
        {value.worker ? (
          <p>
            Worker：{value.worker.running ? "运行中" : "未运行"}
            {` · 心跳${value.worker.heartbeatFresh ? "新鲜" : "不可用"}`}
            {value.worker.heartbeatAgeMs == null
              ? ""
              : ` · ${formatDuration(value.worker.heartbeatAgeMs)}前`}
          </p>
        ) : null}
      </div>
      <Badge tone={tone}>{status}</Badge>
    </article>
  );
}

function StateBadge({ value, labels }: { value: string; labels: Record<string, string> }) {
  return <Badge tone={toneForState(value)}>{label(labels, value)}</Badge>;
}

export default function PortraitAssetsPage({
  title = "人像资产",
  description = "配置 ImageX 人像检测，并观察用户分类、内容审核与火山资产准入状态。",
  sectionNavigation,
}: PortraitAssetsPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramsKey = searchParams.toString();
  const filters = useMemo(() => readFilters(searchParams), [paramsKey]);
  const [draft, setDraft] = useState(filters);
  const [detail, setDetail] = useState<PortraitAssetRow | null>(null);
  const [review, setReview] = useState<PortraitManualReviewDetail | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [fullVideoViewed, setFullVideoViewed] = useState(false);
  const [faceCountOnlyConfirmed, setFaceCountOnlyConfirmed] = useState(false);
  const [decision, setDecision] = useState<PortraitManualReviewDecision>("uncertain");
  const [reviewMutating, setReviewMutating] = useState(false);
  const [reviewDecisionConfirmationOpen, setReviewDecisionConfirmationOpen] = useState(false);
  const selectionGenerationRef = useRef(0);
  const selectedAdmissionIdRef = useRef<string | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const mutationRequestRef = useRef<AbortController | null>(null);
  const state = usePortraitAssets(filters);

  useEffect(() => setDraft(filters), [paramsKey]);

  useEffect(() => () => {
    detailRequestRef.current?.abort();
    mutationRequestRef.current?.abort();
  }, []);

  function writeFilters(next: PortraitAssetsFilters) {
    const params = new URLSearchParams(searchParams);
    ["pa_q", "pa_subject", "pa_scan", "pa_moderation", "pa_compliance", "pa_sync", "pa_manual", "pa_imagex", "pa_page", "pa_size"]
      .forEach((key) => params.delete(key));
    params.set("section", "portrait-assets");
    if (next.keyword.trim()) params.set("pa_q", next.keyword.trim());
    if (next.subjectKind) params.set("pa_subject", next.subjectKind);
    if (next.faceScanState) params.set("pa_scan", next.faceScanState);
    if (next.moderationState) params.set("pa_moderation", next.moderationState);
    if (next.complianceState) params.set("pa_compliance", next.complianceState);
    if (next.providerSyncState) params.set("pa_sync", next.providerSyncState);
    if (next.manualReviewState) params.set("pa_manual", next.manualReviewState);
    if (next.imageXReviewState) params.set("pa_imagex", next.imageXReviewState);
    if (next.pageNum > 1) params.set("pa_page", String(next.pageNum));
    if (next.pageSize !== 20) params.set("pa_size", String(next.pageSize));
    setSearchParams(params, { replace: true });
  }

  function submitFilters() {
    writeFilters({ ...draft, pageNum: 1 });
  }

  async function openDetail(row: PortraitAssetRow) {
    detailRequestRef.current?.abort();
    mutationRequestRef.current?.abort();
    const generation = selectionGenerationRef.current + 1;
    selectionGenerationRef.current = generation;
    selectedAdmissionIdRef.current = row.id;
    setDetail(row);
    setReview(null);
    setReviewError("");
    setPreviewUrl("");
    setFullVideoViewed(false);
    setFaceCountOnlyConfirmed(false);
    setDecision("uncertain");
    setReviewMutating(false);
    setReviewDecisionConfirmationOpen(false);
    if (!row.manualReview.reviewId || !["completed", "superseded"].includes(row.manualReview.state)) return;
    const controller = new AbortController();
    detailRequestRef.current = controller;
    setReviewLoading(true);
    try {
      const next = await getPortraitManualReview(row.id, controller.signal);
      if (
        controller.signal.aborted
        || selectionGenerationRef.current !== generation
        || selectedAdmissionIdRef.current !== row.id
        || next.admission.id !== row.id
        || next.review.id !== row.manualReview.reviewId
      ) return;
      setReview(next);
    } catch (error) {
      if (
        controller.signal.aborted
        || selectionGenerationRef.current !== generation
        || selectedAdmissionIdRef.current !== row.id
      ) return;
      setReviewError(error instanceof Error ? error.message : "人工复核读取失败");
    } finally {
      if (
        selectionGenerationRef.current === generation
        && selectedAdmissionIdRef.current === row.id
      ) setReviewLoading(false);
      if (detailRequestRef.current === controller) detailRequestRef.current = null;
    }
  }

  function closeDetail() {
    selectionGenerationRef.current += 1;
    selectedAdmissionIdRef.current = null;
    detailRequestRef.current?.abort();
    mutationRequestRef.current?.abort();
    detailRequestRef.current = null;
    mutationRequestRef.current = null;
    setReviewLoading(false);
    setReviewMutating(false);
    setReviewDecisionConfirmationOpen(false);
    setDetail(null);
    setReview(null);
    setPreviewUrl("");
  }

  useEffect(() => {
    if (!review?.review.claimedByCurrentAdmin || review.review.state !== "claimed") {
      setPreviewUrl("");
      return undefined;
    }
    const controller = new AbortController();
    setPreviewUrl("");
    setFullVideoViewed(false);
    void loadPortraitManualReviewPreview(
      review.review.id,
      review.review.revision,
      controller.signal,
    )
      .then((url) => {
        if (controller.signal.aborted) return;
        setPreviewUrl(url);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setReviewError(error instanceof Error ? error.message : "复核视频暂不可播放");
        }
      });
    return () => {
      controller.abort();
    };
  }, [
    review?.review.id,
    review?.review.revision,
    review?.review.claimedByCurrentAdmin,
    review?.review.state,
  ]);

  async function mutateReview(action: "claim" | "release" | "decide") {
    if (
      !review
      || !detail
      || review.admission.id !== detail.id
      || review.review.id !== detail.manualReview.reviewId
      || selectedAdmissionIdRef.current !== detail.id
    ) return false;
    if (action === "decide") {
      if (!fullVideoViewed || !faceCountOnlyConfirmed) return false;
    }
    mutationRequestRef.current?.abort();
    const controller = new AbortController();
    mutationRequestRef.current = controller;
    const generation = selectionGenerationRef.current;
    const admissionId = detail.id;
    const reviewId = review.review.id;
    const base = {
      admissionId: review.admission.id,
      reviewId: review.review.id,
      expectedAdmissionRevision: review.admission.revision,
      expectedReviewRevision: review.review.revision,
    };
    setReviewMutating(true);
    setReviewError("");
    try {
      let next: PortraitManualReviewDetail;
      if (action === "claim") {
        next = await claimPortraitManualReview(base, controller.signal);
      } else if (action === "release") {
        next = await releasePortraitManualReview(base, controller.signal);
      } else {
        next = await decidePortraitManualReview({
          ...base,
          decision,
          fullVideoViewed: true,
          faceCountOnlyConfirmed: true,
        }, controller.signal);
      }
      if (
        controller.signal.aborted
        || selectionGenerationRef.current !== generation
        || selectedAdmissionIdRef.current !== admissionId
        || next.admission.id !== admissionId
        || next.review.id !== reviewId
      ) return false;
      setReview(next);
      if (action === "decide") state.reload();
      return true;
    } catch (error) {
      if (
        controller.signal.aborted
        || selectionGenerationRef.current !== generation
        || selectedAdmissionIdRef.current !== admissionId
      ) return false;
      setReviewError(error instanceof Error ? error.message : "人工复核操作失败");
      return false;
    } finally {
      if (
        selectionGenerationRef.current === generation
        && selectedAdmissionIdRef.current === admissionId
      ) setReviewMutating(false);
      if (mutationRequestRef.current === controller) mutationRequestRef.current = null;
    }
  }

  const columns = useMemo<DataTableColumn<PortraitAssetRow>[]>(() => [
    {
      id: "asset",
      header: "素材",
      priority: "primary",
      minWidth: "210px",
      sortable: true,
      sortValue: (row) => row.asset.name,
      cell: (row) => (
        <div className="portraitAssetsIdentity">
          <strong>{row.asset.name}</strong>
          <span>{row.asset.mediaType === "video" ? "视频" : "图片"} · #{row.asset.id} / v{row.asset.versionId}</span>
        </div>
      ),
    },
    {
      id: "context",
      header: "工作区 / 项目",
      priority: "primary",
      minWidth: "190px",
      cell: (row) => (
        <div className="portraitAssetsIdentity">
          <strong>{row.workspace.name}</strong>
          <span>{row.project.name}</span>
        </div>
      ),
    },
    {
      id: "subject",
      header: "主体",
      priority: "secondary",
      cell: (row) => <Badge tone={toneForState(row.subjectKind)}>{label(subjectLabels, row.subjectKind)}</Badge>,
    },
    {
      id: "scan",
      header: "人脸扫描",
      priority: "primary",
      cell: (row) => (
        <div className="portraitAssetsStateCell">
          <StateBadge value={row.faceScan.state} labels={scanLabels} />
          {row.faceScan.faceCount == null ? null : <span>{row.faceScan.faceCount} 张</span>}
        </div>
      ),
    },
    {
      id: "moderation",
      header: "内容审核",
      priority: "secondary",
      cell: (row) => <StateBadge value={row.moderationState} labels={moderationLabels} />,
    },
    {
      id: "imageXReview",
      header: "ImageX 审核",
      priority: "primary",
      minWidth: "150px",
      cell: (row) => row.imageXReview ? (
        <div className="portraitAssetsStateCell">
          <StateBadge value={row.imageXReview.state} labels={imageXReviewLabels} />
          <span>{row.imageXReview.attempts} 次处理 · {formatDuration(row.imageXReview.ageMs)}</span>
        </div>
      ) : <Badge tone="neutral">尚未触发</Badge>,
    },
    {
      id: "manualReview",
      header: "旧版复核记录",
      priority: "primary",
      minWidth: "140px",
      cell: (row) => (
        <div className="portraitAssetsStateCell">
          <Badge tone={toneForState(row.manualReview.state)}>
            {label(manualReviewLabels, row.manualReview.state)}
          </Badge>
          {row.manualReview.decision
            ? <span>{manualDecisionLabels[row.manualReview.decision as PortraitManualReviewDecision] || row.manualReview.decision}</span>
            : null}
        </div>
      ),
    },
    {
      id: "compliance",
      header: "准入",
      priority: "primary",
      cell: (row) => <StateBadge value={row.complianceState} labels={complianceLabels} />,
    },
    {
      id: "sync",
      header: "供应商同步",
      priority: "primary",
      minWidth: "130px",
      cell: (row) => (
        <div className="portraitAssetsStateCell">
          <StateBadge value={row.providerSyncState} labels={syncLabels} />
          <span>{row.provider.channelName || "无通道"}</span>
        </div>
      ),
    },
    {
      id: "binding",
      header: "Group / Asset",
      headerLabel: "供应商 Group 与 Asset 状态",
      priority: "detail",
      minWidth: "150px",
      cell: (row) => (
        <div className="portraitAssetsIdentity">
          <strong>{row.provider.groupType || "未创建 Group"}</strong>
          <span>{row.provider.groupState || "—"} / {row.provider.assetState || "—"}</span>
        </div>
      ),
    },
    {
      id: "error",
      header: "安全错误",
      priority: "secondary",
      minWidth: "180px",
      cell: (row) => row.error ? (
        <div className="portraitAssetsError">
          <CircleAlert size={15} aria-hidden="true" />
          <span>{row.error.code}</span>
        </div>
      ) : "—",
    },
    {
      id: "updatedAt",
      header: "更新时间",
      priority: "detail",
      sortable: true,
      sortValue: (row) => row.updatedAt,
      cell: (row) => <time dateTime={new Date(row.updatedAt).toISOString()}>{formatTimestamp(row.updatedAt)}</time>,
    },
    {
      id: "actions",
      header: "查看",
      headerLabel: "查看详情",
      priority: "primary",
      hideable: false,
      cell: (row) => (
        <Button
          size="compact"
          variant="secondary"
          icon={<Eye size={15} />}
          aria-label={`查看人像资产 ${row.asset.name} 详情`}
          onClick={(event) => {
            event.stopPropagation();
            void openDetail(row);
          }}
        >详情</Button>
      ),
    },
  ], []);

  const response = state.data;
  const featureAvailable = response?.feature.available !== false;
  const metrics = response?.metrics;

  return (
    <ConsolePage
      title={title}
      description={description}
      primaryAction={(
        <Button
          variant="secondary"
          icon={<RefreshCcw size={17} />}
          loading={state.loading}
          onClick={state.reload}
        >刷新</Button>
      )}
      layoutWidth="dashboard"
      className="portraitAssetsPage"
    >
      {sectionNavigation}
      {response ? (
        <Section title="处理能力" description="只显示配置是否就绪，不暴露端点、凭据或授权链接。" surface="subtle">
          <div className="portraitAssetsConfigGrid">
            <ConfigurationCard label="人脸检测" value={response.configuration.detector} />
            <ConfigurationCard label="内容审核" value={response.configuration.moderation} />
            <article className="portraitAssetsConfigCard">
              <span className="portraitAssetsConfigCard__icon" aria-hidden="true"><KeyRound size={18} /></span>
              <div>
                <strong>ImageX 直连配置</strong>
                <p>ImageX 凭据已独立到媒体服务页；不再依附视频模型通道。</p>
              </div>
              <Link to="/fjadmin/media-services">配置媒体服务</Link>
            </article>
          </div>
        </Section>
      ) : null}
      {response && !response.feature.available ? (
        <Alert tone="warning" title="人像资产观测暂不可用">
          <p>{response.feature.message || `需要数据库 schema ${response.feature.requiredSchema}。`}</p>
        </Alert>
      ) : null}
      <MetricStrip
        ariaLabel="人像资产关键指标"
        className="portraitAssetsMetrics"
        metrics={[
          { id: "admitted", label: "准入通过", value: state.loading ? "—" : metrics?.admitted ?? 0, hint: `共 ${metrics?.total ?? 0} 条`, tone: "positive" },
          { id: "authorization", label: "待授权", value: state.loading ? "—" : metrics?.awaitingAuthorization ?? 0, hint: "真人 LivenessFace", tone: "warning" },
          { id: "syncing", label: "同步中", value: state.loading ? "—" : metrics?.syncing ?? 0, hint: "排队 / 建组 / 处理", tone: "info" },
          { id: "active", label: "Active", value: state.loading ? "—" : metrics?.active ?? 0, hint: "供应商侧可用", tone: "positive" },
          { id: "failed", label: "失败", value: state.loading ? "—" : metrics?.failed ?? 0, hint: "拒绝 / 过期 / 同步失败", tone: "danger" },
        ]}
      />
      <FilterBar
        advanced={(
          <>
            <FormField label="人脸扫描" optionalLabel={null}>
              <Select value={draft.faceScanState} onChange={(event) => setDraft((current) => ({ ...current, faceScanState: event.target.value }))}>
                <option value="">全部扫描状态</option>
                {Object.entries(scanLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </Select>
            </FormField>
            <FormField label="内容审核" optionalLabel={null}>
              <Select value={draft.moderationState} onChange={(event) => setDraft((current) => ({ ...current, moderationState: event.target.value }))}>
                <option value="">全部审核状态</option>
                {Object.entries(moderationLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </Select>
            </FormField>
            <FormField label="供应商同步" optionalLabel={null}>
              <Select value={draft.providerSyncState} onChange={(event) => setDraft((current) => ({ ...current, providerSyncState: event.target.value }))}>
                <option value="">全部同步状态</option>
                {Object.entries(syncLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </Select>
            </FormField>
            <FormField label="旧版复核记录" optionalLabel={null}>
              <Select value={draft.manualReviewState} onChange={(event) => setDraft((current) => ({ ...current, manualReviewState: event.target.value }))}>
                <option value="">全部人工复核状态</option>
                {Object.entries(manualReviewLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </Select>
            </FormField>
            <FormField label="ImageX 审核" optionalLabel={null}>
              <Select value={draft.imageXReviewState} onChange={(event) => setDraft((current) => ({ ...current, imageXReviewState: event.target.value }))}>
                <option value="">全部 ImageX 状态</option>
                {Object.entries(imageXReviewLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </Select>
            </FormField>
          </>
        )}
        activeAdvancedCount={[draft.faceScanState, draft.moderationState, draft.providerSyncState, draft.manualReviewState, draft.imageXReviewState].filter(Boolean).length}
        actions={(
          <div className="portraitAssetsActions">
            <Button icon={<Search size={16} />} onClick={submitFilters}>查询</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(emptyPortraitAssetsFilters);
                writeFilters(emptyPortraitAssetsFilters);
              }}
            >清除</Button>
          </div>
        )}
      >
        <FormField className="portraitAssetsField portraitAssetsField--keyword" label="工作区、项目或素材" optionalLabel={null}>
          <Input
            value={draft.keyword}
            placeholder="输入名称或 admission ID"
            onChange={(event) => setDraft((current) => ({ ...current, keyword: event.target.value }))}
            onKeyDown={(event) => { if (event.key === "Enter") submitFilters(); }}
          />
        </FormField>
        <FormField className="portraitAssetsField" label="主体类型" optionalLabel={null}>
          <Select value={draft.subjectKind} onChange={(event) => setDraft((current) => ({ ...current, subjectKind: event.target.value }))}>
            <option value="">全部主体</option>
            {Object.entries(subjectLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </Select>
        </FormField>
        <FormField className="portraitAssetsField" label="准入状态" optionalLabel={null}>
          <Select value={draft.complianceState} onChange={(event) => setDraft((current) => ({ ...current, complianceState: event.target.value }))}>
            <option value="">全部准入状态</option>
            {Object.entries(complianceLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </Select>
        </FormField>
      </FilterBar>
      {featureAvailable ? (
        <DataTable
          columns={columns}
          rows={response?.items ?? []}
          getRowId={(row) => row.id}
          caption="人像资产准入与供应商同步列表"
          ariaLabel="人像资产列表"
          loading={state.loading}
          error={state.error || undefined}
          onRetry={state.reload}
          emptyState="当前条件下暂无人像资产记录"
          onRowClick={(row) => { void openDetail(row); }}
          getRowAriaLabel={(row) => `查看人像资产 ${row.asset.name} 详情`}
          manualPagination
          page={filters.pageNum}
          pageSize={filters.pageSize}
          totalRows={response?.pagination.total ?? 0}
          onPageChange={(pageNum) => writeFilters({ ...filters, pageNum })}
          onPageSizeChange={(pageSize) => writeFilters({ ...filters, pageNum: 1, pageSize })}
          pagination="always"
          paginationLabel="人像资产分页"
          scrollMode="page"
        />
      ) : (
        <EmptyState
          icon={ShieldQuestion}
          title="等待 schema 47"
          description="数据库升级完成后刷新即可查看；当前页面不会尝试写入或修复数据。"
          action={<Button variant="secondary" icon={<RefreshCcw size={16} />} onClick={state.reload}>重新检查</Button>}
        />
      )}
      <Drawer
        open={Boolean(detail)}
        title={detail ? `人像资产详情 · ${detail.asset.name}` : "人像资产详情"}
        description="状态与旧版复核历史；不会显示素材地址、供应商 URI、签名链接、证据原文或凭据。"
        size="min(620px, 100vw)"
        onOpenChange={(open) => { if (!open) closeDetail(); }}
      >
        {detail ? (
          <div className="portraitAssetsDetail">
            <DescriptionList items={[
              { label: "工作区", value: `${detail.workspace.name} (${detail.workspace.id})` },
              { label: "项目", value: `${detail.project.name} (#${detail.project.id})` },
              { label: "素材", value: `${detail.asset.name} · ${detail.asset.mediaType} · v${detail.asset.versionId}` },
              { label: "主体", value: label(subjectLabels, detail.subjectKind) },
              { label: "用户分类", value: detail.declaration?.classification === "real_person" ? "真人像" : detail.declaration?.classification === "virtual_person" ? "虚拟人像" : "未分类" },
              { label: "免责声明版本", value: detail.declaration?.termsVersion || "未记录（旧数据）" },
              { label: "声明确认", value: detail.declaration?.acceptedAt ? `${formatTimestamp(detail.declaration.acceptedAt)} · ${detail.declaration.actorRef || "用户"}` : "未确认" },
              { label: "人脸扫描", value: `${label(scanLabels, detail.faceScan.state)}${detail.faceScan.faceCount == null ? "" : ` · ${detail.faceScan.faceCount} 张`}` },
              { label: "旧版复核历史", value: label(manualReviewLabels, detail.manualReview.state) },
              { label: "内容审核", value: label(moderationLabels, detail.moderationState) },
              { label: "准入", value: label(complianceLabels, detail.complianceState) },
              { label: "供应商同步", value: label(syncLabels, detail.providerSyncState) },
              { label: "供应商通道", value: [detail.provider.name, detail.provider.channelName].filter(Boolean).join(" · ") || "未选择" },
              { label: "Group", value: [detail.provider.groupType, detail.provider.groupState].filter(Boolean).join(" · ") || "未创建" },
              { label: "Asset 状态", value: detail.provider.assetState || "未创建" },
              { label: "更新时间", value: formatTimestamp(detail.updatedAt) },
            ]} />
            <section className="portraitAssetsImageXReview" aria-label="ImageX 持久审核任务">
              <div className="portraitAssetsImageXReview__heading">
                <div>
                  <h3>ImageX 持久审核</h3>
                  <p>仅展示安全状态与处理节奏，不显示任务 ID、素材地址、请求证据或凭据。</p>
                </div>
                {detail.imageXReview
                  ? <StateBadge value={detail.imageXReview.state} labels={imageXReviewLabels} />
                  : <Badge tone="neutral">尚未触发</Badge>}
              </div>
              {detail.imageXReview ? (
                <>
                  <DescriptionList items={[
                    { label: "状态", value: label(imageXReviewLabels, detail.imageXReview.state) },
                    { label: "任务阶段", value: detail.imageXReview.terminal ? "已进入终态" : "处理中" },
                    { label: "处理尝试", value: `${detail.imageXReview.attempts} 次` },
                    { label: "已运行", value: formatDuration(detail.imageXReview.ageMs) },
                    { label: "最近活动", value: formatTimestamp(detail.imageXReview.lastActivityAt) },
                  ]} />
                  {detail.imageXReview.safeError ? (
                    <Alert tone="danger" title={detail.imageXReview.safeError.code}>
                      <p>{detail.imageXReview.safeError.message}</p>
                    </Alert>
                  ) : null}
                </>
              ) : <p className="portraitAssetsImageXReview__empty">当前 admission 没有关联的 ImageX 持久任务。</p>}
            </section>
            {detail.manualReview.reviewId && ["completed", "superseded"].includes(detail.manualReview.state) ? (
              <section className="portraitAssetsReview" aria-label="旧版视频人脸复核历史">
                <Alert tone="info" title="0.1.1 旧版复核历史（只读）">
                  <p>0.1.2 已停用人工全片复核。旧记录只用于审计，不再允许领取、修改或阻塞用户。</p>
                </Alert>
                {reviewLoading ? <p>正在读取复核状态…</p> : null}
                {reviewError ? <Alert tone="danger" title="复核操作失败"><p>{reviewError}</p></Alert> : null}
                {review ? (
                  <>
                    <DescriptionList items={[
                      { label: "复核状态", value: label(manualReviewLabels, review.admission.manualReviewState) },
                      { label: "领取状态", value: review.review.claimedByCurrentAdmin ? "当前会话已领取" : review.review.state === "claimed" ? "已由其他管理员领取" : "未领取" },
                      { label: "素材绑定", value: `项目 #${review.admission.projectId} · 版本 v${review.admission.assetVersionId}` },
                    ]} />
                    {!review.review.claimedByCurrentAdmin && ["pending", "claimed"].includes(review.review.state) ? (
                      <Button
                        loading={reviewMutating}
                        onClick={() => { void mutateReview("claim"); }}
                      >领取复核</Button>
                    ) : null}
                    {review.review.claimedByCurrentAdmin && review.review.state === "claimed" ? (
                      <div className="portraitAssetsReview__workspace">
                        {previewUrl ? (
                          <video
                            className="portraitAssetsReview__video"
                            aria-label="全片人脸复核视频"
                            controls
                            playsInline
                            preload="metadata"
                            src={previewUrl}
                            onEnded={(event) => {
                              setFullVideoViewed(hasPlayedEntireReviewVideo(event.currentTarget));
                            }}
                            onError={() => {
                              setFullVideoViewed(false);
                              setReviewError("复核视频加载失败，请关闭详情后重新打开重试。");
                            }}
                          >当前浏览器无法播放复核视频。</video>
                        ) : <p>正在通过同源认证代理加载视频…</p>}
                        <p>{fullVideoViewed
                          ? "已完整播放全片。"
                          : "必须完整播放全片；跳转跳过的片段不计入已观看。"}</p>
                        <FormField label="人脸数量结论" optionalLabel={null}>
                          <Select
                            value={decision}
                            onChange={(event) => setDecision(event.target.value as PortraitManualReviewDecision)}
                          >
                            {Object.entries(manualDecisionLabels).map(([value, text]) => (
                              <option key={value} value={value}>{text}</option>
                            ))}
                          </Select>
                        </FormField>
                        <label className="portraitAssetsReview__confirmation">
                          <input
                            type="checkbox"
                            checked={faceCountOnlyConfirmed}
                            onChange={(event) => setFaceCountOnlyConfirmed(event.target.checked)}
                          />
                          <span>我已完整观看全片，并确认本结论只判断人脸数量。</span>
                        </label>
                        <div className="portraitAssetsActions">
                          <Button
                            disabled={!fullVideoViewed || !faceCountOnlyConfirmed}
                            loading={reviewMutating}
                            onClick={() => setReviewDecisionConfirmationOpen(true)}
                          >提交复核结论</Button>
                          <Button
                            variant="secondary"
                            loading={reviewMutating}
                            onClick={() => { void mutateReview("release"); }}
                          >释放回队列</Button>
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}
            {detail.error ? (
              <Alert tone="danger" title={detail.error.code}>
                <p>{detail.error.message}</p>
              </Alert>
            ) : (
              <Alert tone="success" title="未记录安全错误">
                <p>当前 admission 没有可展示的安全错误。</p>
              </Alert>
            )}
          </div>
        ) : null}
      </Drawer>
      <ConfirmDialog
        open={reviewDecisionConfirmationOpen}
        title="提交全片人脸复核结论？"
        description={`将记录“${manualDecisionLabels[decision]}”。本结论只判断全片人脸数量，不代表内容审核、肖像权或供应商准入已经通过。`}
        confirmLabel="确认提交"
        tone="danger"
        loading={reviewMutating}
        onCancel={() => setReviewDecisionConfirmationOpen(false)}
        onConfirm={() => mutateReview("decide")}
      />
    </ConsolePage>
  );
}
