import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { VIDEO_STORY_COLUMNS } from "./CanvasVideoStoryTable";
import type { VideoStoryShot, ProductScriptStep, ProductScriptAssetKind, ProductScriptAsset, ProductStoryboardShot, ProductScriptWorkflow, NodeData } from "./canvasDataTypes";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { Fragment } from "react";
import { type CanvasRealCapabilities } from "./canvasCapabilities";
import { Check, Expand, NotebookTabs, Upload, X } from "lucide-react";

export interface CanvasProductScriptViewDependencies {
  setStatus: Dispatch<SetStateAction<string>>;
  canvasCapabilities: CanvasRealCapabilities;
  getProductScriptWorkflow: (node: NodeData) => ProductScriptWorkflow;
  setProductScriptFullscreenNodeId: Dispatch<SetStateAction<string | null>>;
  openProductScriptVideoUpload: (nodeId: string) => void;
  updateProductScriptShot: (nodeId: string, rowIndex: number, field: keyof VideoStoryShot | string, value: string) => void;
  saveProductScriptWorkflow: (nodeId: string, updater: ProductScriptWorkflow | ((current: ProductScriptWorkflow) => ProductScriptWorkflow)) => null;
  submitProductAssetsAnalysis: (nodeId: string) => Promise<void>;
  PRODUCT_SCRIPT_ASSETS: { kind: ProductScriptAssetKind; label: string; placeholder: string; }[];
  openProductScriptAssetUpload: (nodeId: string, kind: ProductScriptAssetKind) => void;
  updateProductAnalysisText: (nodeId: string, field: "overallStyle" | "sellingPoints" | "visualKeywords" | "avoidNotes", value: string) => void;
  submitProductStoryboardCompose: (nodeId: string) => Promise<void>;
  updateProductStoryboardShot: (nodeId: string, rowIndex: number, field: keyof ProductStoryboardShot | string, value: string) => void;
  productScriptFullscreenNodeId: string | null;
  nodeMap: Map<string, NodeData>;
  generateProductScriptVideos: (nodeId: string) => Promise<void>;
}

export function createCanvasProductScriptView(deps: CanvasProductScriptViewDependencies) {
  const { setStatus, canvasCapabilities, getProductScriptWorkflow, setProductScriptFullscreenNodeId, openProductScriptVideoUpload, updateProductScriptShot, saveProductScriptWorkflow, submitProductAssetsAnalysis, PRODUCT_SCRIPT_ASSETS, openProductScriptAssetUpload, updateProductAnalysisText, submitProductStoryboardCompose, updateProductStoryboardShot, productScriptFullscreenNodeId, nodeMap, generateProductScriptVideos } = deps;
function renderProductScriptProgressChip(workflow: ProductScriptWorkflow, label?: string) {
    const progress = Math.max(1, Math.min(99, Math.round(workflow.progress || 1)));
    return (
      <div data-product-script-progress-chip className="inline-flex items-center gap-3 rounded-[10px] border border-white/20 bg-[#111216]/88 px-4 py-2 text-[14px] font-semibold text-white shadow-[0_14px_34px_rgba(0,0,0,0.42)]">
        <span>{label || "生成中"} {progress}%...</span>
        <button className="text-[13px] font-medium text-white/68 hover:text-white" onClick={(event) => { event.stopPropagation(); setStatus("当前任务已提交后端，暂不支持取消"); }}>
          取消
        </button>
      </div>
    );
  }

function renderProductScriptSkeleton(workflow: ProductScriptWorkflow, compact = false) {
    const rows = compact ? 5 : 8;
    return (
      <div data-product-script-skeleton className="relative h-full min-h-[220px] overflow-hidden rounded-[18px] bg-[#202123] p-4">
        <div className="grid grid-cols-3 gap-2 opacity-70">
          {Array.from({ length: rows * 3 }).map((_, index) => (
            <div key={index} className="h-7 rounded-[5px] bg-[linear-gradient(90deg,rgba(255,255,255,0.06),rgba(255,255,255,0.14),rgba(255,255,255,0.06))]" />
          ))}
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          {renderProductScriptProgressChip(workflow)}
        </div>
      </div>
    );
  }

function renderProductScriptMiniSteps(workflow: ProductScriptWorkflow) {
    const items = [
      { step: 1 as ProductScriptStep, label: "确认镜头", done: Boolean(workflow.viralAnalysis?.rows?.length) },
      { step: 2 as ProductScriptStep, label: "准备资产", done: Boolean(workflow.productAnalysis) },
      { step: 3 as ProductScriptStep, label: "合成提示词", done: Boolean(workflow.storyboard?.rows?.length) },
    ];
    return (
      <div className="flex items-center justify-center gap-4 py-4">
        {items.map((item, index) => (
          <Fragment key={item.step}>
            <div className="flex flex-col items-center gap-1 text-center">
              <span className={"flex h-9 w-9 items-center justify-center rounded-full text-[15px] font-semibold " + (item.done ? "bg-white text-black" : workflow.step === item.step ? "border border-white bg-[#202124] text-white" : "border border-white/20 text-white/45")}>{item.done ? <Check className="h-5 w-5" /> : item.step}</span>
              <span className={"text-[13px] " + (workflow.step === item.step ? "text-white" : "text-white/55")}>{item.label}</span>
            </div>
            {index < items.length - 1 ? <div className="h-px w-16 bg-white/16" /> : null}
          </Fragment>
        ))}
      </div>
    );
  }

function renderProductScriptNode(node: NodeData) {
    if (!canvasCapabilities.productScript) {
      return (
        <div data-product-script-node className="flex h-full w-full flex-col items-center justify-center rounded-[18px] border border-[#33363d] bg-[#222325] p-6 text-center text-white">
          <NotebookTabs className="mb-3 h-8 w-8 text-white/48" />
          <div className="text-[16px] font-semibold">爆款视频拆解暂未开放</div>
          <div className="mt-2 max-w-[320px] text-[13px] leading-6 text-white/48">
            当前版本不会提交分析、分镜或生成请求；历史节点仅保留查看和删除。
          </div>
        </div>
      );
    }
    const workflow = getProductScriptWorkflow(node);
    const busy = workflow.stage === "uploading" || workflow.stage === "analyzing-viral" || workflow.stage === "analyzing-product" || workflow.stage === "composing-storyboard" || workflow.stage === "generating-video";
    const shotCount = workflow.viralAnalysis?.rows?.length || 0;
    const storyboardCount = workflow.storyboard?.rows?.length || 0;
    if (busy) return renderProductScriptSkeleton(workflow, true);
    return (
      <div data-product-script-node className="flex h-full w-full flex-col rounded-[18px] border border-[#33363d] bg-[#222325] p-4 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[16px] font-semibold text-white">
              <NotebookTabs className="h-5 w-5 text-[#cfd4dd]" />
              <span>爆款视频拆解</span>
            </div>
            <div className="mt-1 text-[12px] text-white/42">爆款节奏 + 我们产品解析 + 批量生成视频</div>
          </div>
          <button className="flex h-8 w-8 items-center justify-center rounded-[9px] text-white/66 hover:bg-white/8 hover:text-white" onClick={(event) => { event.stopPropagation(); setProductScriptFullscreenNodeId(node.id); }}>
            <Expand className="h-4 w-4" />
          </button>
        </div>
        {workflow.stage === "failed" ? (
          <div className="mt-4 rounded-[12px] border border-red-400/20 bg-red-500/10 p-3 text-[13px] leading-6 text-red-100">
            {workflow.error || "处理失败，请重试"}
          </div>
        ) : null}
        {workflow.sourceVideoUrl ? (
          <div className="mt-4 rounded-[12px] border border-white/8 bg-black/18 p-3 text-[13px] text-white/68">
            <div className="truncate text-white/88">{workflow.sourceVideoName || "已上传爆款视频"}</div>
            <div className="mt-1">镜头 {shotCount} 个 · 产品资产 {workflow.assets.filter((asset) => asset.imageUrl).length}/3 · 分镜 {storyboardCount} 个</div>
          </div>
        ) : (
          <div className="mt-5 flex flex-1 items-center justify-center rounded-[14px] border border-dashed border-white/14 bg-black/12 text-center">
            <div>
              <Upload className="mx-auto mb-3 h-8 w-8 text-white/42" />
              <div className="text-[15px] font-semibold">上传爆款视频</div>
              <div className="mt-1 text-[12px] text-white/42">系统会抽关键帧并反推镜头语言</div>
            </div>
          </div>
        )}
        {workflow.sourceVideoUrl ? renderProductScriptMiniSteps(workflow) : null}
        <div className="mt-auto flex items-center gap-2 pt-4">
          <button
            className="flex h-10 flex-1 items-center justify-center rounded-[12px] bg-white text-[14px] font-semibold text-black hover:bg-white/90"
            onClick={(event) => {
              event.stopPropagation();
              if (workflow.sourceVideoUrl) setProductScriptFullscreenNodeId(node.id);
              else openProductScriptVideoUpload(node.id);
            }}
          >
            {workflow.sourceVideoUrl ? "打开脚本节点 →" : "上传并拆解"}
          </button>
          {workflow.sourceVideoUrl ? (
            <button className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-white/12 text-white/72 hover:bg-white/8" onClick={(event) => { event.stopPropagation(); openProductScriptVideoUpload(node.id); }}>
              <Upload className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

function renderEditableProductViralTable(node: NodeData, workflow: ProductScriptWorkflow) {
    const rows = workflow.viralAnalysis?.rows || [];
    const tableWidth = VIDEO_STORY_COLUMNS.reduce((sum, column) => sum + column.width, 0) + 136;
    if (!rows.length) return renderProductScriptSkeleton(workflow);
    return (
      <div className="h-[calc(100vh-244px)] overflow-auto rounded-[10px] border border-[#292a2e]">
        <table className="border-collapse text-left text-[14px] text-[#f0f1f4]" style={{ minWidth: tableWidth }}>
          <colgroup>
            {VIDEO_STORY_COLUMNS.map((column) => <col key={column.key} style={{ width: column.width }} />)}
            <col style={{ width: 136 }} />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[#383838] text-[#a4a7ad]">
            <tr>
              {VIDEO_STORY_COLUMNS.map((column) => <th key={column.key} className="border-b border-r border-[#28292c] px-4 py-3 text-[14px] font-medium">{column.label}</th>)}
              <th className="border-b border-r border-[#28292c] px-4 py-3 text-[14px] font-medium">关键帧</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={row.shot || rowIndex} className="bg-[#101010]/96 align-top">
                {VIDEO_STORY_COLUMNS.map((column) => {
                  const value = String((row as any)[column.key] ?? "");
                  const compact = ["shot", "startTime", "endTime", "duration"].includes(column.key);
                  return (
                    <td key={column.key} className="border-b border-r border-[#2b2c30] p-2 leading-6 text-white/92">
                      {compact ? (
                        <input className="h-9 w-full rounded-[6px] border border-white/8 bg-transparent px-2 text-white outline-none focus:border-white/28" value={value} onChange={(event) => updateProductScriptShot(node.id, rowIndex, column.key, event.target.value)} />
                      ) : (
                        <textarea className="min-h-[112px] w-full resize-none rounded-[6px] border border-white/8 bg-transparent p-2 leading-6 text-white outline-none focus:border-white/28" value={value} onChange={(event) => updateProductScriptShot(node.id, rowIndex, column.key, event.target.value)} />
                      )}
                    </td>
                  );
                })}
                <td className="border-b border-r border-[#2b2c30] px-3 py-4">
                  {row.keyframeUrl ? <ReferencePreviewImage src={row.keyframeUrl} alt={"关键帧" + row.shot} className="h-[72px] w-[112px] rounded-[4px] object-cover" /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

function renderProductAssetsEditor(node: NodeData, workflow: ProductScriptWorkflow) {
    const analysis = workflow.productAnalysis;
    const busy = workflow.stage === "analyzing-product";
    const uploadedCount = workflow.assets.filter((asset) => asset.imageUrl).length;
    return (
      <div className="flex h-[calc(100vh-226px)] flex-col overflow-auto px-9 pb-8 pt-5">
        <div className="mb-5 grid max-w-[760px] grid-cols-2 gap-4">
          <label className="text-[13px] text-white/55">
            产品名称
            <input className="mt-2 h-11 w-full rounded-[10px] border border-white/10 bg-[#18191b] px-3 text-[15px] text-white outline-none focus:border-white/30" value={workflow.productName} onChange={(event) => saveProductScriptWorkflow(node.id, (current) => ({ ...current, productName: event.target.value }))} />
          </label>
          <label className="text-[13px] text-white/55">
            产品品类
            <input className="mt-2 h-11 w-full rounded-[10px] border border-white/10 bg-[#18191b] px-3 text-[15px] text-white outline-none focus:border-white/30" value={workflow.productCategory} onChange={(event) => saveProductScriptWorkflow(node.id, (current) => ({ ...current, productCategory: event.target.value }))} />
          </label>
        </div>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[20px] font-semibold">准备资产</div>
            <div className="mt-1 text-[14px] text-white/48">只需要三类：模特图、产品图、上妆效果图。上传后系统会解析我们的产品卖点和禁忌点。</div>
          </div>
          <button className="rounded-[12px] bg-white px-5 py-3 text-[15px] font-semibold text-black disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || uploadedCount === 0} onClick={() => void submitProductAssetsAnalysis(node.id)}>
            {busy ? "解析中..." : analysis ? "重新解析产品" : "解析我们的产品"}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-4">
          {PRODUCT_SCRIPT_ASSETS.map((def) => {
            const asset = workflow.assets.find((item) => item.kind === def.kind) || { kind: def.kind, label: def.label } as ProductScriptAsset;
            return (
              <div key={def.kind} className="rounded-[16px] border border-white/10 bg-[#18191b] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-[16px] font-semibold">{def.label}</div>
                  <button className="rounded-[9px] border border-white/12 px-3 py-1.5 text-[13px] text-white/78 hover:bg-white/8" onClick={() => openProductScriptAssetUpload(node.id, def.kind)}>
                    {asset.uploading ? "上传中" : asset.imageUrl ? "替换" : "上传"}
                  </button>
                </div>
                <button className="flex h-[180px] w-full items-center justify-center overflow-hidden rounded-[12px] border border-dashed border-white/14 bg-black/18" onClick={() => openProductScriptAssetUpload(node.id, def.kind)}>
                  {asset.imageUrl ? (
                    <div className="relative h-full w-full">
                      <ReferencePreviewImage src={asset.imageUrl} alt={def.label} className="h-full w-full object-cover" />
                      {asset.uploading ? <div className="absolute inset-0 flex items-center justify-center bg-black/38 text-[15px] font-semibold text-white">上传中...</div> : null}
                    </div>
                  ) : <div className="px-5 text-center text-[14px] leading-6 text-white/38">{asset.uploading ? "上传中..." : def.placeholder}</div>}
                </button>
                {asset.summary ? <div className="mt-3 line-clamp-3 text-[13px] leading-5 text-white/55">{asset.summary}</div> : null}
              </div>
            );
          })}
        </div>
        {busy ? <div className="mt-5">{renderProductScriptSkeleton(workflow, true)}</div> : null}
        {analysis ? (
          <div className="mt-6 grid grid-cols-2 gap-4">
            <label className="text-[14px] text-white/62">
              产品整体风格
              <textarea className="mt-2 h-28 w-full resize-none rounded-[12px] border border-white/10 bg-[#151618] p-3 leading-6 text-white outline-none focus:border-white/30" value={analysis.overallStyle || ""} onChange={(event) => updateProductAnalysisText(node.id, "overallStyle", event.target.value)} />
            </label>
            <label className="text-[14px] text-white/62">
              核心卖点
              <textarea className="mt-2 h-28 w-full resize-none rounded-[12px] border border-white/10 bg-[#151618] p-3 leading-6 text-white outline-none focus:border-white/30" value={Array.isArray(analysis.sellingPoints) ? analysis.sellingPoints.join("\n") : ""} onChange={(event) => updateProductAnalysisText(node.id, "sellingPoints", event.target.value)} />
            </label>
            <label className="text-[14px] text-white/62">
              视觉关键词
              <textarea className="mt-2 h-28 w-full resize-none rounded-[12px] border border-white/10 bg-[#151618] p-3 leading-6 text-white outline-none focus:border-white/30" value={Array.isArray(analysis.visualKeywords) ? analysis.visualKeywords.join("\n") : ""} onChange={(event) => updateProductAnalysisText(node.id, "visualKeywords", event.target.value)} />
            </label>
            <label className="text-[14px] text-white/62">
              视觉禁忌
              <textarea className="mt-2 h-28 w-full resize-none rounded-[12px] border border-white/10 bg-[#151618] p-3 leading-6 text-white outline-none focus:border-white/30" value={Array.isArray(analysis.avoidNotes) ? analysis.avoidNotes.join("\n") : ""} onChange={(event) => updateProductAnalysisText(node.id, "avoidNotes", event.target.value)} />
            </label>
          </div>
        ) : null}
      </div>
    );
  }

function renderProductStoryboardEditor(node: NodeData, workflow: ProductScriptWorkflow) {
    const rows = workflow.storyboard?.rows || [];
    const busy = workflow.stage === "composing-storyboard" || workflow.stage === "generating-video";
    const columns = [
      { key: "shot", label: "镜号", width: 86, compact: true },
      { key: "duration", label: "时长", width: 96, compact: true },
      { key: "visualDescription", label: "产品画面", width: 310 },
      { key: "productSellingPoint", label: "产品卖点", width: 240 },
      { key: "shotSize", label: "景别", width: 120 },
      { key: "cameraAngle", label: "角度", width: 150 },
      { key: "cameraMovement", label: "运镜", width: 170 },
      { key: "lighting", label: "光线/质感", width: 220 },
      { key: "assetUsage", label: "资产使用", width: 240 },
      { key: "imagePrompt", label: "图像提示词", width: 320 },
      { key: "videoMotionPrompt", label: "视频运动提示词", width: 320 },
      { key: "finalPrompt", label: "最终提示词", width: 380 },
    ];
    const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
    if (busy && !rows.length) return <div className="px-9 pt-5">{renderProductScriptSkeleton(workflow)}</div>;
    return (
      <div className="flex h-[calc(100vh-226px)] flex-col px-9 pb-8 pt-5">
        {!rows.length ? (
          <div className="flex flex-1 items-center justify-center rounded-[18px] border border-dashed border-white/12 bg-[#171819] text-center">
            <div>
              <NotebookTabs className="mx-auto mb-4 h-10 w-10 text-white/38" />
              <div className="text-[20px] font-semibold">生成产品分镜</div>
              <div className="mt-2 max-w-[560px] text-[14px] leading-6 text-white/48">系统会保持爆款视频拆解出来的镜头数量和节奏，把内容替换成我们的产品卖点、妆效、质感和视觉关键词。</div>
              <button className="mt-6 rounded-[14px] bg-white px-7 py-3 text-[16px] font-semibold text-black disabled:opacity-45" disabled={!workflow.productAnalysis} onClick={() => void submitProductStoryboardCompose(node.id)}>
                生成产品分镜
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto rounded-[10px] border border-[#292a2e]">
            <table className="border-collapse text-left text-[14px] text-[#f0f1f4]" style={{ minWidth: tableWidth }}>
              <colgroup>{columns.map((column) => <col key={column.key} style={{ width: column.width }} />)}</colgroup>
              <thead className="sticky top-0 z-10 bg-[#383838] text-[#a4a7ad]"><tr>{columns.map((column) => <th key={column.key} className="border-b border-r border-[#28292c] px-4 py-3 font-medium">{column.label}</th>)}</tr></thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={row.shot || rowIndex} className="bg-[#101010]/96 align-top">
                    {columns.map((column) => {
                      const value = String((row as any)[column.key] ?? "");
                      return (
                        <td key={column.key} className="border-b border-r border-[#2b2c30] p-2">
                          {column.compact ? <input className="h-9 w-full rounded-[6px] border border-white/8 bg-transparent px-2 text-white outline-none focus:border-white/28" value={value} onChange={(event) => updateProductStoryboardShot(node.id, rowIndex, column.key, event.target.value)} /> : <textarea className="min-h-[118px] w-full resize-none rounded-[6px] border border-white/8 bg-transparent p-2 leading-6 text-white outline-none focus:border-white/28" value={value} onChange={(event) => updateProductStoryboardShot(node.id, rowIndex, column.key, event.target.value)} />}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

function renderProductScriptFullscreen() {
    const node = productScriptFullscreenNodeId ? nodeMap.get(productScriptFullscreenNodeId) : null;
    if (!node || node.type !== "script") return null;
    const workflow = getProductScriptWorkflow(node);
    const steps = [
      { step: 1 as ProductScriptStep, title: "确认镜头", subtitle: (workflow.viralAnalysis?.rows?.length || 0) + " 个镜头已就绪" },
      { step: 2 as ProductScriptStep, title: "准备资产", subtitle: workflow.assets.filter((asset) => asset.imageUrl).length + "/3 已上传" },
      { step: 3 as ProductScriptStep, title: "合成提示词", subtitle: (workflow.storyboard?.rows?.length || 0) + " 个分镜已合成" },
    ];
    return (
      <div data-fixed-ui className="absolute inset-0 z-[190] bg-black/94 text-white backdrop-blur-[3px]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex h-[96px] items-center justify-between border-b border-[#202124] px-9">
          <div className="flex flex-1 justify-center gap-10">
            {steps.map((item, index) => (
              <Fragment key={item.step}>
                <button className={"flex min-w-[220px] items-center gap-4 rounded-[14px] px-4 py-3 text-left transition " + (workflow.step === item.step ? "bg-white/8" : "opacity-58 hover:bg-white/6 hover:opacity-100")} onClick={() => saveProductScriptWorkflow(node.id, (current) => ({ ...current, step: item.step }))}>
                  <span className={"flex h-12 w-12 items-center justify-center rounded-full text-[20px] font-bold " + (workflow.step === item.step ? "bg-white text-black" : "border border-white/24 text-white")}>{item.step}</span>
                  <span><span className="block text-[18px] font-semibold">{item.title}</span><span className="mt-1 block text-[13px] text-white/48">{item.subtitle}</span></span>
                </button>
                {index < steps.length - 1 ? <div className="mt-8 h-px w-36 bg-white/16" /> : null}
              </Fragment>
            ))}
          </div>
          <div className="flex items-center gap-4">
            <div className="text-[15px] font-semibold text-white/76">{workflow.step}/3 完成后可批量生成视频</div>
            <button className="flex h-10 w-10 items-center justify-center rounded-full text-[#9fa3aa] hover:bg-white/8 hover:text-white" onClick={() => setProductScriptFullscreenNodeId(null)}><X className="h-6 w-6" /></button>
          </div>
        </div>
        {workflow.step === 1 ? (
          <div className="px-9 pb-8 pt-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-[22px] font-semibold">爆款镜头拆解</div>
                <div className="mt-1 text-[14px] text-white/48">可编辑每个镜头的节奏、画面、景别、运镜、光线和卖点表达方式。</div>
              </div>
              <div className="flex gap-3">
                <button className="rounded-[12px] border border-white/12 px-5 py-3 text-[15px] font-semibold text-white/82 hover:bg-white/8" onClick={() => openProductScriptVideoUpload(node.id)}>重新上传</button>
                <button className="rounded-[12px] bg-white px-5 py-3 text-[15px] font-semibold text-black disabled:opacity-45" disabled={!workflow.viralAnalysis?.rows?.length} onClick={() => saveProductScriptWorkflow(node.id, (current) => ({ ...current, step: 2 }))}>下一步：准备资产</button>
              </div>
            </div>
            {workflow.stage === "analyzing-viral" || workflow.stage === "uploading" ? renderProductScriptSkeleton(workflow) : renderEditableProductViralTable(node, workflow)}
          </div>
        ) : null}
        {workflow.step === 2 ? renderProductAssetsEditor(node, workflow) : null}
        {workflow.step === 3 ? renderProductStoryboardEditor(node, workflow) : null}
        <div className="absolute bottom-0 left-0 right-0 flex h-[72px] items-center justify-between border-t border-white/8 bg-[#141414]/96 px-9">
          <div className="text-[14px] text-white/52">流程：爆款视频拆解 → 我们产品解析 → 产品化镜头语言 → 产品分镜 → 生成视频</div>
          <div className="flex items-center gap-3">
            {workflow.step === 2 && workflow.productAnalysis ? <button className="rounded-[12px] bg-white px-6 py-3 text-[15px] font-semibold text-black" onClick={() => void submitProductStoryboardCompose(node.id)}>生成产品分镜</button> : null}
            {workflow.step === 3 && workflow.storyboard?.rows?.length ? <button className="rounded-[12px] bg-white px-6 py-3 text-[15px] font-semibold text-black disabled:opacity-45" disabled={workflow.stage === "generating-video"} onClick={() => void generateProductScriptVideos(node.id)}>{workflow.stage === "generating-video" ? "视频生成中..." : "生成视频"}</button> : null}
          </div>
        </div>
      </div>
    );
  }
  return { renderProductScriptProgressChip, renderProductScriptSkeleton, renderProductScriptMiniSteps, renderProductScriptNode, renderEditableProductViralTable, renderProductAssetsEditor, renderProductStoryboardEditor, renderProductScriptFullscreen };
}
