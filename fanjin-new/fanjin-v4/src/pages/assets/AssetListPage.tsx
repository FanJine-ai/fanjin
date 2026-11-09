import { type ChangeEvent, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Cloud, Download, ExternalLink, FileAudio, FileText, Filter, HardDrive, Image, Loader2, Search, Trash2, Upload, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  deleteCreativeLibraryItems,
  listCompleteCreativeLibrary,
  type CreativeLibraryItem,
  type PublicGenerationHistory,
  type PublicGenerationOperation,
} from "../../api/creativeLibraryApi";
import type { Asset } from "../../api/types";
import * as assetsApi from "../../api/assets";
import {
  inferMimeCategory,
  REFERENCE_ATTACHMENT_ACCEPT,
  type UploadedReferenceAsset,
  uploadReferenceAttachment,
} from "../../features/quick-create/attachments/api";
import { useAuthStore } from "../../stores/authStore";
import { canDeleteProjects } from "../../utils/permissions";
import { useAssetStore } from "../../stores/assetStore";
import { normalizeProjectId, useProjectStore } from "../../stores/projectStore";
import { useV4Theme } from "../../ui/useV4Theme";
import { formatGuMicros } from "../../utils/billingUnits";
import {
  ASSET_USAGE_LABELS,
  assetGroupFromTags,
  assetUsageFromTags,
  type AssetUsage,
} from "../../features/assets/assetMetadata";
import FrontstageNav from "../frontstage/FrontstageNav";
import "../create/QuickCreateView.css";
import "./AssetListPage.css";

type PrimaryTab = "history" | "assets" | "cloud";
type AssetKind = "图片" | "视频" | "音频" | "文档";

type AssetCard = {
  id: string;
  numericId?: number;
  libraryId?: string;
  title: string;
  description: string;
  searchText?: string;
  image: string;
  kind: AssetKind;
  allowMediaPreview: boolean;
  allowInlineOpen: boolean;
  tab: PrimaryTab;
  date: string;
  duration?: string;
  source: "api" | "library" | "cloud" | "local";
  assetType?: Asset["type"];
  usage?: AssetUsage | null;
  group?: { id: string; name: string; usage: AssetUsage } | null;
  fileFormat?: string;
  generationCorrelationDigest?: string;
  projectCorrelationDigest?: string;
  taskCorrelationDigest?: string;
  assetCorrelationDigest?: string;
  contentSha256?: string;
  generationHistory?: PublicGenerationHistory;
};

type SourceFilter = "all" | AssetCard["source"];
type ProjectAssetTypeFilter = "all" | AssetUsage | "uncategorized";

const primaryTabs: Array<{ id: PrimaryTab; label: string }> = [
  { id: "history", label: "生成历史" },
  { id: "assets", label: "资产" },
  { id: "cloud", label: "云存储" },
];

const kindTabs: Array<AssetKind | "全部"> = ["全部", "图片", "视频", "音频", "文档"];
const projectAssetTypeFilters: Array<{ value: ProjectAssetTypeFilter; label: string }> = [
  { value: "all", label: "全部资产" },
  { value: "role", label: "角色 / 人物" },
  { value: "scene", label: "场景" },
  { value: "tool", label: "道具" },
  { value: "action", label: "动作参考" },
  { value: "audio", label: "声音" },
  { value: "camera", label: "运镜参考" },
  { value: "style", label: "风格参考" },
  { value: "composition", label: "分镜" },
  { value: "other", label: "其他" },
  { value: "uncategorized", label: "未分类" },
];
const cloudAssetTypes = ["image", "video", "audio", "document"] as const;

const generationOperationLabels: Record<PublicGenerationOperation, string> = {
  generate: "原始生成",
  extend: "延长版本",
  edit: "编辑版本",
  upscale: "超分版本",
};

function generationParameterLabels(history: PublicGenerationHistory): string[] {
  const parameters = history.parameters;
  const labels: string[] = [];
  if (parameters.sourceResolution && parameters.targetResolution) {
    labels.push(`${parameters.sourceResolution} → ${parameters.targetResolution}`);
  } else if (parameters.targetResolution || parameters.outputResolution) {
    labels.push(String(parameters.targetResolution || parameters.outputResolution));
  }
  if (parameters.quality) labels.push(parameters.quality);
  if (parameters.durationSeconds !== undefined) labels.push(`${parameters.durationSeconds} 秒`);
  if (parameters.aspectRatio) labels.push(parameters.aspectRatio);
  if (parameters.audio !== undefined) labels.push(parameters.audio ? "含音频" : "无音频");
  return labels;
}

function generationBillingLabel(history: PublicGenerationHistory): string {
  if (history.billing.state === "captured" && history.billing.costMicros !== null) {
    return `实际消耗 ${formatGuMicros(history.billing.costMicros)}`;
  }
  if (history.billing.state === "free") return "免费 · 0 GU";
  if (history.billing.state === "pending") return "成本待结算";
  if (history.billing.state === "released") return "未扣费 · 0 GU";
  return "暂无成本记录";
}

const labelledInternalIdentifierPattern = /(?:user|workspace|project|canvas|thread|session|task|asset(?:[-_ ]?version)?|request|usage|ledger|approval|run|node|provider|channel|route|model|用户|工作区|项目|画布|线程|会话|任务|资产|请求|用量|账本|审批|运行|节点|供应商|渠道|路由|模型)\s*(?:(?:[-_ ]?id)|编号)\s*[:#：=]?\s*[^\s,，;；]{1,300}/i;
const uuidIdentifierPattern = /(?:^|[^a-z0-9])[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:$|[^a-z0-9])/i;
const longNumericIdentifierPattern = /(?:^|\D)\d{8,}(?:$|\D)/;
const structuredOpaqueIdentifierPattern = /(?:^|[^a-z0-9])(?=[a-z0-9:_-]{8,}(?:$|[^a-z0-9:_-]))(?=[a-z0-9:_-]*\d)(?=[a-z0-9:_-]*[:_-])[a-z0-9]+(?:[:_-][a-z0-9]+)+(?:$|[^a-z0-9:_-])/i;
const compactOpaqueIdentifierPattern = /(?:^|[^a-z0-9])(?=[a-z0-9]{12,}(?:$|[^a-z0-9]))(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]+(?:$|[^a-z0-9])/i;

function containsInternalIdentifier(value: string): boolean {
  return labelledInternalIdentifierPattern.test(value)
    || uuidIdentifierPattern.test(value)
    || longNumericIdentifierPattern.test(value)
    || structuredOpaqueIdentifierPattern.test(value)
    || compactOpaqueIdentifierPattern.test(value);
}

function safeDisplayText(
  value: unknown,
  fallback: string,
  maximumLength?: number,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || containsInternalIdentifier(normalized)) return fallback;
  return maximumLength ? normalized.slice(0, maximumLength) : normalized;
}

function safeUploadedFileName(value: unknown, fallback: string): string {
  const normalized = typeof value === "string"
    ? value.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").trim()
    : "";
  const basename = normalized.split(/[\\/]/).pop()?.trim() || "";
  return basename ? basename.slice(0, 255) : fallback;
}

function firstSafeDisplayText(
  values: readonly unknown[],
  fallback: string,
): string {
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized && !containsInternalIdentifier(normalized)) return normalized;
  }
  return fallback;
}

function documentFormat(value: string): string {
  const normalized = value.split(/[?#]/, 1)[0].toLowerCase();
  if (normalized.endsWith(".pdf")) return "PDF";
  if (normalized.endsWith(".txt")) return "TXT";
  if (normalized.endsWith(".md") || normalized.endsWith(".markdown")) return "MD";
  return "文档";
}

function uploadedFileKind(file: Pick<File, "name" | "type">): AssetKind {
  const category = inferMimeCategory(file.type, file.name);
  if (category === "document") return "文档";
  if (category === "video") return "视频";
  if (category === "audio") return "音频";
  return category === "image" ? "图片" : "文档";
}

function uploadedReferenceToAsset(
  uploaded: UploadedReferenceAsset,
  projectId: number,
): Asset {
  return {
    id: uploaded.assetId,
    imageId: uploaded.assetVersionId,
    projectId,
    name: uploaded.name,
    type: uploaded.type,
    filePath: uploaded.filePath,
    src: uploaded.previewUrl,
    state: "已完成",
  };
}

function mapAssetKind(asset: Asset): AssetKind {
  if (asset.type === "document") return "文档";
  if (asset.type === "audio") return "音频";
  if (asset.type === "video") return "视频";
  if (asset.type === "clip") {
    if (asset.src?.match(/\.(pdf|txt|md|markdown)(\?|$)/i)) return "文档";
    return asset.src?.match(/\.(mp4|mov|webm)(\?|$)/i) ? "视频" : "图片";
  }
  return "图片";
}

function toAssetCard(asset: Asset): AssetCard {
  const kind = mapAssetKind(asset);
  const image = asset.src || asset.sonAssets?.find((item) => item.src)?.src || "";
  const usage = assetUsageFromTags(asset.tags, asset.type);
  const group = assetGroupFromTags(asset.tags);
  return {
    id: `api-${asset.id}`,
    numericId: asset.id,
    title: safeDisplayText(asset.name, "未命名资产"),
    description: firstSafeDisplayText(
      [asset.describe, asset.prompt, asset.remark],
      "项目资产",
    ),
    searchText: [asset.name, asset.describe, asset.prompt, asset.remark, usage ? ASSET_USAGE_LABELS[usage] : "", group?.name || ""].filter(Boolean).join(" "),
    image,
    kind,
    allowMediaPreview: Boolean(image) && kind !== "文档",
    allowInlineOpen: Boolean(image),
    tab: "assets",
    date: "当前项目",
    source: "api",
    assetType: asset.type,
    usage,
    group,
  };
}

function formatCloudAssetDate(value: Asset["startTime"]): string {
  if (value === undefined || value === null || value === "") return "时间未知";
  const normalized = typeof value === "string" ? value.trim() : value;
  const numeric = Number(normalized);
  const timestamp = Number.isFinite(numeric)
    ? (numeric > 0 && numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : Date.parse(String(normalized));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "时间未知";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toCloudCard(asset: Asset): AssetCard {
  const kind = mapAssetKind(asset);
  const image = "";
  const fileFormat = kind === "文档"
    ? documentFormat(asset.name || asset.filePath || asset.src || "")
    : undefined;
  return {
    id: `cloud-${asset.id}`,
    numericId: asset.id,
    title: safeUploadedFileName(asset.name, "未命名云端文件"),
    description: ["用户上传", "云存储", fileFormat].filter(Boolean).join(" · "),
    searchText: [asset.name, asset.filePath].filter(Boolean).join(" "),
    image,
    kind,
    allowMediaPreview: kind !== "文档" && Number.isSafeInteger(asset.id),
    allowInlineOpen: Number.isSafeInteger(asset.id),
    tab: "cloud",
    date: formatCloudAssetDate(asset.startTime),
    source: "cloud",
    assetType: asset.type,
    fileFormat,
  };
}

/**
 * `/assets/uploadReference` stores user uploads under this project-scoped
 * prefix. Generated assets share the legacy `o_assets` table, so filtering by
 * media type alone would incorrectly expose generated work as cloud uploads.
 */
export function isUserUploadedCloudAsset(asset: Asset) {
  const filePath = String(asset.filePath || "").replace(/\\/g, "/");
  return /\/assets\/references\/[^/]+$/i.test(filePath);
}

async function listUserUploadedCloudAssets(
  type: (typeof cloudAssetTypes)[number],
  projectId: number | null,
) {
  const uploaded: Asset[] = [];
  const pageSize = 100;
  for (let page = 1; page <= 100; page += 1) {
    const result = await assetsApi.listAssets({
      ...(projectId === null ? {} : { projectId }),
      type,
      page,
      limit: pageSize,
    });
    const current = Array.isArray(result.data) ? result.data : [];
    uploaded.push(...current.filter(isUserUploadedCloudAsset));
    const total = Number(result.total);
    if (current.length < pageSize || (Number.isFinite(total) && page * pageSize >= total)) break;
  }
  return uploaded;
}

function formatLibraryDate(createdAt: number) {
  if (!createdAt) return "生成历史";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "生成历史";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function toLibraryKind(item: CreativeLibraryItem): AssetKind {
  if (item.assetType === "video") return "视频";
  if (item.assetType === "audio") return "音频";
  if (item.mimeType?.includes("text") || item.assetType === "file") return "文档";
  return "图片";
}

function toLibraryCard(item: CreativeLibraryItem): AssetCard {
  const kind = toLibraryKind(item);
  const image = item.url || "";
  const prompt = typeof item.prompt === "string"
    ? item.prompt
    : typeof item.metadata?.prompt === "string"
      ? item.metadata.prompt
      : "";
  return {
    id: `library-${item.id}`,
    libraryId: item.id,
    title: safeDisplayText(prompt, `${kind}生成结果`, 22),
    description: `${kind}生成作品`,
    searchText: [prompt, item.source, item.model].filter(Boolean).join(" "),
    image,
    kind,
    allowMediaPreview: Boolean(image) && kind !== "文档",
    allowInlineOpen: Boolean(image),
    tab: "history",
    date: formatLibraryDate(item.createdAt),
    duration: item.durationMs ? `${Math.max(1, Math.round(item.durationMs / 1000))}s` : undefined,
    source: "library",
    generationCorrelationDigest: item.correlation?.generationDigest,
    projectCorrelationDigest: item.correlation?.projectDigest || undefined,
    taskCorrelationDigest: item.correlation?.taskDigest,
    assetCorrelationDigest: item.correlation?.assetDigest,
    contentSha256: item.contentSha256,
    generationHistory: item.generationHistory,
  };
}

function AssetMediaUnavailable({ kind }: { kind: AssetKind }) {
  const Icon = kind === "音频" ? FileAudio : kind === "文档" ? FileText : Image;
  return (
    <span className="assetFileThumb assetMediaUnavailable">
      <Icon size={34} />
      <small>{kind}预览不可用</small>
    </span>
  );
}

function AssetThumbnailMedia({ card }: { card: AssetCard }) {
  const [unavailable, setUnavailable] = useState(!card.image);

  useEffect(() => {
    setUnavailable(!card.image);
  }, [card.image]);

  if (!card.allowMediaPreview && !card.allowInlineOpen) return <AssetMediaUnavailable kind={card.kind} />;
  if (card.kind === "音频") return <span className="assetFileThumb"><FileAudio size={34} /><small>音频文件</small></span>;
  if (card.kind === "文档") {
    return (
      <span className="assetFileThumb">
        <FileText size={34} />
        <small>{card.fileFormat && card.fileFormat !== "文档" ? `${card.fileFormat} 文档` : "文档文件"}</small>
      </span>
    );
  }
  if (unavailable) return <AssetMediaUnavailable kind={card.kind} />;
  if (card.kind === "视频") {
    return <video src={card.image} muted playsInline preload="metadata" onError={() => setUnavailable(true)} />;
  }
  return <img src={card.image} alt="" onError={() => setUnavailable(true)} />;
}

function AssetPreviewMedia({ card }: { card: AssetCard }) {
  const [unavailable, setUnavailable] = useState(!card.image);
  const [mediaState, setMediaState] = useState<"loading" | "ready" | "playing">("loading");
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    setUnavailable(!card.image);
    setMediaState("loading");
    setCurrentTime(0);
  }, [card.image]);

  if (!card.allowMediaPreview && !card.allowInlineOpen) return <AssetMediaUnavailable kind={card.kind} />;
  if (card.kind === "文档") {
    return (
      <div className="assetPreviewFile">
        <FileText size={34} />
        <strong>{card.fileFormat && card.fileFormat !== "文档" ? `${card.fileFormat} 文档` : "文档文件"}</strong>
        <span>{card.title}</span>
        <small>可打开原文件或下载到本地查看</small>
      </div>
    );
  }
  if (unavailable) return <AssetMediaUnavailable kind={card.kind} />;
  if (card.kind === "视频") {
    return (
      <video
        data-testid="asset-preview-media"
        data-media-state={mediaState}
        data-current-time={currentTime.toFixed(3)}
        src={card.image}
        controls
        playsInline
        onLoadedData={() => setMediaState("ready")}
        onPlay={() => setMediaState("playing")}
        onPause={() => setMediaState("ready")}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onError={() => setUnavailable(true)}
      />
    );
  }
  if (card.kind === "音频") {
    return (
      <audio
        data-testid="asset-preview-media"
        data-media-state={mediaState}
        data-current-time={currentTime.toFixed(3)}
        src={card.image}
        controls
        onLoadedData={() => setMediaState("ready")}
        onPlay={() => setMediaState("playing")}
        onPause={() => setMediaState("ready")}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onError={() => setUnavailable(true)}
      />
    );
  }
  return (
    <img
      data-testid="asset-preview-media"
      data-media-state={mediaState}
      src={card.image}
      alt={card.title}
      onLoad={() => setMediaState("ready")}
      onError={() => setUnavailable(true)}
    />
  );
}

function groupByDate(cards: AssetCard[]) {
  return cards.reduce<Record<string, AssetCard[]>>((groups, card) => {
    groups[card.date] = groups[card.date] || [];
    groups[card.date].push(card);
    return groups;
  }, {});
}

function parsePrimaryTab(value: string | null): PrimaryTab {
  return primaryTabs.some((tab) => tab.id === value) ? (value as PrimaryTab) : "history";
}

function parseCorrelationDigest(value: string | null): string {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function getSourceLabel(source: SourceFilter) {
  const map: Record<SourceFilter, string> = {
    all: "全部来源",
    library: "生成作品库",
    api: "项目资产",
    cloud: "云存储",
    local: "上传中",
  };
  return map[source];
}

export default function AssetListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const theme = useV4Theme();
  const dark = theme.mode === "dark";
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const currentProject = useProjectStore((state) => state.currentProject);
  const scopedProjectId = normalizeProjectId(currentProjectId);
  const { assets, loading, error } = useAssetStore();
  const fetchAssets = useAssetStore((state) => state.fetchAssets);
  const user = useAuthStore(state => state.user);
  const workspace = useAuthStore(state => state.currentWorkspace);
  const canDelete = canDeleteProjects({ user, workspace });
  const deleteAsset = useAssetStore((state) => state.deleteAsset);
  const [libraryItems, setLibraryItems] = useState<CreativeLibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [cloudAssets, setCloudAssets] = useState<Asset[]>([]);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [cloudError, setCloudError] = useState("");
  const [cloudUploading, setCloudUploading] = useState(false);
  const [cloudUploadRequested, setCloudUploadRequested] = useState(false);
  const [activeTab, setActiveTab] = useState<PrimaryTab>(() => parsePrimaryTab(searchParams.get("tab")));
  const correlationFilter = parseCorrelationDigest(searchParams.get("correlation"));
  const [kindFilter, setKindFilter] = useState<AssetKind | "全部">("全部");
  const [projectAssetTypeFilter, setProjectAssetTypeFilter] = useState<ProjectAssetTypeFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [localAssets, setLocalAssets] = useState<AssetCard[]>([]);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [cardObservationDigests, setCardObservationDigests] = useState<Record<string, string>>({});
  const [previewCard, setPreviewCard] = useState<AssetCard | null>(null);
  const [previewFileLoading, setPreviewFileLoading] = useState(false);
  const [previewFileError, setPreviewFileError] = useState("");
  const [classificationDraft, setClassificationDraft] = useState<AssetUsage | null>(null);
  const [classificationSaving, setClassificationSaving] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);
  const [groupError, setGroupError] = useState("");
  const [notice, setNotice] = useState("");
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const localAssetsRef = useRef<AssetCard[]>([]);
  const deletingIdsRef = useRef<Set<string>>(new Set());
  const cloudLoadRequestIdRef = useRef(0);
  const cloudUploadButtonRef = useRef<HTMLLabelElement>(null);
  const cloudUploadInputRef = useRef<HTMLInputElement>(null);
  const localUploadSequenceRef = useRef(0);
  const previewObjectUrlRef = useRef("");
  const previewLoadRequestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (previewObjectUrlRef.current) window.URL.revokeObjectURL(previewObjectUrlRef.current);
    };
  }, []);

  useEffect(() => {
    setActiveTab(parsePrimaryTab(searchParams.get("tab")));
    setSelectedIds([]);
  }, [searchParams]);

  useEffect(() => {
    if (activeTab !== "cloud" || searchParams.get("upload") !== "1") return;
    setCloudUploadRequested(true);
    showNotice("已进入云存储，请点击“上传文件”选择本地文件");
    const frame = window.requestAnimationFrame(() => {
      cloudUploadButtonRef.current?.focus();
      cloudUploadInputRef.current?.click();
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete("upload");
        return next;
      }, { replace: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, searchParams, setSearchParams]);

  useEffect(() => {
    if (currentProjectId) {
      void fetchAssets({ limit: 60 });
    }
  }, [currentProjectId, fetchAssets]);

  const loadCloudAssets = useCallback(async () => {
    const requestId = ++cloudLoadRequestIdRef.current;
    setCloudLoading(true);
    setCloudError("");
    setCloudAssets([]);
    try {
      const results = await Promise.all(
        cloudAssetTypes.map((type) => listUserUploadedCloudAssets(type, scopedProjectId)),
      );
      const uniqueAssets = Array.from(
        new Map(
          results
            .flat()
            .map((asset) => [asset.id, asset]),
        ).values(),
      );
      if (requestId === cloudLoadRequestIdRef.current) setCloudAssets(uniqueAssets);
    } catch (loadError) {
      if (requestId === cloudLoadRequestIdRef.current) {
        setCloudError(loadError instanceof Error ? loadError.message : "云存储文件加载失败");
      }
    } finally {
      if (requestId === cloudLoadRequestIdRef.current) setCloudLoading(false);
    }
  }, [scopedProjectId]);

  useEffect(() => {
    void loadCloudAssets();
    return () => {
      cloudLoadRequestIdRef.current += 1;
    };
  }, [loadCloudAssets]);

  useEffect(() => {
    let cancelled = false;
    async function loadLibrary() {
      setLibraryLoading(true);
      setLibraryError("");
      setLibraryItems([]);
      try {
        const result = await listCompleteCreativeLibrary({
          ...(scopedProjectId === null ? {} : { projectId: scopedProjectId }),
        });
        if (!cancelled) setLibraryItems(result);
      } catch (error) {
        if (!cancelled) setLibraryError(error instanceof Error ? error.message : "生成历史加载失败");
      } finally {
        if (!cancelled) setLibraryLoading(false);
      }
    }
    void loadLibrary();
    return () => {
      cancelled = true;
    };
  }, [scopedProjectId]);

  useEffect(() => {
    localAssetsRef.current = localAssets;
  }, [localAssets]);

  useEffect(() => {
    return () => {
      localAssetsRef.current.forEach((asset) => {
        if (asset.image.startsWith("blob:")) window.URL.revokeObjectURL(asset.image);
      });
    };
  }, []);

  const allCards = useMemo(() => {
    return [...libraryItems.map(toLibraryCard), ...assets.map(toAssetCard), ...cloudAssets.map(toCloudCard), ...localAssets];
  }, [assets, cloudAssets, libraryItems, localAssets]);

  useEffect(() => {
    let active = true;
    const projectDigest = String(currentProject?.correlationDigest || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(projectDigest) || !globalThis.crypto?.subtle) {
      setCardObservationDigests({});
      return () => { active = false; };
    }
    void Promise.all(allCards.map(async (card) => {
      const bytes = new TextEncoder().encode(
        `fanjin-asset-card-observation/v1\0${projectDigest}\0${card.id}`,
      );
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return [card.id, Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")] as const;
    })).then((entries) => {
      if (active) setCardObservationDigests(Object.fromEntries(entries));
    });
    return () => { active = false; };
  }, [allCards, currentProject?.correlationDigest]);

  const activeTabCards = useMemo(() => allCards.filter((card) => (
    card.tab === activeTab
    && (
      activeTab !== "history"
      || !correlationFilter
      || card.generationCorrelationDigest === correlationFilter
    )
  )), [activeTab, allCards, correlationFilter]);

  const kindCounts = useMemo(() => Object.fromEntries(kindTabs.map((kind) => [
    kind,
    kind === "全部"
      ? activeTabCards.length
      : activeTabCards.filter((card) => card.kind === kind).length,
  ])) as Record<AssetKind | "全部", number>, [activeTabCards]);

  const projectAssetTypeCounts = useMemo(() => Object.fromEntries(
    projectAssetTypeFilters.map((filter) => [
      filter.value,
      filter.value === "all"
        ? activeTabCards.length
        : activeTabCards.filter((card) => filter.value === "uncategorized"
          ? !card.usage
          : card.usage === filter.value).length,
    ]),
  ) as Record<ProjectAssetTypeFilter, number>, [activeTabCards]);

  const visibleCards = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return activeTabCards.filter((card) => {
      if (kindFilter !== "全部" && card.kind !== kindFilter) return false;
      if (
        activeTab === "assets"
        && projectAssetTypeFilter !== "all"
        && (projectAssetTypeFilter === "uncategorized"
          ? Boolean(card.usage)
          : card.usage !== projectAssetTypeFilter)
      ) return false;
      if (sourceFilter !== "all" && card.source !== sourceFilter) return false;
      if (!normalizedQuery) return true;
      return `${card.title}${card.description}${card.kind}${card.assetType || ""}${card.usage ? ASSET_USAGE_LABELS[card.usage] : "未分类"}${card.group?.name || ""}${card.searchText || ""}`.toLowerCase().includes(normalizedQuery);
    });
  }, [activeTab, activeTabCards, kindFilter, projectAssetTypeFilter, query, sourceFilter]);

  const groupedCards = useMemo(() => groupByDate(visibleCards), [visibleCards]);
  const availableSources: SourceFilter[] = activeTab === "history"
    ? ["all", "library"]
    : activeTab === "assets"
      ? ["all", "api"]
      : ["all", "cloud", "local"];
  const emptyMessage = activeTab === "cloud"
    ? "还没有上传云存储文件"
    : activeTab === "assets"
      ? "还没有保存可复用资产"
      : "还没有生成记录";
  const activeContentLoading = activeTab === "cloud" ? cloudLoading : activeTab === "assets" ? loading : libraryLoading;
  const activeContentError = activeTab === "cloud"
    ? cloudError
    : activeTab === "assets"
      ? (currentProjectId ? error?.message || "" : "")
      : libraryError;
  const activeContentState = activeContentLoading
    ? "loading"
    : activeContentError
      ? "error"
      : visibleCards.length
        ? "ready"
        : "empty";
  const primaryTabCounts = Object.fromEntries(primaryTabs.map((tab) => [
    tab.id,
    allCards.filter((card) => card.tab === tab.id).length,
  ])) as Record<PrimaryTab, number>;
  const hasActiveFilters = kindFilter !== "全部"
    || projectAssetTypeFilter !== "all"
    || sourceFilter !== "all"
    || Boolean(query.trim())
    || Boolean(correlationFilter);
  const previewDeleting = previewCard ? deletingIds.has(previewCard.id) : false;
  const previewDeleteError = previewCard ? deleteErrors[previewCard.id] : "";
  const selectedGroupCards = useMemo(() => selectedIds.flatMap((id) => {
    const card = allCards.find((item) => item.id === id);
    return card && card.source === "api" && Number.isSafeInteger(card.numericId) && ["role", "scene", "tool"].includes(card.usage || "")
      ? [card]
      : [];
  }), [allCards, selectedIds]);
  const selectedGroupUsage = selectedGroupCards.length && selectedGroupCards.every((card) => card.usage === selectedGroupCards[0].usage)
    ? selectedGroupCards[0].usage as "role" | "scene" | "tool"
    : null;

  function showNotice(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? "" : current)), 2400);
  }

  function clearPreviewObjectUrl() {
    if (!previewObjectUrlRef.current) return;
    window.URL.revokeObjectURL(previewObjectUrlRef.current);
    previewObjectUrlRef.current = "";
  }

  function closePreview() {
    previewLoadRequestIdRef.current += 1;
    clearPreviewObjectUrl();
    setPreviewFileLoading(false);
    setPreviewFileError("");
    setClassificationDraft(null);
    setPreviewCard(null);
  }

  async function openPreview(card: AssetCard) {
    const requestId = ++previewLoadRequestIdRef.current;
    clearPreviewObjectUrl();
    setPreviewFileLoading(false);
    setPreviewFileError("");
    setPreviewCard(card);
    setClassificationDraft(card.usage || null);
    if (card.source !== "cloud" || !card.numericId) return;
    setPreviewFileLoading(true);
    try {
      const file = await assetsApi.getReferenceAssetFile(card.numericId, "inline");
      const objectUrl = window.URL.createObjectURL(file.blob);
      if (previewLoadRequestIdRef.current !== requestId) {
        window.URL.revokeObjectURL(objectUrl);
        return;
      }
      previewObjectUrlRef.current = objectUrl;
      setPreviewCard((current) => current?.id === card.id ? { ...current, image: objectUrl } : current);
    } catch (fileError) {
      if (previewLoadRequestIdRef.current === requestId) {
        setPreviewFileError(fileError instanceof Error ? fileError.message : "云存储文件读取失败");
      }
    } finally {
      if (previewLoadRequestIdRef.current === requestId) setPreviewFileLoading(false);
    }
  }

  async function saveClassification() {
    if (!previewCard?.numericId || previewCard.source !== "api") return;
    const projectId = Number(currentProjectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return;
    setClassificationSaving(true);
    try {
      await assetsApi.updateAssetMetadata({ projectId, id: previewCard.numericId, usage: classificationDraft });
      await fetchAssets({ limit: 60 });
      setPreviewCard((current) => current ? { ...current, usage: classificationDraft } : current);
      showNotice(classificationDraft ? `已归类为${ASSET_USAGE_LABELS[classificationDraft]}` : "已移除资产分类");
    } catch (saveError) {
      showNotice(saveError instanceof Error ? saveError.message : "分类保存失败，请重试");
    } finally {
      setClassificationSaving(false);
    }
  }

  function openGroupDialog() {
    if (selectedGroupCards.length < 2) {
      showNotice("请选择两个或以上的角色、场景或道具资产");
      return;
    }
    if (!selectedGroupUsage) {
      showNotice("同一分组只能包含同一种用途分类");
      return;
    }
    setGroupName("");
    setGroupError("");
    setGroupDialogOpen(true);
  }

  async function submitGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const projectId = Number(currentProjectId);
    const name = groupName.trim();
    if (!selectedGroupUsage || selectedGroupCards.length < 1 || !Number.isSafeInteger(projectId) || projectId <= 0) return;
    if (!name) {
      setGroupError("请填写分组名称");
      return;
    }
    setGroupSaving(true);
    setGroupError("");
    try {
      await assetsApi.createAssetGroup({
        projectId,
        name,
        usage: selectedGroupUsage,
        assetIds: selectedGroupCards.map((card) => card.numericId as number),
      });
      await fetchAssets({ limit: 60 });
      setGroupDialogOpen(false);
      setSelectedIds([]);
      setBatchMode(false);
      showNotice(`已创建${ASSET_USAGE_LABELS[selectedGroupUsage]}分组“${name}”`);
    } catch (saveError) {
      setGroupError(saveError instanceof Error ? saveError.message : "分组创建失败，请重试");
    } finally {
      setGroupSaving(false);
    }
  }

  async function downloadCloudFile(card: AssetCard) {
    if (!card.numericId) return;
    try {
      const file = await assetsApi.getReferenceAssetFile(card.numericId, "attachment");
      const objectUrl = window.URL.createObjectURL(file.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = card.title;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 0);
    } catch (fileError) {
      showNotice(fileError instanceof Error ? fileError.message : "云存储文件下载失败");
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const numericProjectId = Number(currentProjectId);
    if (!Number.isSafeInteger(numericProjectId) || numericProjectId <= 0) {
      showNotice("请先进入或选择一个项目，再上传云存储文件");
      return;
    }

    // Extension fallback may make a file uploadable after server-side MIME
    // normalization, but the original Blob keeps its declared browser MIME.
    // Only a directly allowlisted MIME may be rendered or navigated locally.
    const declaredMimeCategory = inferMimeCategory(file.type, "");
    const kind = uploadedFileKind(file);
    const image = declaredMimeCategory ? window.URL.createObjectURL(file) : "";
    const localUploadId = `${Date.now()}-${++localUploadSequenceRef.current}`;
    const localCard: AssetCard = {
      id: `local-${localUploadId}`,
      title: safeUploadedFileName(file.name, "未命名上传文件"),
      description: "正在上传到云存储",
      searchText: file.name,
      image,
      kind,
      allowMediaPreview: Boolean(image) && declaredMimeCategory !== "document",
      allowInlineOpen: Boolean(image),
      tab: "cloud",
      date: "刚刚",
      source: "local",
      fileFormat: kind === "文档" ? documentFormat(file.name) : undefined,
    };
    setLocalAssets((current) => [localCard, ...current]);
    setCloudUploading(true);

    try {
      const uploaded = await uploadReferenceAttachment(numericProjectId, file);
      const confirmedAsset = uploadedReferenceToAsset(uploaded, numericProjectId);
      setCloudAssets((current) => [
        confirmedAsset,
        ...current.filter((asset) => asset.id !== confirmedAsset.id),
      ]);
      setKindFilter(kind);
      if (image.startsWith("blob:")) window.URL.revokeObjectURL(image);
      setLocalAssets((current) => current.filter((item) => item.id !== localCard.id));
      await loadCloudAssets();
      setCloudAssets((current) => current.some((asset) => asset.id === confirmedAsset.id)
        ? current
        : [confirmedAsset, ...current]);
      showNotice("文件已上传到云存储");
    } catch (uploadError) {
      setLocalAssets((current) => current.map((item) => (
        item.id === localCard.id
          ? {
              ...item,
              description: declaredMimeCategory
                ? "上传失败，仅本地预览"
                : "上传失败，仅本地保留；此文件类型不可预览",
            }
          : item
      )));
      showNotice(uploadError instanceof Error ? uploadError.message : "上传失败，请重试");
    } finally {
      setCloudUploading(false);
    }
  }

  async function removeCard(card: AssetCard) {
    if (!canDelete) return;
    if (deletingIdsRef.current.has(card.id)) return;
    deletingIdsRef.current.add(card.id);
    setDeletingIds((current) => new Set(current).add(card.id));
    setDeleteErrors((current) => {
      const next = { ...current };
      delete next[card.id];
      return next;
    });

    try {
      if ((card.source === "api" || card.source === "cloud") && card.numericId) {
        await deleteAsset(card.numericId);
        if (card.source === "cloud") {
          await loadCloudAssets();
          setCloudAssets((current) => current.filter((asset) => asset.id !== card.numericId));
        }
        if (previewCard?.id === card.id) closePreview();
        setSelectedIds((current) => current.filter((id) => id !== card.id));
        showNotice(card.source === "cloud" ? "云存储文件删除请求已提交" : "资产删除请求已提交");
        return;
      }
      if (card.source === "library" && card.libraryId) {
        const result = await deleteCreativeLibraryItems([card.libraryId]);
        const itemResult = (Array.isArray(result?.results) ? result.results : []).find((item) =>
          String(item?.id || "").toLowerCase() === card.libraryId?.toLowerCase());
        if (!itemResult || itemResult.status !== "accepted") {
          throw new Error(
            itemResult?.status === "rejected" && itemResult.message
              ? itemResult.message
              : "生成作品删除请求未被接受",
          );
        }
        setLibraryItems((current) => current.filter((item) => item.id !== card.libraryId));
        if (previewCard?.id === card.id) closePreview();
        setSelectedIds((current) => current.filter((id) => id !== card.id));
        showNotice("生成作品删除请求已提交");
        return;
      }
      if (card.source === "local" && card.image.startsWith("blob:")) {
        window.URL.revokeObjectURL(card.image);
      }
      setLocalAssets((current) => current.filter((item) => item.id !== card.id));
      if (previewCard?.id === card.id) closePreview();
      setSelectedIds((current) => current.filter((id) => id !== card.id));
      showNotice("本地预览已移除");
    } catch (removeError) {
      const detail = removeError instanceof Error && removeError.message.trim()
        ? removeError.message.trim()
        : "删除请求失败，请稍后重试";
      setDeleteErrors((current) => ({ ...current, [card.id]: detail }));
      showNotice(`删除失败：${detail}`);
    } finally {
      deletingIdsRef.current.delete(card.id);
      setDeletingIds((current) => {
        const next = new Set(current);
        next.delete(card.id);
        return next;
      });
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function switchPrimaryTab(tab: PrimaryTab) {
    setActiveTab(tab);
    setSelectedIds([]);
    setKindFilter("全部");
    setProjectAssetTypeFilter("all");
    setSourceFilter("all");
    setFilterOpen(false);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("tab", tab);
      if (tab !== "history") next.delete("correlation");
      return next;
    });
  }

  function resetFilters() {
    setKindFilter("全部");
    setProjectAssetTypeFilter("all");
    setSourceFilter("all");
    setQuery("");
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("correlation");
      return next;
    }, { replace: true });
  }

  function exportAssetManifest() {
    const cards = selectedIds.length ? allCards.filter((card) => selectedIds.includes(card.id)) : visibleCards;
    if (!cards.length) {
      showNotice("没有可导出的资产");
      return;
    }
    const manifest = cards.map((card) => ({
      id: card.id,
      title: card.title,
      description: card.description,
      kind: card.kind,
      usage: card.usage ? ASSET_USAGE_LABELS[card.usage] : "未分类",
      group: card.group?.name || null,
      source: card.source,
      url: card.image,
      date: card.date,
    }));
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), assets: manifest }, null, 2)], {
      type: "application/json",
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "fanjin-assets-manifest.json";
    link.click();
    window.URL.revokeObjectURL(url);
    showNotice(`已导出 ${cards.length} 个资产`);
  }

  return (
    <main
      className={`assetFrontPage ${dark ? "themeDark" : "themeLight"}`}
      data-testid="asset-library-page"
      data-active-tab={activeTab}
      data-content-state={activeContentState}
      data-visible-count={visibleCards.length}
      data-kind-filter={kindFilter === "全部" ? "all" : kindFilter}
      data-asset-type-filter={projectAssetTypeFilter}
      data-source-filter={sourceFilter}
      data-correlation-filter={correlationFilter || undefined}
    >
      <section className="assetFrontShell">
        <FrontstageNav active="assets" dark={dark} onToggleDark={theme.toggle} onNotice={showNotice} />
        <div className="assetFrontMain">
          <header className="assetFrontTabs">
            <div>
              {primaryTabs.map((tab) => (
                <button
                  key={tab.id}
                  className={activeTab === tab.id ? "active" : ""}
                  type="button"
                  data-testid={`asset-primary-tab-${tab.id}`}
                  data-active={activeTab === tab.id ? "true" : "false"}
                  data-count={primaryTabCounts[tab.id]}
                  aria-pressed={activeTab === tab.id}
                  onClick={() => {
                    switchPrimaryTab(tab.id);
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {activeTab === "cloud" ? (
              <label
                ref={cloudUploadButtonRef}
                className={`assetUploadButton ${cloudUploading ? "uploading" : ""}`}
                tabIndex={-1}
                style={cloudUploadRequested ? { boxShadow: `0 0 0 3px ${theme.accentSoft}` } : undefined}
              >
                {cloudUploading ? <Loader2 className="jimengSpin" size={15} /> : <Upload size={15} />}
                {cloudUploading ? "上传中" : "上传文件"}
                <input
                  ref={cloudUploadInputRef}
                  type="file"
                  aria-label="选择要上传到云存储的文件"
                  accept={REFERENCE_ATTACHMENT_ACCEPT}
                  disabled={cloudUploading}
                  onChange={(event) => {
                    setCloudUploadRequested(false);
                    void handleUpload(event);
                  }}
                />
              </label>
            ) : (
              <span className="assetTabDefinition">
                {activeTab === "assets" ? "生成内容由繁境持续保存" : "查看全部生成结果"}
              </span>
            )}
          </header>

          {activeTab === "assets" ? (
            <section className="assetDefinitionCard" aria-label="资产说明">
              <div className="assetDefinitionIcon"><Image size={20} /></div>
              <div>
                <strong>资产</strong>
                <span>你在创作中生成并保存的角色、场景、道具和素材，可在项目、Agent 和画布中重复使用。</span>
              </div>
            </section>
          ) : null}

          {activeTab === "cloud" ? (
            <section className="cloudStorageSummary" aria-label="云存储概览">
              <div className="cloudStorageIcon"><Cloud size={24} /></div>
              <div className="cloudStorageCopy">
                <div className="cloudStorageTitle">
                  <strong>云存储</strong>
                </div>
                <p>保存你主动上传的图片、视频、音频和 PDF/TXT/MD 文档，不与生成资产混在一起。</p>
              </div>
              <div className="cloudStorageQuota">
                <span>已上传文件</span>
                <strong>{cloudLoading ? "加载中" : cloudError ? "暂不可用" : `${cloudAssets.length} 个`}</strong>
                <small>仅统计已成功保存到云端的文件</small>
              </div>
            </section>
          ) : null}

          <section className="assetFilterBar">
            <div className="assetKindTabs">
              {kindTabs.map((kind) => (
                <button
                  key={kind}
                  className={kindFilter === kind ? "active" : ""}
                  type="button"
                  data-active={kindFilter === kind ? "true" : "false"}
                  data-filter-kind={kind === "全部" ? "all" : kind}
                  data-count={kindCounts[kind]}
                  aria-pressed={kindFilter === kind}
                  onClick={() => setKindFilter(kind)}
                >
                  {kind}
                </button>
              ))}
              {activeTab === "assets" ? projectAssetTypeFilters.map((filter) => (
                <button
                  key={filter.value}
                  data-testid={`asset-type-filter-${filter.value}`}
                  className={projectAssetTypeFilter === filter.value ? "active" : ""}
                  type="button"
                  data-active={projectAssetTypeFilter === filter.value ? "true" : "false"}
                  data-count={projectAssetTypeCounts[filter.value]}
                  aria-pressed={projectAssetTypeFilter === filter.value}
                  onClick={() => setProjectAssetTypeFilter(filter.value)}
                >
                  {filter.label}
                </button>
              )) : null}
              <button className={filterOpen ? "active" : ""} type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((value) => !value)}>
                <Filter size={15} />
                筛选
              </button>
            </div>
            <div className="assetActions">
              <label className="assetSearchBox">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={activeTab === "cloud" ? "搜索云存储" : activeTab === "assets" ? "搜索资产" : "搜索生成历史"}
                />
              </label>
              <button className={batchMode ? "active" : ""} type="button" onClick={() => {
                setBatchMode((value) => !value);
                setSelectedIds([]);
              }}>
                批量操作
              </button>
              {activeTab === "assets" && batchMode ? (
                <button
                  type="button"
                  data-testid="asset-create-group"
                  disabled={selectedGroupCards.length < 2}
                  onClick={openGroupDialog}
                >
                  创建分组{selectedGroupCards.length ? `（${selectedGroupCards.length}）` : ""}
                </button>
              ) : null}
              <button type="button" onClick={exportAssetManifest}>导出清单</button>
            </div>
          </section>

          <div data-testid="asset-filter-result" role="status" aria-live="polite" data-result-count={visibleCards.length} data-result-state={activeContentState} className="assetFilterResult">
            {activeContentLoading
              ? "正在更新筛选结果"
              : correlationFilter
                ? `已定位任务关联资产 ${visibleCards.length} 项`
                : `当前筛选结果 ${visibleCards.length} 项`}
          </div>

          {filterOpen ? (
            <section className="assetFilterPanel" aria-label="资产筛选">
              <span>来源</span>
              {availableSources.map((source) => (
                <button key={source} className={sourceFilter === source ? "active" : ""} type="button" data-active={sourceFilter === source ? "true" : "false"} data-count={source === "all" ? activeTabCards.length : activeTabCards.filter((card) => card.source === source).length} aria-pressed={sourceFilter === source} onClick={() => setSourceFilter(source)}>
                  {getSourceLabel(source)}
                </button>
              ))}
              <button type="button" data-testid="asset-filter-reset" data-reset-available={hasActiveFilters ? "true" : "false"} onClick={resetFilters}>
                重置筛选
              </button>
            </section>
          ) : null}

          {!currentProjectId && activeTab !== "history" ? (
            <div className="assetProjectHint">
              {activeTab === "cloud" ? "可以浏览已有云端文件；上传前请先进入或选择一个项目。" : "当前未选择项目，资产将在选择项目后加载。"}
            </div>
          ) : null}
          {activeContentLoading ? (
            <div className="assetLoading">
              <Loader2 className="jimengSpin" size={18} />
              {activeTab === "cloud" ? "加载云存储文件中" : "加载资产中"}
            </div>
          ) : null}
          {error && currentProjectId && activeTab === "assets" ? <div className="assetProjectHint error">{error.message}</div> : null}
          {libraryError && activeTab === "history" ? <div className="assetProjectHint error">{libraryError}</div> : null}
          {cloudError && activeTab === "cloud" ? <div className="assetProjectHint error">{cloudError}</div> : null}

          <section className="assetDateGroups">
            {Object.entries(groupedCards).map(([date, cards]) => (
              <div className="assetDateGroup" key={date}>
                <h2>{date}</h2>
                <div className="assetGrid">
                  {cards.map((card) => {
                    const selected = selectedIds.includes(card.id);
                    const deleting = deletingIds.has(card.id);
                    const deleteError = deleteErrors[card.id];
                    return (
                      <article
                        key={card.id}
                        data-testid="asset-library-card"
                        data-asset-kind={card.kind}
                        data-asset-source={card.source}
                        data-project-asset-type={card.assetType}
                        data-asset-usage={card.usage || "uncategorized"}
                        data-asset-group={card.group?.name}
                        data-asset-id={card.numericId ?? card.libraryId ?? undefined}
                        data-selected={selected ? "true" : "false"}
                        data-generation-correlation-digest={card.generationCorrelationDigest}
                        data-project-correlation-digest={card.projectCorrelationDigest}
                        data-task-correlation-digest={card.taskCorrelationDigest}
                        data-asset-correlation-digest={card.assetCorrelationDigest}
                        data-content-sha256={card.contentSha256}
                        data-generation-operation={card.generationHistory?.operation}
                        data-parent-version-digest={card.generationHistory?.parentVersionDigest}
                        data-generation-billing-state={card.generationHistory?.billing.state}
                        data-observation-digest={cardObservationDigests[card.id]}
                        className={[
                          selected ? "selected" : "",
                          deleting ? "deleting" : "",
                        ].filter(Boolean).join(" ")}
                        aria-busy={deleting}
                      >
                        <button
                          className="assetThumbButton"
                          type="button"
                          aria-label={!card.allowMediaPreview && !card.allowInlineOpen ? `无法预览 ${card.title}` : undefined}
                          disabled={!batchMode && !card.allowMediaPreview && !card.allowInlineOpen}
                          onClick={() => batchMode ? toggleSelected(card.id) : void openPreview(card)}
                        >
                          <AssetThumbnailMedia card={card} />
                          {card.duration ? <span className="assetDuration">{card.duration}</span> : null}
                          {batchMode ? <span className="assetCheck">{selected ? <Check size={15} /> : null}</span> : null}
                        </button>
                        <div className="assetCardMeta">
                          <strong>{card.title}</strong>
                          <small>{card.description}</small>
                          <div className="assetClassificationBadges" aria-label="资产分类">
                            <span className={`assetUsageBadge ${card.usage ? "" : "unset"}`}>
                              {card.usage ? ASSET_USAGE_LABELS[card.usage] : "未分类"}
                            </span>
                            {card.group ? <span className="assetGroupBadge">分组 · {card.group.name}</span> : null}
                          </div>
                          {card.generationHistory ? (
                            <div className="assetGenerationSummary" aria-label="生成版本摘要">
                              <span className="assetGenerationOperation">
                                {generationOperationLabels[card.generationHistory.operation]}
                              </span>
                              {generationParameterLabels(card.generationHistory).slice(0, 2).map((label) => (
                                <span key={label}>{label}</span>
                              ))}
                              <span className="assetGenerationCost">{generationBillingLabel(card.generationHistory)}</span>
                            </div>
                          ) : null}
                          {deleteError ? <small className="assetDeleteError" role="alert">删除失败：{deleteError}</small> : null}
                        </div>
                        <button
                          className="assetDeleteButton"
                          type="button"
                          aria-label={deleting ? `正在删除 ${card.title}` : `删除 ${card.title}`}
                          aria-busy={deleting}
                          disabled={!canDelete || deleting}
                          onClick={() => void removeCard(card)}
                        >
                          {deleting ? <Loader2 className="jimengSpin" size={14} /> : <Trash2 size={14} />}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </div>
            ))}
            {!visibleCards.length && !activeContentLoading && !activeContentError ? (
              <div className="assetEmpty" data-testid="asset-empty-state" data-empty-reason={query.trim() || correlationFilter ? "filtered" : "source-empty"}>
                {activeTab === "cloud" ? <HardDrive size={32} /> : <Image size={32} />}
                <span>{query.trim() ? "没有匹配的内容" : emptyMessage}</span>
              </div>
            ) : null}
          </section>
        </div>
      </section>
      {previewCard ? (
        <div
          className="assetPreviewOverlay"
          role="dialog"
          aria-modal="true"
          aria-label={`${previewCard.title} 预览`}
          data-generation-correlation-digest={previewCard.generationCorrelationDigest}
          data-project-correlation-digest={previewCard.projectCorrelationDigest}
          data-task-correlation-digest={previewCard.taskCorrelationDigest}
          data-asset-correlation-digest={previewCard.assetCorrelationDigest}
          data-content-sha256={previewCard.contentSha256}
          data-generation-operation={previewCard.generationHistory?.operation}
          data-parent-version-digest={previewCard.generationHistory?.parentVersionDigest}
          data-generation-billing-state={previewCard.generationHistory?.billing.state}
          onClick={closePreview}
        >
          <aside className="assetPreviewPanel" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>{previewCard.kind} · {getSourceLabel(previewCard.source)}</span>
                <h2>{previewCard.title}</h2>
              </div>
              <button type="button" aria-label="关闭预览" onClick={closePreview}>
                <X size={18} />
              </button>
            </header>
            <div className="assetPreviewMedia">
              <AssetPreviewMedia card={previewCard} />
            </div>
            <dl className="assetPreviewMeta">
              <div>
                <dt>说明</dt>
                <dd>{previewCard.description}</dd>
              </div>
              <div>
                <dt>日期</dt>
                <dd>{previewCard.date}</dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>{getSourceLabel(previewCard.source)}</dd>
              </div>
              {previewCard.source === "api" && previewCard.numericId ? (
                <div className="assetClassificationEditor">
                  <dt>用途分类</dt>
                  <dd>
                    <select
                      aria-label="资产用途分类"
                      value={classificationDraft || ""}
                      onChange={(event) => setClassificationDraft((event.target.value || null) as AssetUsage | null)}
                    >
                      <option value="">未分类</option>
                      {Object.entries(ASSET_USAGE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                    <button type="button" disabled={classificationSaving} onClick={() => void saveClassification()}>
                      {classificationSaving ? "保存中" : "保存分类"}
                    </button>
                  </dd>
                </div>
              ) : null}
              {previewCard.group ? (
                <div>
                  <dt>所属分组</dt>
                  <dd>{previewCard.group.name}</dd>
                </div>
              ) : null}
              {previewCard.generationHistory ? (
                <>
                  <div>
                    <dt>版本类型</dt>
                    <dd>{generationOperationLabels[previewCard.generationHistory.operation]}</dd>
                  </div>
                  <div>
                    <dt>版本关系</dt>
                    <dd>{previewCard.generationHistory.derivedFromSource ? "基于已有版本继续创作" : "此作品的原始版本"}</dd>
                  </div>
                  <div>
                    <dt>生成参数</dt>
                    <dd>{generationParameterLabels(previewCard.generationHistory).join(" · ") || "未记录公开参数"}</dd>
                  </div>
                  <div>
                    <dt>GU 成本</dt>
                    <dd>{generationBillingLabel(previewCard.generationHistory)}</dd>
                  </div>
                </>
              ) : null}
              {previewCard.fileFormat ? (
                <div>
                  <dt>文件类型</dt>
                  <dd>{previewCard.fileFormat}</dd>
                </div>
              ) : null}
            </dl>
            {previewDeleteError ? (
              <div className="assetPreviewDeleteError" role="alert">
                删除失败：{previewDeleteError}
              </div>
            ) : null}
            {previewFileError ? (
              <div className="assetPreviewDeleteError" role="alert">
                文件读取失败：{previewFileError}
              </div>
            ) : null}
            <footer>
              {previewCard.allowInlineOpen ? (
                <>
                  {previewCard.image ? (
                    <a href={previewCard.image} target="_blank" rel="noreferrer">
                      <ExternalLink size={15} />
                      打开原文件
                    </a>
                  ) : null}
                  {previewCard.source === "cloud" ? (
                    <button
                      type="button"
                      disabled={previewFileLoading}
                      onClick={() => void downloadCloudFile(previewCard)}
                      data-content-sha256={previewCard.contentSha256}
                    >
                      {previewFileLoading ? <Loader2 className="jimengSpin" size={15} /> : <Download size={15} />}
                      下载
                    </button>
                  ) : previewCard.image ? (
                    <a href={previewCard.image} download={previewCard.title} data-content-sha256={previewCard.contentSha256}>
                      <Download size={15} />
                      下载
                    </a>
                  ) : null}
                </>
              ) : null}
              <button
                type="button"
                aria-busy={previewDeleting}
                disabled={!canDelete || previewDeleting}
                onClick={() => void removeCard(previewCard)}
              >
                {previewDeleting ? <Loader2 className="jimengSpin" size={15} /> : <Trash2 size={15} />}
                {previewDeleting ? "删除中" : "删除"}
              </button>
            </footer>
          </aside>
        </div>
      ) : null}
      {groupDialogOpen ? (
        <div className="assetGroupOverlay" role="dialog" aria-modal="true" aria-label="创建资产分组" onClick={() => !groupSaving && setGroupDialogOpen(false)}>
          <form className="assetGroupDialog" onSubmit={(event) => void submitGroup(event)} onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>资产管理</span>
                <h2>创建资产分组</h2>
              </div>
              <button type="button" aria-label="关闭创建分组" disabled={groupSaving} onClick={() => setGroupDialogOpen(false)}><X size={18} /></button>
            </header>
            <p>把同一{selectedGroupUsage ? ASSET_USAGE_LABELS[selectedGroupUsage] : "用途"}下的不同服装、状态或版本归到一个可复用分组中。</p>
            <label>
              分组名称
              <input aria-label="分组名称" value={groupName} maxLength={80} autoFocus placeholder="例如：女主·宴会服" onChange={(event) => setGroupName(event.target.value)} />
            </label>
            <div className="assetGroupDialogSummary">
              <span>分类</span><strong>{selectedGroupUsage ? ASSET_USAGE_LABELS[selectedGroupUsage] : "—"}</strong>
              <span>资产</span><strong>{selectedGroupCards.length} 个</strong>
            </div>
            {groupError ? <div className="assetPreviewDeleteError" role="alert">{groupError}</div> : null}
            <footer>
              <button type="button" disabled={groupSaving} onClick={() => setGroupDialogOpen(false)}>取消</button>
              <button type="submit" disabled={groupSaving || !groupName.trim()}>{groupSaving ? "创建中" : "创建分组"}</button>
            </footer>
          </form>
        </div>
      ) : null}
      {notice ? <div className="jimengToast">{notice}</div> : null}
    </main>
  );
}
