import { buildSubmitButtonPendingKey } from "./canvasSubmitPendingKeys";
import React from "react";
import { ChevronDown } from "lucide-react";

export function renderImageEnhancePanelExternal(deps: any, node: any): React.ReactNode {
  const { canvasCapabilities, activeNodeId, activeImageEnhance, controlsPos, IMAGE_ENHANCE_FACTORS_PROFESSIONAL, IMAGE_ENHANCE_FACTORS_STANDARD, resolveEnhanceModelLabel, models, IMAGE_ENHANCE_MODEL_FALLBACK, setActiveImageEnhance, renderCompactSubmitButton, submitImageEnhance } = deps;
  const renderImageEnhancePanel = (node: any) => {
    if (!canvasCapabilities.imageEnhance) return null;
    if (!node.imageEnhanceMode || activeNodeId !== node.id || !activeImageEnhance || activeImageEnhance.nodeId !== node.id || !controlsPos) return null;
    const factorItems = activeImageEnhance.version === "professional" ? IMAGE_ENHANCE_FACTORS_PROFESSIONAL : IMAGE_ENHANCE_FACTORS_STANDARD;
    return (
      <div
        data-fixed-ui
        data-node-settings-panel
        className="absolute z-[86] rounded-[22px] border border-[#3e4045] bg-[#282828] px-4 pb-4 pt-4 text-white shadow-[0_26px_52px_rgba(0,0,0,0.45)]"
        style={{ width: 460, left: controlsPos.promptX, top: controlsPos.promptY, transform: "translateX(-50%)" }}
      >
        <div className="mb-5 text-[28px] font-semibold">图片高清</div>
        <div className="space-y-4 text-[15px]">
          <div className="flex items-center gap-4">
            <div className="w-[96px] text-[#eceff5]">模型选择</div>
            <button className="flex h-12 flex-1 items-center justify-between rounded-[12px] border border-[#4b4d52] px-4 text-left">
              <span>{resolveEnhanceModelLabel(node.model, models, IMAGE_ENHANCE_MODEL_FALLBACK)}</span>
              <ChevronDown className="h-4 w-4 text-[#a4a7ae]" />
            </button>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-[96px] text-[#eceff5]">版本开关</div>
            <div className="flex flex-1 gap-2">
              {(["standard", "professional"] as const).map((item: any) => (
                <button
                  key={item}
                  className={`h-12 flex-1 rounded-[12px] border ${activeImageEnhance.version === item ? "border-[#6b6d72] bg-[#5a5b60]" : "border-[#4b4d52] bg-transparent text-[#a6a9b0]"}`}
                  onClick={() =>
                    setActiveImageEnhance((prev: any) =>
                      prev && prev.nodeId === node.id
                        ? {
                            ...prev,
                            version: item,
                            factor: Math.min(prev.factor, item === "professional" ? 30 : 8),
                          }
                        : prev,
                    )
                  }
                >
                  {item === "professional" ? "专业版" : "标准版"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-4">
            <div className="w-[96px] pt-3 text-[#eceff5]">放大倍数</div>
            <div className="grid flex-1 grid-cols-5 gap-2">
              {factorItems.map((item: any) => (
                <button
                  key={item}
                  className={`h-11 rounded-[12px] border text-[13px] ${activeImageEnhance.factor === item ? "border-[#6b6d72] bg-[#5a5b60] text-white" : "border-[#4b4d52] bg-transparent text-[#a6a9b0]"}`}
                  onClick={() => setActiveImageEnhance((prev: any) => (prev && prev.nodeId === node.id ? { ...prev, factor: item } : prev))}
                >
                  {item}x
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-3">
          {renderCompactSubmitButton(buildSubmitButtonPendingKey("image-enhance", node.id), () => submitImageEnhance(node))}
        </div>
      </div>
    );
  };
  return renderImageEnhancePanel(node);
}
