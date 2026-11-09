import { isValueVideoModel } from "../videoFulfillment/valueVideo";
import { createContext, useContext, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Boxes,
  CheckCircle2,
  CircleDollarSign,
  GitBranch,
  MonitorUp,
  Replace,
  Rocket,
  ScanLine,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { endpointPricingUnits, type ModelRouteTier } from "../modelOperations/types";
import type { RouteCanvasNode, RouteCanvasNodeData, StrategyEntry } from "./types";

interface RouteCanvasActions {
  patchNode: (nodeId: string, patch: Partial<RouteCanvasNodeData>) => void;
  patchStrategyEntry: (nodeId: string, sourceNodeId: string, patch: Partial<StrategyEntry>) => void;
  upscaleChannels: ReadonlyArray<{ id: string; name: string; provider: string; available: boolean }>;
}

const RouteCanvasActionsContext = createContext<RouteCanvasActions | null>(null);

export function RouteCanvasActionsProvider({ actions, children }: { actions: RouteCanvasActions; children: ReactNode }) {
  return <RouteCanvasActionsContext.Provider value={actions}>{children}</RouteCanvasActionsContext.Provider>;
}

function useRouteCanvasActions() {
  const value = useContext(RouteCanvasActionsContext);
  if (!value) throw new Error("RouteCanvasActionsProvider is missing");
  return value;
}

function Port({ type, position }: { type: "source" | "target"; position: Position }) {
  return <Handle className="routeCanvasPort" type={type} position={position} />;
}

function NodeShell({
  nodeId,
  data,
  icon,
  children,
  input = true,
  output = true,
  className = "",
}: {
  nodeId: string;
  data: RouteCanvasNodeData;
  icon: ReactNode;
  children?: ReactNode;
  input?: boolean;
  output?: boolean;
  className?: string;
}) {
  return (
    <article className={`routeNode routeNode--${data.kind} ${className}`} data-node-id={nodeId}>
      {input ? <Port type="target" position={Position.Left} /> : null}
      <header className="routeNode__header">
        <span className="routeNode__icon" aria-hidden="true">{icon}</span>
        <div>
          <strong>{data.title}</strong>
          {data.subtitle ? <small>{data.subtitle}</small> : null}
        </div>
      </header>
      {children ? <div className="routeNode__body">{children}</div> : null}
      {output ? <Port type="source" position={Position.Right} /> : null}
    </article>
  );
}

export function ModelNode({ id, data }: NodeProps<RouteCanvasNode>) {
  return (
    <NodeShell nodeId={id} data={data} input={false} icon={<Boxes size={16} />}>
      <div className="routeNode__modelName">{data.upstreamModel || data.title}</div>
      <div className="routeNode__meta"><span>{data.channelName || "未命名渠道"}</span><span>{data.provider || "provider"}</span></div>
      <div className="routeNode__tags">
        {data.endpointType === "video_generation" ? <span>{data.nativeResolution || "1080p"} 原生</span> : <span>{data.endpointType || "通用能力"}</span>}
        <span className={`routeNode__health routeNode__health--${data.health || "unknown"}`}>
          {data.health === "unhealthy" ? "不可用" : data.health === "degraded" ? "降级" : "可用"}
        </span>
      </div>
    </NodeShell>
  );
}

export function MappingNode({ id, data }: NodeProps<RouteCanvasNode>) {
  return <NodeShell nodeId={id} data={data} icon={<Replace size={16} />}>
    <p className="routeNode__mappingSummary">统一画幅、时长、首帧和随机种子等字段</p>
    <small className="routeNode__mappingHint">使用供应商渠道中已配置的转换规则</small>
  </NodeShell>;
}

function ResolutionSelect({ nodeId, data, includeFactor = false }: { nodeId: string; data: RouteCanvasNodeData; includeFactor?: boolean }) {
  const { patchNode } = useRouteCanvasActions();
  return (
    <div className="routeNode__fieldRow nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
      <label>
        <span>输入</span>
        <select value={data.sourceResolution || "1080p"} onChange={(event) => patchNode(nodeId, { sourceResolution: event.currentTarget.value as RouteCanvasNodeData["sourceResolution"] })}>
          <option>480p</option><option>720p</option><option>1080p</option><option>2K</option><option>4K</option>
        </select>
      </label>
      {includeFactor ? <label className="routeNode__factor">
        <span>倍率</span>
        <select value={data.upscaleFactor || "1.5"} onChange={(event) => patchNode(nodeId, { upscaleFactor: event.currentTarget.value as RouteCanvasNodeData["upscaleFactor"], title: `超分处理 ×${event.currentTarget.value}` })}>
          <option value="1.5">×1.5</option><option value="2">×2</option><option value="4">×4</option>
        </select>
      </label> : <span className="routeNode__arrow" aria-hidden="true">→</span>}
      <label>
        <span>目标</span>
        <select value={data.targetResolution || "1080p"} onChange={(event) => patchNode(nodeId, { targetResolution: event.currentTarget.value as RouteCanvasNodeData["targetResolution"] })}>
          <option>720p</option><option>1080p</option><option>2K</option>{!includeFactor ? <option>4K</option> : null}
        </select>
      </label>
    </div>
  );
}

export function ResolutionNode({ id, data }: NodeProps<RouteCanvasNode>) {
  return <NodeShell nodeId={id} data={data} icon={<MonitorUp size={16} />}><ResolutionSelect nodeId={id} data={data} /></NodeShell>;
}

export function UpscaleNode({ id, data }: NodeProps<RouteCanvasNode>) {
  const { patchNode, upscaleChannels } = useRouteCanvasActions();
  return <NodeShell nodeId={id} data={data} icon={<Sparkles size={16} />}>
    <ResolutionSelect nodeId={id} data={data} includeFactor />
    <label className="routeNode__singleField nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
      <span>路由专用超分服务</span>
      <select
        value={data.enhanceChannelId || ""}
        onChange={(event) => {
          const channel = upscaleChannels.find((item) => item.id === event.currentTarget.value);
          patchNode(id, {
            enhanceChannelId: event.currentTarget.value,
            enhanceChannelName: channel?.name || "",
          });
        }}
      >
        <option value="">请选择媒体服务</option>
        {upscaleChannels.map((channel) => (
          <option key={channel.id} value={channel.id} disabled={!channel.available}>
            {channel.name} · {channel.provider}{channel.available ? "" : "（不可用）"}
          </option>
        ))}
      </select>
    </label>
    <small className="routeNode__mappingHint">在“媒体服务”页添加密钥，此处仅引用服务。繁境特价版保存后会同时维护 480→720、720→1080 两档。</small>
  </NodeShell>;
}

export function QualityNode({ id, data }: NodeProps<RouteCanvasNode>) {
  const { patchNode } = useRouteCanvasActions();
  return (
    <NodeShell nodeId={id} data={data} icon={<ShieldCheck size={16} />}>
      {data.resolutionAware !== false ? <label className="routeNode__singleField nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
        <span>校验目标</span>
        <select value={data.targetResolution || "1080p"} onChange={(event) => patchNode(id, { targetResolution: event.currentTarget.value as RouteCanvasNodeData["targetResolution"], title: `${event.currentTarget.value} 质量校验` })}>
          <option>720p</option><option>1080p</option><option>2K</option><option>4K</option>
        </select>
      </label> : <div className="routeNode__mappingSummary">校验响应结构、能力合同和可计费输出</div>}
    </NodeShell>
  );
}

export function StrategyNode({ id, data }: NodeProps<RouteCanvasNode>) {
  const { patchStrategyEntry } = useRouteCanvasActions();
  const entries = data.strategyEntries || [];
  return (
    <NodeShell nodeId={id} data={data} icon={<GitBranch size={16} />}>
      <div className="routeNode__strategyList">
        {entries.length ? entries.map((entry) => (
          <div className="routeNode__strategyEntry nodrag nopan" key={entry.sourceNodeId} onPointerDown={(event) => event.stopPropagation()}>
            <div><strong>{entry.channelName}</strong><small>{entry.label}</small></div>
            <select aria-label={`${entry.channelName} 优先级`} value={entry.tier} onChange={(event) => patchStrategyEntry(id, entry.sourceNodeId, { tier: event.currentTarget.value as ModelRouteTier })}>
              <option>P0</option><option>P1</option><option>P2</option>
            </select>
            <label><input aria-label={`${entry.channelName} 权重`} inputMode="numeric" value={entry.weight} onChange={(event) => patchStrategyEntry(id, entry.sourceNodeId, { weight: Number(event.currentTarget.value || 0) })} /><span>%</span></label>
          </div>
        )) : <div className="routeNode__emptyInput">连接两个或更多模型路径</div>}
      </div>
      <p className="routeNode__strategyHint">同优先级按权重分流；不可用时自动切换到下一优先级。</p>
    </NodeShell>
  );
}

export function PublishNode({ id, data }: NodeProps<RouteCanvasNode>) {
  const { patchNode } = useRouteCanvasActions();
  const endpointType = String(data.endpointType || "video_generation");
  const priceUnits = endpointPricingUnits[endpointType] || endpointPricingUnits.video_generation;
  const resolutionAware = endpointType === "video_generation";
  return (
    <NodeShell nodeId={id} data={data} output={false} className={data.status === "ready" ? "is-ready" : ""} icon={<Rocket size={16} />}>
      <div className="routeNode__publishFields nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
        <label><span>用户可见名称</span><input value={data.displayName || ""} onChange={(event) => patchNode(id, { displayName: event.currentTarget.value })} /></label>
        <label><span>模型标识</span><input value={data.publicModel || ""} onChange={(event) => patchNode(id, { publicModel: event.currentTarget.value })} /></label>
        <div className="routeNode__publishGrid">
          {resolutionAware ? <label><span>目标分辨率</span><select value={data.targetResolution || "1080p"} onChange={(event) => patchNode(id, { targetResolution: event.currentTarget.value as RouteCanvasNodeData["targetResolution"] })}><option>720p</option><option>1080p</option>{!isValueVideoModel(String(data.publicModel || "")) ? <><option>2K</option><option>4K</option></> : null}</select></label> : <label><span>能力类型</span><input value={endpointType} disabled /></label>}
          <label><span>状态</span><select value={data.enabled === false ? "draft" : "enabled"} onChange={(event) => patchNode(id, { enabled: event.currentTarget.value === "enabled" })}><option value="enabled">用户可见</option><option value="draft">仅草稿</option></select></label>
        </div>
        <div className="routeNode__priceBox">
          <div><CircleDollarSign size={15} /><strong>发布定价</strong></div>
          <div className="routeNode__priceFields">
            <input aria-label="发布价格" inputMode="decimal" value={data.priceGu || ""} onChange={(event) => patchNode(id, { priceGu: event.currentTarget.value })} />
            <span>GU</span>
            <select aria-label="计费单位" value={data.pricingUnit || priceUnits[0]?.value} onChange={(event) => patchNode(id, { pricingUnit: event.currentTarget.value })}>
              {priceUnits.map((unit) => <option value={unit.value} key={unit.value}>{unit.label}</option>)}
            </select>
          </div>
          {data.pricingUnit === "token" ? <label className="routeNode__reservation"><span>单任务最大预留 Token</span><input inputMode="numeric" value={data.reservationTokens || ""} onChange={(event) => patchNode(id, { reservationTokens: Number(event.currentTarget.value || 0) })} /></label> : null}
          <small>发布后可在“模型管理”统一调整价格或下架</small>
        </div>
      </div>
      <div className="routeNode__publishStatus"><CheckCircle2 size={14} /><span>{data.status === "ready" ? "已发布" : "待校验发布"}</span></div>
    </NodeShell>
  );
}

export const routeCanvasNodeTypes = {
  model: ModelNode,
  mapping: MappingNode,
  resolution: ResolutionNode,
  upscale: UpscaleNode,
  quality: QualityNode,
  strategy: StrategyNode,
  publish: PublishNode,
};

export const routeNodeLibrary = [
  { kind: "mapping" as const, label: "参数映射", description: "平台参数转供应商字段", icon: Replace },
  { kind: "resolution" as const, label: "分辨率适配", description: "原生分辨率映射", icon: MonitorUp },
  { kind: "upscale" as const, label: "超分处理", description: "提升目标分辨率", icon: Sparkles },
  { kind: "quality" as const, label: "输出校验", description: "结构、能力与质量门禁", icon: ScanLine },
  { kind: "strategy" as const, label: "模型组策略", description: "权重与故障切换", icon: GitBranch },
  { kind: "publish" as const, label: "发布目标", description: "名称、能力与定价", icon: Rocket },
];
