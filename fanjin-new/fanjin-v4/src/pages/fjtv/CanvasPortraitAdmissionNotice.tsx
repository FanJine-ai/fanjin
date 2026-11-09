import PortraitAdmissionPanel from "../../features/portrait-admission/PortraitAdmissionPanel";
import type { PortraitAdmissionAsset } from "../../features/portrait-admission/PortraitAdmissionPanel";

export function CanvasPortraitAdmissionNotice({
  projectId,
  model,
  assets,
  refreshKey,
  layout,
  configured,
  onLayoutChange,
}: {
  projectId: number | null;
  model?: string;
  assets: readonly PortraitAdmissionAsset[];
  refreshKey?: string;
  layout: "hidden" | "pill" | "panel";
  configured: boolean;
  onLayoutChange: (layout: "hidden" | "pill" | "panel") => void;
}) {
  return (
    <div
      data-fixed-ui
      data-canvas-admission
      data-admission-layout={layout}
      className={layout === "panel"
        ? "absolute right-5 top-20 z-[115] w-[min(390px,calc(100vw-40px))] rounded-2xl border border-white/10 bg-[#202329]/95 p-3 shadow-[0_18px_52px_rgba(0,0,0,.38)] backdrop-blur-xl"
        : "absolute right-5 top-20 z-[115]"}
    >
      <PortraitAdmissionPanel
        projectId={projectId}
        model={model}
        assets={assets}
        requireRegistration
        refreshKey={refreshKey}
        onLayoutChange={onLayoutChange}
      />
      {!configured ? <p role="alert" className="mt-2 text-sm text-amber-500">所选火山通道的人像服务未配置。含人像的参考素材需要管理员配置后才能完成登记。</p> : null}
    </div>
  );
}
