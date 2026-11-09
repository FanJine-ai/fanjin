import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Section, Tabs } from "../../ui/console";
import type { ModelRouteGroup } from "../../features/admin/modelOperations/types";
import "./modelManagement.css";

const ModelRouteGroupsPage = lazy(() => import("../../features/admin/modelOperations/ModelRouteGroupsPage"));
const PortraitAssetsPage = lazy(() => import("../../features/admin/portraitAssets/Page"));
const VideoFulfillmentPage = lazy(() => import("../../features/admin/videoFulfillment/Page"));
const ModelRouteCanvasPage = lazy(() => import("../../features/admin/modelRouteCanvas/ModelRouteCanvasPage"));

type ModelManagementSection = "routes" | "video-recipes" | "quality-enhancement" | "portrait-assets" | "canvas";

const sectionDescriptions: Record<ModelManagementSection, string> = {
  routes: "决定请求命中哪个模型与通道；视频生成路由可继续配置公开分辨率配方。",
  "video-recipes": "把已启用的视频生成路由组合为公开档位，维护原生直出、无感超分、权重与回退次序。",
  "quality-enhancement": "配置成片主动升档、超分通道池与单独计价；它不改变视频生成配方。",
  "portrait-assets": "只读观察人像素材的检测、审核、授权准入与供应商 Group / Asset 同步状态。",
  canvas: "在无限画布中组合模型、能力映射、质量策略与发布目标；画布资源只在进入本区后加载。",
};

function normalizeSection(searchParams: URLSearchParams): ModelManagementSection {
  const requested = searchParams.get("section") || searchParams.get("tab");
  if (requested === "video-recipes" || requested === "video-delivery") return "video-recipes";
  if (requested === "quality-enhancement") return "quality-enhancement";
  if (requested === "portrait-assets") return "portrait-assets";
  if (requested === "canvas") return "canvas";
  return "routes";
}

function SectionLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="modelManagementHub__loading">
      正在加载{label}…
    </div>
  );
}

function LazySection({ label, children }: { label: string; children: ReactNode }) {
  return <Suspense fallback={<SectionLoading label={label} />}>{children}</Suspense>;
}

export default function ModelManagementRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const section = normalizeSection(searchParams);

  function selectSection(value: ModelManagementSection) {
    const next = new URLSearchParams(searchParams);
    [
      "tab", "q", "capability", "provider", "status", "sourcePoolId", "model", "resolution",
      "pa_q", "pa_subject", "pa_scan", "pa_moderation", "pa_compliance",
      "pa_sync", "pa_manual", "pa_imagex", "pa_page", "pa_size",
    ].forEach((key) => next.delete(key));
    if (value === "routes") next.delete("section");
    else next.set("section", value);
    setSearchParams(next, { replace: true });
  }

  function openVideoRecipes(group: ModelRouteGroup) {
    const next = new URLSearchParams();
    next.set("section", "video-recipes");
    next.set("model", group.publicModel);
    next.set("resolution", "720p");
    setSearchParams(next);
  }

  function openRouteRules(model?: string) {
    const next = new URLSearchParams();
    if (model) {
      next.set("q", model);
      next.set("capability", "video_generation");
    }
    setSearchParams(next);
  }

  const sectionNavigation = useMemo(() => (
    <Section aria-label="模型管理功能区" surface="subtle" className="modelManagementHub">
      <Tabs
        ariaLabel="模型路由功能"
        value={section}
        items={[
          { value: "routes", label: "路由规则" },
          { value: "video-recipes", label: "视频生成配方" },
          { value: "quality-enhancement", label: "画质增强" },
          { value: "portrait-assets", label: "人像资产" },
          { value: "canvas", label: "路由画布" },
        ]}
        onValueChange={(value) => selectSection(value as ModelManagementSection)}
      />
      <div className="modelManagementHub__context">
        <p>{sectionDescriptions[section]}</p>
      </div>
    </Section>
  // `searchParams` carries preserved deep-link filters used by selectSection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [searchParams, section, setSearchParams]);

  if (section === "canvas") {
    return (
      <LazySection label="模型路由画布">
        <ModelRouteCanvasPage />
      </LazySection>
    );
  }

  if (section === "video-recipes") {
    return (
      <LazySection label="视频生成配方">
        <VideoFulfillmentPage
          mode="recipes"
          title="模型路由"
          description="将视频生成路由组合为用户可见的分辨率档位与兑现配方。"
          sectionNavigation={sectionNavigation}
          onViewRoutes={openRouteRules}
        />
      </LazySection>
    );
  }

  if (section === "quality-enhancement") {
    return (
      <LazySection label="画质增强">
        <VideoFulfillmentPage
          mode="enhancement"
          title="模型路由"
          description="维护成片主动升档的超分通道池、源到目标矩阵与独立计价。"
          sectionNavigation={sectionNavigation}
          onViewRoutes={openRouteRules}
        />
      </LazySection>
    );
  }

  if (section === "portrait-assets") {
    return (
      <LazySection label="人像资产">
        <PortraitAssetsPage
          title="人像资产"
          description="查看素材预检、内容审核、肖像授权准入与供应商同步状态；本页不提供写操作。"
          sectionNavigation={sectionNavigation}
        />
      </LazySection>
    );
  }

  return (
    <LazySection label="路由规则">
      <ModelRouteGroupsPage
        title="模型路由"
        description="从模型池选择上游，按逻辑模型维护 P0/P1/P2、同层权重与首次售价。"
        sectionNavigation={sectionNavigation}
        onConfigureVideoRecipes={openVideoRecipes}
      />
    </LazySection>
  );
}
