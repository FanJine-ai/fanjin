import { isValueVideoModel, valueVideoPair } from "./valueVideo";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Clapperboard, Pencil, Plus, RefreshCcw, Route, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  ConsolePage,
  DataTable,
  EmptyState,
  NumberInput,
  Section,
  Skeleton,
  Switch,
  type DataTableColumn,
} from "../../../ui/console";
import {
  createRecipe,
  deleteRecipe,
  getEnhanceOverview,
  listOffers,
  listRecipes,
  listVideoChannels,
  saveOffer,
  updateRecipe,
} from "./api";
import { RecipeDrawer } from "./RecipeDrawer";
import { EnhanceSection } from "./EnhanceSection";
import type {
  EnhanceOverview,
  RecipeForm,
  VideoChannelOption,
  VideoOffer,
  VideoRecipe,
} from "./types";
import { PUBLIC_VIDEO_RESOLUTIONS } from "./types";
import {
  emptyRecipeForm,
  recipeFormFromRecipe,
  recipePayloadFromForm,
  resLabel,
  resolutionLightTone,
  validateRecipeForm,
} from "./utils";
import "./videoFulfillment.css";

const LIGHT_LABEL: Record<string, string> = { ok: "有启用配方", warn: "全部停用", off: "无配方" };

function normalizeEnhanceOverview(payload: unknown): EnhanceOverview {
  if (!payload || typeof payload !== "object") {
    throw new Error("画质增强配置返回格式无效");
  }
  const overview = payload as Partial<EnhanceOverview>;
  if (!Array.isArray(overview.matrix) || !Array.isArray(overview.upscaleChannels)) {
    throw new Error("画质增强配置返回格式无效");
  }
  return {
    matrix: overview.matrix,
    pricingRules: Array.isArray(overview.pricingRules) ? overview.pricingRules : [],
    upscaleChannels: overview.upscaleChannels.map((channel) => ({
      ...channel,
      modelNames: Array.isArray(channel.modelNames) ? channel.modelNames : [],
    })),
  };
}

type VideoFulfillmentPageProps = {
  mode?: "all" | "recipes" | "enhancement";
  title?: string;
  description?: string;
  sectionNavigation?: ReactNode;
  onViewRoutes?: (model?: string) => void;
};

export default function VideoFulfillmentPage({
  mode = "all",
  title = "视频能力兑现",
  description = "配置用户可见的模型名与 720/1080/2K/4K 配方。480 仅可作内部起分;创作台画质增强单独计费;中转站不提供增强。",
  sectionNavigation,
  onViewRoutes,
}: VideoFulfillmentPageProps = {}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedModel = searchParams.get("model") || "";
  const requestedResolution = PUBLIC_VIDEO_RESOLUTIONS.includes(searchParams.get("resolution") as (typeof PUBLIC_VIDEO_RESOLUTIONS)[number])
    ? String(searchParams.get("resolution"))
    : "720p";
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [offers, setOffers] = useState<VideoOffer[]>([]);
  const [activeModel, setActiveModel] = useState("");
  const [activeRes, setActiveRes] = useState<string>(requestedResolution);
  const [recipes, setRecipes] = useState<VideoRecipe[]>([]);
  const [recipesLoading, setRecipesLoading] = useState(false);
  const [channels, setChannels] = useState<VideoChannelOption[]>([]);
  const [overview, setOverview] = useState<EnhanceOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState("");

  // 配方抽屉
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState<RecipeForm>(emptyRecipeForm());
  const [initialForm, setInitialForm] = useState<RecipeForm>(emptyRecipeForm());
  const [savingRecipe, setSavingRecipe] = useState(false);
  const [recipeError, setRecipeError] = useState("");
  const [recipeWarnings, setRecipeWarnings] = useState<string[]>([]);

  // 行内编辑 / 删除确认
  const [inlineSavingId, setInlineSavingId] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");

  const publicResolutions = isValueVideoModel(activeModel) ? (["720p", "1080p"] as const) : PUBLIC_VIDEO_RESOLUTIONS;
  const activeOffer = useMemo(
    () => offers.find((offer) => offer.publicModel === activeModel) || null,
    [offers, activeModel],
  );
  const generateChannels = useMemo(
    () => channels.filter((channel) => channel.endpointType === "video_generation"),
    [channels],
  );
  const upscaleChannels = useMemo(
    () => channels.filter((channel) => channel.endpointType === "video_upscale"),
    [channels],
  );

  const loadOffers = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      const data = await listOffers();
      const list = Array.isArray(data?.offers) ? data.offers : [];
      setOffers(list);
    } catch (err: any) {
      setErrorMessage(err?.message || "加载公开模型失败");
      setOffers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRecipes = useCallback(async () => {
    if (!activeModel || !activeRes) {
      setRecipes([]);
      return;
    }
    setRecipesLoading(true);
    try {
      const data = await listRecipes(activeModel, activeRes);
      setRecipes(Array.isArray(data?.recipes) ? data.recipes : []);
    } catch (err: any) {
      setErrorMessage(err?.message || "加载配方失败");
      setRecipes([]);
    } finally {
      setRecipesLoading(false);
    }
  }, [activeModel, activeRes]);

  const loadChannels = useCallback(async () => {
    try {
      const data = await listVideoChannels();
      setChannels(Array.isArray(data?.channels) ? data.channels : []);
    } catch {
      setChannels([]);
    }
  }, []);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setOverviewError("");
    try {
      setOverview(normalizeEnhanceOverview(await getEnhanceOverview()));
    } catch (err: any) {
      setOverviewError(err?.message || "画质增强配置读取失败");
      setOverview(null);
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode !== "enhancement") void loadOffers();
  }, [loadOffers, mode]);
  useEffect(() => {
    if (mode !== "enhancement") void loadRecipes();
  }, [loadRecipes, mode]);
  useEffect(() => {
    if (mode !== "enhancement") void loadChannels();
  }, [loadChannels, mode]);
  useEffect(() => {
    if (mode !== "recipes") void loadOverview();
  }, [loadOverview, mode]);
  useEffect(() => {
    if (!offers.length) {
      setActiveModel("");
      return;
    }
    setActiveModel((current) => (
      requestedModel && offers.some((offer) => offer.publicModel === requestedModel)
        ? requestedModel
        : current && offers.some((offer) => offer.publicModel === current)
          ? current
          : offers[0]?.publicModel || ""
    ));
  }, [offers, requestedModel]);
  useEffect(() => {
    setActiveRes(isValueVideoModel(activeModel) && !valueVideoPair(activeModel, requestedResolution) ? "720p" : requestedResolution);
  }, [requestedResolution, activeModel]);

  const reloadAfterWrite = useCallback(async () => {
    await Promise.all([loadOffers(), loadRecipes()]);
  }, [loadOffers, loadRecipes]);

  const toggleOfferEnabled = async (offer: VideoOffer, enabled: boolean) => {
    setErrorMessage("");
    try {
      await saveOffer({ publicModel: offer.publicModel, enabled });
      await loadOffers();
    } catch (err: any) {
      setErrorMessage(err?.message || "状态保存失败");
    }
  };

  const selectModel = (model: string) => {
    setActiveModel(model);
    const next = new URLSearchParams(searchParams);
    next.set("model", model);
    next.set("resolution", activeRes);
    setSearchParams(next, { replace: true });
  };

  const selectResolution = (resolution: string) => {
    setActiveRes(resolution);
    const next = new URLSearchParams(searchParams);
    if (activeModel) next.set("model", activeModel);
    next.set("resolution", resolution);
    setSearchParams(next, { replace: true });
  };

  const viewRouteRules = (model?: string) => {
    if (onViewRoutes) {
      onViewRoutes(model);
      return;
    }
    const query = new URLSearchParams();
    if (model) {
      query.set("q", model);
      query.set("capability", "video_generation");
    }
    navigate(`/fjadmin/model-management${query.size ? `?${query.toString()}` : ""}`);
  };

  // ---------- 配方抽屉 ----------
  const openCreateDrawer = () => {
    if (!activeModel) return;
    const pair = valueVideoPair(activeModel, activeRes);
    const next = { ...emptyRecipeForm(), generateResolution: pair?.source || activeRes, enhanceEnabled: Boolean(pair) };
    setForm(next);
    setInitialForm(next);
    setRecipeError("");
    setRecipeWarnings([]);
    setDrawerOpen(true);
  };
  const openEditDrawer = (recipe: VideoRecipe) => {
    const next = recipeFormFromRecipe(recipe);
    setForm(next);
    setInitialForm(next);
    setRecipeError("");
    setRecipeWarnings([]);
    setDrawerOpen(true);
  };
  const saveRecipe = async () => {
    const errors = validateRecipeForm(form, activeRes, activeModel);
    if (Object.keys(errors).length > 0) {
      setRecipeError(Object.values(errors)[0] || "表单校验未通过");
      return;
    }
    setSavingRecipe(true);
    setRecipeError("");
    setRecipeWarnings([]);
    try {
      const payload = recipePayloadFromForm(form);
      const result = form.id
        ? await updateRecipe(form.id, payload)
        : await createRecipe({ ...payload, publicModel: activeModel, targetResolution: activeRes });
      setRecipeWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
      if (!result?.warnings?.length) {
        setDrawerOpen(false);
      }
      setNotice(form.id ? "配方已更新" : "配方已创建");
      await reloadAfterWrite();
    } catch (err: any) {
      setRecipeError(err?.message || "保存失败");
    } finally {
      setSavingRecipe(false);
    }
  };

  // ---------- 行内编辑(权重/次序/启用) ----------
  const inlineUpdate = async (recipe: VideoRecipe, patch: Record<string, unknown>) => {
    setInlineSavingId(recipe.id);
    setErrorMessage("");
    try {
      await updateRecipe(recipe.id, patch);
      await reloadAfterWrite();
    } catch (err: any) {
      setErrorMessage(err?.message || "保存失败");
    } finally {
      setInlineSavingId("");
    }
  };
  const removeRecipe = async (recipe: VideoRecipe) => {
    setInlineSavingId(recipe.id);
    setErrorMessage("");
    try {
      await deleteRecipe(recipe.id);
      setConfirmDeleteId("");
      setNotice("配方已删除");
      await reloadAfterWrite();
    } catch (err: any) {
      setErrorMessage(err?.message || "删除失败");
    } finally {
      setInlineSavingId("");
    }
  };

  // ---------- 配方表 ----------
  const columns = useMemo<DataTableColumn<VideoRecipe>[]>(() => [
    {
      id: "name",
      header: "配方",
      priority: "primary",
      minWidth: "160px",
      cell: (row) => (
        <div className="vfRecipeNameCell">
          <strong>{row.name || row.id.slice(0, 8)}</strong>
          {row.upstreamModel ? <span>上游 {row.upstreamModel}</span> : null}
          {row.warnings.length > 0 ? (
            <span className="vfRowWarning" role="note">{row.warnings.join(";")}</span>
          ) : null}
        </div>
      ),
    },
    {
      id: "generate",
      header: "生成通道",
      priority: "primary",
      minWidth: "150px",
      cell: (row) => (
        <div className="vfChannelCell">
          <span>{row.generateChannel?.name || row.generateChannelId}</span>
          <Badge tone={row.generateChannel && !row.generateChannel.disabled ? "info" : "warning"}>
            {resLabel(row.generateResolution)}
          </Badge>
        </div>
      ),
    },
    {
      id: "enhance",
      header: "超分通道",
      priority: "secondary",
      minWidth: "140px",
      cell: (row) => row.enhanceEnabled ? (
        <span>{row.enhanceChannel?.name || row.enhanceChannelId || "-"}</span>
      ) : (
        <Badge tone="neutral">原生直出</Badge>
      ),
    },
    {
      id: "weight",
      header: "权重",
      priority: "primary",
      width: "120px",
      cell: (row) => (
        <InlineNumber
          value={row.weight}
          min={0}
          ariaLabel={`配方 ${row.name || row.id} 权重`}
          disabled={inlineSavingId === row.id}
          onCommit={(value) => void inlineUpdate(row, { weight: value })}
        />
      ),
    },
    {
      id: "priority",
      header: "次序",
      priority: "secondary",
      width: "110px",
      cell: (row) => (
        <InlineNumber
          value={row.priority}
          ariaLabel={`配方 ${row.name || row.id} 次序`}
          disabled={inlineSavingId === row.id}
          onCommit={(value) => void inlineUpdate(row, { priority: value })}
        />
      ),
    },
    {
      id: "enabled",
      header: "启用",
      priority: "primary",
      width: "90px",
      cell: (row) => (
        <Switch
          checked={row.enabled}
          disabled={inlineSavingId === row.id}
          onCheckedChange={(checked) => void inlineUpdate(row, { enabled: checked })}
          label={row.enabled ? "启用" : "停用"}
        />
      ),
    },
    {
      id: "actions",
      header: "操作",
      priority: "primary",
      width: "170px",
      cell: (row) => (
        <div className="vfRowActions">
          <Button size="compact" variant="secondary" icon={<Pencil size={14} />} onClick={() => openEditDrawer(row)}>
            编辑
          </Button>
          {confirmDeleteId === row.id ? (
            <>
              <Button size="compact" variant="danger" loading={inlineSavingId === row.id} onClick={() => void removeRecipe(row)}>
                确认删除
              </Button>
              <Button size="compact" variant="ghost" aria-label="取消删除" onClick={() => setConfirmDeleteId("")}>
                <X size={14} />
              </Button>
            </>
          ) : (
            <Button size="compact" variant="ghost" icon={<Trash2 size={14} />} disabled={inlineSavingId === row.id} onClick={() => setConfirmDeleteId(row.id)}>
              删除
            </Button>
          )}
        </div>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [inlineSavingId, confirmDeleteId, activeModel, activeRes]);

  return (
    <ConsolePage
      breadcrumbs={[{ label: "模型管理" }, { label: title }]}
      title={title}
      description={description}
      primaryAction={
        <div className="vfPageActions">
          <Button
            variant="secondary"
            icon={<RefreshCcw size={16} />}
            onClick={() => {
              if (mode !== "enhancement") void loadOffers();
              if (mode !== "recipes") void loadOverview();
            }}
          >
            刷新
          </Button>
          {!sectionNavigation ? <Button variant="secondary" icon={<Route size={16} />} onClick={() => navigate("/fjadmin/provider-channels")}>
            供应商通道
          </Button> : null}
        </div>
      }
      layoutWidth="dashboard"
    >
      {sectionNavigation}
      {errorMessage ? <Alert tone="danger">{errorMessage}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {mode !== "enhancement" ? <div className={`vfGrid${!loading && offers.length === 0 ? " vfGrid--empty" : ""}`}>
        <Section
          title="公开模型"
          description="来自已启用的视频生成路由；显示名在路由规则中维护。"
          icon={Clapperboard}
          action={activeModel ? (
            <Button size="compact" variant="ghost" icon={<Route size={14} />} onClick={() => viewRouteRules(activeModel)}>
              查看路由
            </Button>
          ) : undefined}
        >
          {loading ? (
            <Skeleton height="7.5rem" />
          ) : offers.length === 0 ? (
            <EmptyState
              title="暂无公开模型"
              description="请先创建并启用 video_generation 模型路由，再配置视频生成配方。"
              action={<Button variant="secondary" icon={<Route size={15} />} onClick={() => viewRouteRules()}>前往路由规则</Button>}
            />
          ) : (
            <div className="vfOfferList" role="listbox" aria-label="公开模型列表">
              {offers.map((offer) => {
                const active = activeModel === offer.publicModel;
                return (
                  <div
                    key={offer.publicModel}
                    className="vfOfferItem"
                    data-active={active || undefined}
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-label={`选择公开模型 ${offer.displayName}，模型 ID ${offer.publicModel}`}
                      className="vfOfferSelect"
                      onClick={() => selectModel(offer.publicModel)}
                    >
                      <span className="vfOfferNameRow">
                        <strong title={offer.displayName}>{offer.displayName}</strong>
                      </span>
                      <span className="vfOfferMeta">
                        <span className="vfOfferMetaLabel">模型 ID</span>
                        <code title={offer.publicModel}>{offer.publicModel}</code>
                      </span>
                    </button>
                    <span className="vfOfferControls">
                      {offer.offerConfigured ? null : <Badge tone="warning">未建档</Badge>}
                      <span className="vfOfferToggle">
                        <Switch
                          checked={offer.enabled}
                          onCheckedChange={(checked) => void toggleOfferEnabled(offer, checked)}
                          label={offer.enabled ? "对外开放" : "未开放"}
                        />
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {offers.length ? <Section title="公开分辨率" description="每档启用配方数">
          <div className="vfResList" role="tablist" aria-label="公开分辨率">
            {publicResolutions.map((res) => {
              const count = activeOffer?.recipeCounts?.[res];
              const tone = resolutionLightTone(count);
              const active = activeRes === res;
              return (
                <button
                  key={res}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="vfResButton"
                  data-active={active || undefined}
                  onClick={() => selectResolution(res)}
                >
                  <span className={`vfLight vfLight--${tone}`} aria-label={LIGHT_LABEL[tone]} title={LIGHT_LABEL[tone]} />
                  <strong>{resLabel(res)}</strong>
                  <span className="vfResCount">{count ? `${count.enabled}/${count.total}` : "0/0"}</span>
                </button>
              );
            })}
          </div>
        </Section> : null}

        {offers.length ? <Section
          title={`配方 · ${activeOffer?.displayName || activeModel || "-"} · ${resLabel(activeRes)}`}
          description="多条配方按权重轮询；可从 480p 起分后超分，也可由上游原生直出。"
          action={
            <Button icon={<Plus size={16} />} disabled={!activeModel} onClick={openCreateDrawer}>
              新建配方
            </Button>
          }
        >
          {!activeModel ? (
            <EmptyState title="先选择公开模型" />
          ) : (
            <DataTable
              rows={recipes}
              columns={columns}
              getRowId={(row) => row.id}
              ariaLabel={`${activeModel} ${resLabel(activeRes)} 配方列表`}
              loading={recipesLoading}
              emptyState="该档暂无配方。无启用配方时请勿对用户开放该分辨率。"
            />
          )}
        </Section> : null}
      </div> : null}

      {mode !== "recipes" ? <EnhanceSection
        overview={overview}
        loading={overviewLoading}
        error={overviewError}
        onSaved={() => { setNotice("价目已保存"); void loadOverview(); }}
        onError={setErrorMessage}
      /> : null}

      {mode !== "recipes" ? <Section title="能力边界" description="生成配方、创作台增强与中转站的分工">
        <ul className="vfBoundaryList">
          <li>用户直接选择 720p / 1080p / 2K / 4K 时，使用“视频生成配方”中的一口价兑现链路。</li>
          <li>创作台对已生成成片主动升档时，只使用本页独立增强节点与价格；不会读取或修改模型路由配方。</li>
          <li>模型路由中的超分节点必须自己选择 video_upscale 通道，费用计入发布目标定价，不采用本页售价。</li>
          <li>中转站不提供画质增强，开发者目录也不暴露可售的 upscale 模型。</li>
        </ul>
      </Section> : null}

      {mode !== "enhancement" ? <RecipeDrawer
        open={drawerOpen}
        form={form}
        initialForm={initialForm}
        saving={savingRecipe}
        error={recipeError}
        warnings={recipeWarnings}
        publicModel={activeModel}
        targetResolution={activeRes}
        generateChannels={generateChannels}
        upscaleChannels={upscaleChannels}
        onChange={setForm}
        onSave={() => void saveRecipe()}
        onOpenChange={setDrawerOpen}
      /> : null}
    </ConsolePage>
  );
}

/** 行内数字编辑:Enter 或失焦提交,Esc 还原。 */
function InlineNumber({
  value,
  onCommit,
  min,
  ariaLabel,
  disabled,
}: {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(value);
  }, [value, dirty]);

  const commit = () => {
    if (!dirty) return;
    setDirty(false);
    const next = draft ?? value;
    if (next !== value) onCommit(next);
  };

  return (
    <span
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) commit();
      }}
    >
      <NumberInput
        value={draft}
        min={min}
        step={1}
        aria-label={ariaLabel}
        disabled={disabled}
        onValueChange={(next) => { setDraft(next); setDirty(true); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); }
          if (event.key === "Escape") { setDraft(value); setDirty(false); }
        }}
      />
    </span>
  );
}
