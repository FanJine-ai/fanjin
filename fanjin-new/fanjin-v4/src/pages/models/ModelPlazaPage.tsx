import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Boxes,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  Grid2X2,
  Image,
  List,
  RefreshCw,
  Search,
  Sparkles,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import PublicSiteHeader from "../../components/PublicSiteHeader";
import type { PricingModel, TokenUnit } from "../../features/pricing/types";
import { getModelPriceDisplay } from "../../features/pricing/lib/price";
import { getPricing } from "../../features/pricing/api";
import { useAuthStore } from "../../stores/authStore";
import { Drawer } from "../../ui/console";
import { useV4Theme } from "../../ui/useV4Theme";
import { resolveModelLogoAsset, resolveVendorLogoAsset } from "./modelLogoAssets";
import "./ModelPlazaPage.css";

const categories = ["all", "llm", "image", "video", "audio", "embedding", "ranking"] as const;
const capabilityFilters = ["all", "reasoning", "vision", "function_calling", "long_context"] as const;
const billingFilters = ["all", "token", "request", "duration"] as const;
const MODEL_PLAZA_VIEW_KEY = "fanjin-model-plaza-view";
const MODEL_PLAZA_REFRESH_INTERVAL_MS = 60_000;

type Category = (typeof categories)[number];
type CapabilityFilter = (typeof capabilityFilters)[number];
type BillingFilter = (typeof billingFilters)[number];
type ViewMode = "grid" | "table";
type SortMode = "featured" | "name" | "input-price" | "context";
type CreationModelType = "llm" | "image" | "video";

const categoryLabels: Record<Category, string> = {
  all: "全部",
  llm: "文本",
  image: "图像",
  video: "视频",
  audio: "语音",
  embedding: "向量",
  ranking: "排序",
};

const capabilityLabels: Record<CapabilityFilter, string> = {
  all: "全部能力",
  reasoning: "推理",
  vision: "视觉",
  function_calling: "工具调用",
  long_context: "长上下文",
};

const billingLabels: Record<BillingFilter, string> = {
  all: "全部方式",
  token: "按量计费",
  request: "按次计费",
  duration: "按时长计费",
};

function categoryLabel(category: string) {
  return categoryLabels[category as Category] || category;
}

function categoryIcon(category: string, size = 17): ReactNode {
  if (category === "image") return <Image size={size} />;
  if (category === "video") return <Video size={size} />;
  if (category === "audio") return <Volume2 size={size} />;
  if (category === "llm") return <Sparkles size={size} />;
  return <Boxes size={size} />;
}

function capabilityLabel(value: string) {
  const labels: Record<string, string> = {
    streaming: "流式输出",
    vision: "视觉理解",
    reasoning: "推理",
    think: "推理",
    function_calling: "工具调用",
    structured_output: "结构化输出",
    long_context: "长上下文",
    chat: "对话",
    image: "图像",
    audio: "音频",
    video: "视频",
  };
  return labels[value.toLowerCase()] || value;
}

function normalize(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function ModelLogo({ model, size = 23 }: { model: PricingModel; size?: number }) {
  const logo = resolveModelLogoAsset(model);
  return logo
    ? <img className="modelPlazaProviderLogo" src={logo.src} width={size} height={size} alt="" title={logo.label} />
    : categoryIcon(model.category, size);
}

function formatContextLength(value?: number | null) {
  if (!value || value <= 0) return "—";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function modelCapabilities(model: PricingModel) {
  const values = new Set<string>();
  (model.capabilities || []).forEach((value) => values.add(normalize(value)));
  (model.modalities || []).forEach((value) => values.add(normalize(value)));
  (model.supported_endpoint_types || []).forEach((value) => values.add(normalize(value)));
  normalize(model.tags).split(/[\s,|/]+/).filter(Boolean).forEach((value) => values.add(value));
  if (model.context_length && model.context_length >= 128_000) values.add("long_context");
  if (["image", "video"].includes(model.category)) values.add("vision");
  if (model.category === "llm") values.add("chat");
  return [...values];
}

function hasCapability(model: PricingModel, filter: CapabilityFilter) {
  if (filter === "all") return true;
  const capabilities = modelCapabilities(model);
  if (filter === "reasoning") return capabilities.some((value) => ["reasoning", "think", "thinking"].includes(value));
  if (filter === "vision") return capabilities.some((value) => ["vision", "image", "multimodal"].includes(value));
  if (filter === "function_calling") return capabilities.some((value) => ["function_calling", "tools", "tool_calling"].includes(value));
  return Boolean(model.context_length && model.context_length >= 128_000);
}

function billingType(model: PricingModel): BillingFilter {
  if (model.unit === "second") return "duration";
  return model.unit === "token" || model.quota_type === 0 ? "token" : "request";
}

function modelKey(model: PricingModel) {
  return `${model.endpoint_type}:${model.model_name}`;
}

function creationModelType(model: PricingModel): CreationModelType | null {
  return model.category === "llm" || model.category === "image" || model.category === "video"
    ? model.category
    : null;
}

function modelCreationPath(model: PricingModel) {
  const modelType = creationModelType(model);
  if (!modelType) return null;
  const params = new URLSearchParams({
    source: "model-plaza",
    model: model.model_name,
    modelType,
  });
  if (
    (modelType === "image" || modelType === "video")
    && model.unit !== "token"
    && model.unit !== "second"
    && model.currency.trim().toUpperCase() === "GU"
    && Number.isSafeInteger(model.unit_price_micros)
    && model.unit_price_micros > 0
  ) {
    params.set("acceptedUnitMaximumCostMicros", String(model.unit_price_micros));
  }
  return `/workbench/create?${params.toString()}`;
}

function modelPriceForSort(model: PricingModel) {
  return model.input_price_micros ?? model.unit_price_micros ?? Number.MAX_SAFE_INTEGER;
}

function timePricingLabel(model: PricingModel) {
  const pricing = model.time_pricing;
  if (!pricing?.enabled) return null;
  const rate = `${Number((pricing.multiplier * 100).toFixed(2))}%`;
  return pricing.current_period_name
    ? `${pricing.current_period_name} · ${rate}`
    : `标准时段 · 100%`;
}

function periodTime(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function periodDays(days: number[]) {
  if (days.length === 7) return "每天";
  const labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return days.map((day) => labels[day]).filter(Boolean).join("、");
}

export default function ModelPlazaPage({ embedded = false }: { embedded?: boolean }) {
  const isAuthenticated = Boolean(useAuthStore((state) => state.token));
  const theme = useV4Theme();
  const location = useLocation();
  useEffect(() => {
    if (embedded || new URLSearchParams(location.search).get("section") !== "pricing") return;
    const frame = requestAnimationFrame(() => {
      const directory = document.getElementById("model-pricing");
      directory?.scrollIntoView({ block: "start" });
      directory?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [embedded, location.search]);
  const pageRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const requestSequenceRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const catalogReadyRef = useRef(false);
  const lastCatalogRefreshRef = useRef(0);
  const [models, setModels] = useState<PricingModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [vendor, setVendor] = useState("all");
  const [capability, setCapability] = useState<CapabilityFilter>("all");
  const [billing, setBilling] = useState<BillingFilter>("all");
  const [tokenUnit, setTokenUnit] = useState<TokenUnit>("M");
  const [sortMode, setSortMode] = useState<SortMode>("featured");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "grid";
    return window.localStorage.getItem(MODEL_PLAZA_VIEW_KEY) === "table" ? "table" : "grid";
  });
  const [requestVersion, setRequestVersion] = useState(0);
  const [copiedModel, setCopiedModel] = useState("");
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const selectedModel = useMemo(
    () => selectedModelKey ? models.find((model) => modelKey(model) === selectedModelKey) ?? null : null,
    [models, selectedModelKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    requestInFlightRef.current = true;
    const isBackgroundRefresh = catalogReadyRef.current;
    if (!isBackgroundRefresh) {
      setLoading(true);
      setError("");
    }
    getPricing({ signal: controller.signal })
      .then((response) => {
        if (requestSequenceRef.current !== requestSequence) return;
        const items = Array.isArray(response?.data) ? response.data as PricingModel[] : [];
        setModels(items.filter((model) => (
          model.status === "active"
          && model.pricing_configured !== false
          && Number.isFinite(model.unit_price_micros)
          && model.unit_price_micros > 0
          && Boolean(model.currency?.trim())
        )));
        catalogReadyRef.current = true;
        lastCatalogRefreshRef.current = Date.now();
        setError("");
      })
      .catch((caught) => {
        if (controller.signal.aborted || requestSequenceRef.current !== requestSequence) return;
        if (!isBackgroundRefresh) {
          setError(caught instanceof Error ? caught.message : "模型价格目录暂时无法读取");
        } else {
          // A detail CTA must never survive a failed price refresh with a stale quote.
          setSelectedModelKey(null);
        }
      })
      .finally(() => {
        if (controller.signal.aborted || requestSequenceRef.current !== requestSequence) return;
        requestInFlightRef.current = false;
        setLoading(false);
      });
    return () => controller.abort();
  }, [isAuthenticated, requestVersion]);

  useEffect(() => {
    // Authentication can change the workspace-specific catalog and price audience.
    setSelectedModelKey(null);
  }, [isAuthenticated]);

  useEffect(() => {
    if (selectedModelKey && catalogReadyRef.current && !selectedModel) {
      setSelectedModelKey(null);
    }
  }, [selectedModel, selectedModelKey]);

  useEffect(() => {
    const refreshVisibleCatalog = () => {
      if (document.visibilityState !== "visible" || requestInFlightRef.current) return;
      setRequestVersion((version) => version + 1);
    };
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "visible"
        && Date.now() - lastCatalogRefreshRef.current >= MODEL_PLAZA_REFRESH_INTERVAL_MS
      ) {
        refreshVisibleCatalog();
      }
    };
    const timer = window.setInterval(refreshVisibleCatalog, MODEL_PLAZA_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(MODEL_PLAZA_VIEW_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    models.forEach((model) => counts.set(model.category, (counts.get(model.category) || 0) + 1));
    return counts;
  }, [models]);

  const vendorOptions = useMemo(() => {
    const counts = new Map<string, number>();
    models.forEach((model) => {
      const name = model.vendor_name?.trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [models]);

  const capabilityCounts = useMemo(() => {
    const counts = new Map<CapabilityFilter, number>();
    capabilityFilters.forEach((item) => counts.set(item, item === "all" ? models.length : models.filter((model) => hasCapability(model, item)).length));
    return counts;
  }, [models]);

  const billingCounts = useMemo(() => ({
    all: models.length,
    token: models.filter((model) => billingType(model) === "token").length,
    request: models.filter((model) => billingType(model) === "request").length,
    duration: models.filter((model) => billingType(model) === "duration").length,
  }), [models]);

  const filteredModels = useMemo(() => {
    const normalizedQuery = normalize(query);
    const filtered = models.filter((model) => {
      if (category !== "all" && model.category !== category) return false;
      if (vendor !== "all" && model.vendor_name !== vendor) return false;
      if (!hasCapability(model, capability)) return false;
      if (billing !== "all" && billingType(model) !== billing) return false;
      if (!normalizedQuery) return true;
      return [model.name, model.model_name, model.vendor_name, model.category, model.description, ...modelCapabilities(model)]
        .some((value) => normalize(value).includes(normalizedQuery));
    });
    return [...filtered].sort((a, b) => {
      if (sortMode === "name") return a.name.localeCompare(b.name, "zh-CN");
      if (sortMode === "input-price") return modelPriceForSort(a) - modelPriceForSort(b);
      if (sortMode === "context") return (b.context_length || 0) - (a.context_length || 0);
      return models.indexOf(a) - models.indexOf(b);
    });
  }, [billing, capability, category, models, query, sortMode, vendor]);

  const activeFilterCount = [category !== "all", vendor !== "all", capability !== "all", billing !== "all"].filter(Boolean).length;
  const entryPath = isAuthenticated ? "/workbench/create" : "/auth/login";

  const resetFilters = () => {
    setQuery("");
    setCategory("all");
    setVendor("all");
    setCapability("all");
    setBilling("all");
  };

  const copyModelName = async (modelName: string) => {
    try {
      await navigator.clipboard.writeText(modelName);
      setCopiedModel(modelName);
      window.setTimeout(() => setCopiedModel((current) => current === modelName ? "" : current), 1400);
    } catch {
      setCopiedModel("");
    }
  };

  const renderFilterButton = (
    label: string,
    count: number,
    active: boolean,
    onClick: () => void,
    icon?: ReactNode,
    disabled = false,
  ) => (
    <button key={label} type="button" className={active ? "active" : ""} aria-pressed={active} onClick={onClick} disabled={disabled}>
      <span className="modelPlazaFilterLabel">{icon}<span>{label}</span></span>
      <b>{loading ? "" : count}</b>
    </button>
  );

  return (
    <main ref={pageRef} className={`modelPlaza ${embedded ? "embedded" : ""} ${theme.mode === "dark" ? "themeDark" : "themeLight"}`} data-theme={theme.mode}>
      {!embedded ? <PublicSiteHeader /> : null}

      <section className="modelPlazaHero" aria-labelledby="model-plaza-title">
        <div className="modelPlazaHeroTitle">
          <div>
            <h1 id="model-plaza-title">模型广场</h1>
            <p>比较模型能力、价格与上下文，选择最适合你场景的模型。</p>
          </div>
          <span className="modelPlazaCountBadge">已接入 {loading ? "—" : models.length} 个模型</span>
        </div>
        <label className="modelPlazaSearch">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">搜索模型</span>
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型名称、厂商、能力或标签…" autoComplete="off" />
          {query ? <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={16} /></button> : <kbd>⌘ K</kbd>}
        </label>
      </section>

      <section id="model-pricing" tabIndex={-1} className="modelPlazaDirectory" aria-label="模型价格目录">
        <aside className="modelPlazaFilterRail" aria-label="模型筛选器">
          <FilterSection title="模型分组">
            {categories.map((item) => renderFilterButton(categoryLabels[item], item === "all" ? models.length : (categoryCounts.get(item) || 0), category === item, () => setCategory(item), categoryIcon(item), item !== "all" && !categoryCounts.get(item)))}
          </FilterSection>
          <FilterSection title="厂商">
            {renderFilterButton("全部", models.length, vendor === "all", () => setVendor("all"), <Boxes size={16} />)}
            {vendorOptions.slice(0, 8).map(([name, count]) => {
              const logo = resolveVendorLogoAsset(name);
              return <div key={name}>{renderFilterButton(name, count, vendor === name, () => setVendor(name), logo ? <img className="modelPlazaFilterLogo" src={logo.src} alt="" title={logo.label} /> : <Sparkles size={16} />)}</div>;
            })}
          </FilterSection>
          <FilterSection title="能力">
            {capabilityFilters.map((item) => renderFilterButton(
              capabilityLabels[item],
              capabilityCounts.get(item) || 0,
              capability === item,
              () => setCapability(item),
              item === "reasoning" ? <BrainCircuit size={16} /> : item === "vision" ? <Image size={16} /> : item === "function_calling" ? <Sparkles size={16} /> : item === "long_context" ? <Boxes size={16} /> : <Check size={16} />,
              item !== "all" && !capabilityCounts.get(item),
            ))}
          </FilterSection>
          <FilterSection title="计费方式">
            {billingFilters.map((item) => renderFilterButton(billingLabels[item], billingCounts[item], billing === item, () => setBilling(item), <CircleDollarSign size={16} />, item !== "all" && !billingCounts[item]))}
          </FilterSection>
          {activeFilterCount ? <button className="modelPlazaClearRail" type="button" onClick={resetFilters}>清除筛选 <span>{activeFilterCount}</span></button> : null}
        </aside>

        <div className="modelPlazaResults">
          <div className="modelPlazaToolbar">
            <div className="modelPlazaResultCount">
              <strong>{loading ? "正在同步" : `${filteredModels.length} 个模型`}</strong>
              {activeFilterCount ? <span>已选择 {activeFilterCount} 个筛选条件</span> : <span>价格来自实时服务目录</span>}
            </div>
            <div className="modelPlazaToolbarControls">
              <label><span className="sr-only">排序方式</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}><option value="featured">综合排序</option><option value="name">名称排序</option><option value="input-price">输入价格最低</option><option value="context">上下文最长</option></select></label>
              <label><span className="sr-only">Token 价格单位</span><select value={tokenUnit} onChange={(event) => setTokenUnit(event.target.value as TokenUnit)}><option value="M">1M Tokens</option><option value="K">1K Tokens</option></select></label>
              <div className="modelPlazaViewSwitch" role="group" aria-label="目录视图">
                <button type="button" className={viewMode === "grid" ? "active" : ""} aria-label="卡片视图" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><Grid2X2 size={17} /></button>
                <button type="button" className={viewMode === "table" ? "active" : ""} aria-label="表格视图" aria-pressed={viewMode === "table"} onClick={() => setViewMode("table")}><List size={18} /></button>
              </div>
              {activeFilterCount || query ? <button className="modelPlazaClearToolbar" type="button" onClick={resetFilters}>清除筛选</button> : null}
            </div>
          </div>

          {loading ? (
            <div className="modelPlazaSkeletons" role="status" aria-label="正在读取可用模型与价格">{Array.from({ length: 6 }, (_, index) => <div className="modelPlazaSkeleton" key={index} />)}</div>
          ) : error ? (
            <div className="modelPlazaState error" role="alert"><RefreshCw size={24} aria-hidden="true" /><strong>模型目录没有加载成功</strong><p>{error}</p><button type="button" onClick={() => { setLoading(true); setRequestVersion((version) => version + 1); }}>重新加载</button></div>
          ) : filteredModels.length ? (
            viewMode === "grid" ? (
              <div className="modelPlazaGrid">{filteredModels.map((model) => <ModelCard key={modelKey(model)} model={model} tokenUnit={tokenUnit} copied={copiedModel === model.model_name} onCopy={() => void copyModelName(model.model_name)} onOpen={() => setSelectedModelKey(modelKey(model))} />)}</div>
            ) : (
              <ModelTable models={filteredModels} tokenUnit={tokenUnit} copiedModel={copiedModel} onCopy={copyModelName} onOpen={(model) => setSelectedModelKey(modelKey(model))} />
            )
          ) : (
            <div className="modelPlazaState"><Search size={24} aria-hidden="true" /><strong>没有找到匹配的模型</strong><p>换一个关键词，或清除当前筛选条件。</p><button type="button" onClick={resetFilters}>清除筛选</button></div>
          )}
        </div>
      </section>

      {!embedded ? <footer className="modelPlazaFooter"><span>价格由当前服务端规则实时提供，最终以任务账单为准。</span><Link to={entryPath}>开始创作 <ArrowRight size={15} /></Link></footer> : null}
      {selectedModel ? <ModelDetails model={selectedModel} tokenUnit={tokenUnit} onClose={() => setSelectedModelKey(null)} onCopy={() => void copyModelName(selectedModel.model_name)} copied={copiedModel === selectedModel.model_name} isAuthenticated={isAuthenticated} portalContainer={pageRef.current} /> : null}
    </main>
  );
}

function FilterSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="modelPlazaFilterSection"><h2>{title}</h2><div>{children}</div></section>;
}

function ModelCard({ model, tokenUnit, copied, onCopy, onOpen }: { model: PricingModel; tokenUnit: TokenUnit; copied: boolean; onCopy: () => void; onOpen: () => void }) {
  const pricing = getModelPriceDisplay(model, tokenUnit);
  const tags = modelCapabilities(model).slice(0, 4);
  const scheduleLabel = timePricingLabel(model);
  return (
    <article className="modelPlazaCard">
      <div className="modelPlazaCardTop"><div className="modelPlazaModelIcon" aria-hidden="true"><ModelLogo model={model} /></div><div className="modelPlazaIdentity"><h3>{model.name}</h3><code>{model.model_name}</code></div><button className="modelPlazaCopy" type="button" aria-label={`复制 ${model.model_name}`} title={copied ? "已复制" : "复制模型 ID"} onClick={onCopy}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></div>
      <p className="modelPlazaDescription">{model.description || `${model.vendor_name || "繁境"} 提供的 ${categoryLabel(model.category)}模型，支持稳定的 API 调用。`}</p>
      <dl className="modelPlazaPricing"><div><dt>{pricing.mediaInputPrice !== undefined ? "文本输入" : model.unit === "token" ? "输入" : model.unit === "second" ? "每秒" : "单次"}</dt><dd>{pricing.inputPrice}<small>{pricing.unit ? ` / ${pricing.unit}` : ""}</small></dd></div>{model.unit === "token" ? <div><dt>{pricing.mediaInputPrice !== undefined ? "图片/视频输入" : "输出"}</dt><dd>{pricing.mediaInputPrice ?? pricing.outputPrice}<small>{pricing.unit ? ` / ${pricing.unit}` : ""}</small></dd></div> : null}</dl>
      {scheduleLabel ? <div className={`modelPlazaTimePrice${model.time_pricing?.current_period_id ? " is-active" : ""}`}><Clock3 size={13} /><span>{scheduleLabel}</span><small>{model.time_pricing?.timezone}</small></div> : null}
      <div className="modelPlazaCardMeta"><span>上下文 <strong>{formatContextLength(model.context_length)} tokens</strong></span><b>{billingLabels[billingType(model)]}</b></div>
      <div className="modelPlazaCapabilities" aria-label={`${model.name} 能力`}>{(tags.length ? tags : [model.category]).map((tag) => <span key={tag}>{capabilityLabel(tag)}</span>)}</div>
      <button className="modelPlazaDetailsButton" type="button" onClick={onOpen}>查看详情 <ChevronRight size={15} /></button>
    </article>
  );
}

function ModelTable({ models, tokenUnit, copiedModel, onCopy, onOpen }: { models: PricingModel[]; tokenUnit: TokenUnit; copiedModel: string; onCopy: (modelName: string) => Promise<void>; onOpen: (model: PricingModel) => void }) {
  return (
    <div className="modelPlazaTableWrap"><table className="modelPlazaTable">
      <thead><tr><th>模型</th><th>厂商</th><th>输入价格</th><th>输出 / 媒体输入价格</th><th>上下文</th><th>能力</th><th><span className="sr-only">操作</span></th></tr></thead>
      <tbody>{models.map((model) => {
        const pricing = getModelPriceDisplay(model, tokenUnit);
        const scheduleLabel = timePricingLabel(model);
        return <tr key={modelKey(model)}><td><div className="modelPlazaTableModel"><span><ModelLogo model={model} size={19} /></span><div><strong>{model.name}</strong><code>{model.model_name}</code>{scheduleLabel ? <small className="modelPlazaTableTime"><Clock3 size={11} />{scheduleLabel}</small> : null}</div></div></td><td>{model.vendor_name || "—"}</td><td>{pricing.mediaInputPrice !== undefined ? <small>文本输入 </small> : null}{pricing.inputPrice}<small>{pricing.unit ? ` / ${pricing.unit}` : ""}</small></td><td>{pricing.mediaInputPrice !== undefined ? <small>图片/视频输入 </small> : null}{model.unit === "token" ? pricing.mediaInputPrice ?? pricing.outputPrice : "—"}<small>{model.unit === "token" && pricing.unit ? ` / ${pricing.unit}` : ""}</small></td><td>{formatContextLength(model.context_length)}</td><td><div className="modelPlazaTableTags">{modelCapabilities(model).slice(0, 2).map((tag) => <span key={tag}>{capabilityLabel(tag)}</span>)}</div></td><td><div className="modelPlazaTableActions"><button type="button" aria-label={`复制 ${model.model_name}`} onClick={() => void onCopy(model.model_name)}>{copiedModel === model.model_name ? <Check size={15} /> : <Copy size={15} />}</button><button type="button" aria-label={`查看 ${model.name} 详情`} onClick={() => onOpen(model)}><ChevronRight size={16} /></button></div></td></tr>;
      })}</tbody>
    </table></div>
  );
}

function ModelDetails({ model, tokenUnit, onClose, onCopy, copied, isAuthenticated, portalContainer }: { model: PricingModel; tokenUnit: TokenUnit; onClose: () => void; onCopy: () => void; copied: boolean; isAuthenticated: boolean; portalContainer: Element | null }) {
  const pricing = getModelPriceDisplay(model, tokenUnit);
  const capabilities = modelCapabilities(model);
  const creationPath = modelCreationPath(model);
  const entryPath = creationPath
    ? isAuthenticated
      ? creationPath
      : `/auth/login?redirect=${encodeURIComponent(creationPath)}`
    : null;
  return (
    <Drawer
      open
      className="modelPlazaDrawerOverlay"
      title={<span className="modelPlazaDrawerTitle"><span className="modelPlazaModelIcon" aria-hidden="true"><ModelLogo model={model} size={27} /></span><strong>{model.name}</strong></span>}
      description={model.vendor_name || categoryLabel(model.category)}
      closeLabel="关闭模型详情"
      size="min(440px, 100vw)"
      portalContainer={portalContainer}
      contentClassName="modelPlazaDrawerContent"
      onOpenChange={(open) => { if (!open) onClose(); }}
      footer={entryPath
        ? <Link className="modelPlazaDrawerCta" to={entryPath}>使用这个模型 <ArrowRight size={16} /></Link>
        : <span className="modelPlazaDrawerUnavailable" role="status">当前创作台尚不支持此类模型</span>}
    >
      <div className="modelPlazaDrawerBody">
        <button className="modelPlazaDrawerId" type="button" onClick={onCopy}><code>{model.model_name}</code>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
        <p>{model.description || "该模型已接入繁境统一 API，可在创作台与开发接口中使用。"}</p>
        <section><h3>价格</h3><dl className="modelPlazaDrawerPricing"><div><dt>{pricing.mediaInputPrice !== undefined ? "文本输入" : model.unit === "token" ? "输入" : model.unit === "second" ? "每秒" : "单次"}</dt><dd>{pricing.inputPrice}<small>{pricing.unit ? ` / ${pricing.unit}` : ""}</small></dd></div>{model.unit === "token" ? <div><dt>{pricing.mediaInputPrice !== undefined ? "图片/视频输入" : "输出"}</dt><dd>{pricing.mediaInputPrice ?? pricing.outputPrice}<small>{pricing.unit ? ` / ${pricing.unit}` : ""}</small></dd></div> : null}</dl>{model.unit === "second" && model.category === "video" ? <p>按输出视频时长计费</p> : null}</section>
        {model.time_pricing?.enabled ? <section><h3>分时计费 · {model.time_pricing.timezone}</h3><div className="modelPlazaDrawerSchedule">{model.time_pricing.periods.map((period) => <div key={period.id}><span><Clock3 size={13} />{period.name}</span><strong>{periodTime(period.startMinute)}–{periodTime(period.endMinute)}</strong><small>{periodDays(period.daysOfWeek)} · {Number((period.multiplierBps / 100).toFixed(2))}%</small></div>)}</div></section> : null}
        <section><h3>模型规格</h3><dl className="modelPlazaSpecs"><div><dt>模型类型</dt><dd>{categoryLabel(model.category)}</dd></div><div><dt>上下文窗口</dt><dd>{formatContextLength(model.context_length)} tokens</dd></div><div><dt>计费方式</dt><dd>{billingLabels[billingType(model)]}</dd></div><div><dt>接口类型</dt><dd>{model.endpoint_type || model.api_style || "—"}</dd></div></dl></section>
        <section><h3>能力</h3><div className="modelPlazaDrawerTags">{(capabilities.length ? capabilities : [model.category]).map((tag) => <span key={tag}>{capabilityLabel(tag)}</span>)}</div></section>
      </div>
    </Drawer>
  );
}
