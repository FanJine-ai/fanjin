import { isValueVideoModel, valueVideoPair } from "../videoFulfillment/valueVideo";
import type { XYPosition } from "@xyflow/react";
import {
  endpointPricingUnits,
  guToMicros,
  microsToGu,
  type ModelPoolItem,
  type ModelRouteGroup,
  type ModelRouteGroupDraft,
  type ModelRouteTier,
} from "../modelOperations/types";
import { editableLogicalPriceRuleConfig } from "../modelOperations/pricingAudience";
import type {
  RouteCanvasEdge,
  RouteCanvasNode,
  RouteCanvasNodeData,
  RouteCanvasNodeKind,
  RouteResolution,
  StrategyEntry,
} from "./types";

const RESOLUTIONS: RouteResolution[] = ["480p", "720p", "1080p", "2K", "4K"];

function usesVideoResolution(endpointType: unknown) {
  return String(endpointType || "") === "video_generation";
}

function pipelineKind(endpointType: unknown) {
  const value = String(endpointType || "");
  if (value === "video_generation" || value === "video_upscale") return "video";
  if (value === "image_generation") return "image";
  if (value === "tts" || value === "transcription") return "audio";
  if (value === "embedding" || value === "multimodal_embedding") return "embedding";
  if (value === "rerank") return "ranking";
  return "text";
}

function id(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createNode(
  kind: RouteCanvasNodeKind,
  position: XYPosition,
  overrides: Partial<RouteCanvasNodeData> = {},
): RouteCanvasNode {
  const defaults: Record<RouteCanvasNodeKind, RouteCanvasNodeData> = {
    model: { kind, title: "模型实例", subtitle: "来自模型池", endpointType: "video_generation", nativeResolution: "1080p" },
    mapping: { kind, title: "参数映射", subtitle: "平台参数 → 供应商字段" },
    resolution: { kind, title: "分辨率适配", subtitle: "原生输出", sourceResolution: "1080p", targetResolution: "1080p" },
    upscale: { kind, title: "超分处理", subtitle: "提升目标分辨率", sourceResolution: "720p", targetResolution: "1080p", upscaleFactor: "1.5" },
    quality: { kind, title: "质量校验", subtitle: "分辨率与质量检查", targetResolution: "1080p" },
    strategy: { kind, title: "模型组策略", subtitle: "同级权重 · 失败自动切换", strategyEntries: [] },
    publish: {
      kind,
      title: "发布目标",
      subtitle: "用户可见模型",
      displayName: "Fanjin Video Pro",
      publicModel: "fanjin-video-pro",
      targetResolution: "1080p",
      pricingUnit: "video",
      priceGu: "1.00",
      reservationTokens: 0,
      enabled: true,
      status: "draft",
    },
  };
  return {
    id: id(kind),
    type: kind,
    position,
    data: { ...defaults[kind], ...overrides, kind },
  };
}

function edge(source: string, target: string, dashed = false): RouteCanvasEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    type: "smoothstep",
    animated: false,
    style: { stroke: "#0783bd", strokeWidth: 2, ...(dashed ? { strokeDasharray: "7 6" } : {}) },
  };
}

function routeRecipe(routeConfig: Record<string, unknown>) {
  const value = routeConfig.routeRecipe;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resolution(value: unknown, fallback: RouteResolution): RouteResolution {
  const normalized = String(value || "").trim().toLowerCase();
  const canonical = normalized === "480p" ? "480p" : normalized === "2k" ? "2K"
    : normalized === "4k" ? "4K"
      : normalized === "720p" ? "720p"
        : normalized === "1080p" ? "1080p"
          : "";
  return RESOLUTIONS.includes(canonical as RouteResolution) ? canonical as RouteResolution : fallback;
}

function graphFromTargets(input: {
  targets: Array<{
    poolId?: string;
    scope: "platform" | "workspace";
    workspaceId: string | null;
    endpointType: string;
    channelId: string;
    channelName: string;
    provider: string;
    upstreamModel: string;
    health: ModelPoolItem["health"];
    routeTargetId?: string;
    tier: ModelRouteTier;
    weight: number;
    routeConfig?: Record<string, unknown>;
  }>;
  publish: Partial<RouteCanvasNodeData>;
  offsetY?: number;
}): { nodes: RouteCanvasNode[]; edges: RouteCanvasEdge[] } {
  const nodes: RouteCanvasNode[] = [];
  const edges: RouteCanvasEdge[] = [];
  const entries: StrategyEntry[] = [];
  const qualityIds: string[] = [];

  input.targets.forEach((target, index) => {
    const y = (input.offsetY || 0) + 70 + index * 236;
    const recipe = routeRecipe(target.routeConfig || {});
    const sourceResolution = resolution(recipe.sourceResolution, index === 0 ? "1080p" : "720p");
    const targetResolution = resolution(recipe.targetResolution, "1080p");
    const source = createNode("model", { x: 32, y }, {
      title: target.upstreamModel,
      subtitle: "模型实例",
      poolId: target.poolId,
      routeTargetId: target.routeTargetId,
      scope: target.scope,
      workspaceId: target.workspaceId,
      endpointType: target.endpointType,
      channelId: target.channelId,
      channelName: target.channelName,
      provider: target.provider,
      upstreamModel: target.upstreamModel,
      health: target.health,
      nativeResolution: usesVideoResolution(target.endpointType) ? sourceResolution : undefined,
      status: target.health === "unhealthy" ? "warning" : "ready",
    });
    const mapping = createNode("mapping", { x: 250, y: y + 16 }, {
      title: "参数映射",
      subtitle: "平台参数 → 供应商字段",
      endpointType: target.endpointType,
    });
    const isResolutionAware = usesVideoResolution(target.endpointType);
    let quality;
    if (isResolutionAware) {
      const needsUpscale = String(recipe.mode || "") === "upscale" || sourceResolution !== targetResolution;
      const transform = createNode(needsUpscale ? "upscale" : "resolution", { x: 470, y: y + 16 }, {
        title: needsUpscale ? `超分处理 ×${String(recipe.upscaleFactor || "1.5")}` : "分辨率适配",
        subtitle: needsUpscale ? `${sourceResolution} → ${targetResolution}` : `原生 ${sourceResolution} → 目标 ${targetResolution}`,
        sourceResolution,
        targetResolution,
        endpointType: target.endpointType,
        resolutionAware: true,
        upscaleFactor: (String(recipe.upscaleFactor || "1.5") as "1.5" | "2" | "4"),
        enhanceChannelId: needsUpscale ? String(recipe.enhanceChannelId || "") : undefined,
      });
      quality = createNode("quality", { x: 710, y: y + 16 }, {
        title: `${targetResolution} 质量校验`,
        subtitle: "分辨率与质量校验",
        endpointType: target.endpointType,
        resolutionAware: true,
        targetResolution,
      });
      nodes.push(source, mapping, transform, quality);
      edges.push(edge(source.id, mapping.id, target.tier !== "P0"), edge(mapping.id, transform.id, target.tier !== "P0"), edge(transform.id, quality.id, target.tier !== "P0"));
    } else {
      quality = createNode("quality", { x: 560, y: y + 16 }, {
        title: "能力与输出校验",
        subtitle: `${pipelineKind(target.endpointType)} 输出合同`,
        endpointType: target.endpointType,
        resolutionAware: false,
      });
      nodes.push(source, mapping, quality);
      edges.push(edge(source.id, mapping.id, target.tier !== "P0"), edge(mapping.id, quality.id, target.tier !== "P0"));
    }
    qualityIds.push(quality.id);
    entries.push({
      sourceNodeId: source.id,
      label: target.upstreamModel,
      channelName: target.channelName,
      tier: target.tier,
      weight: target.weight,
    });
  });

  const publishX = usesVideoResolution(input.targets[0]?.endpointType)
    ? input.targets.length > 1 ? 1185 : 940
    : input.targets.length > 1 ? 1035 : 790;
  const publish = createNode("publish", { x: publishX, y: (input.offsetY || 0) + 145 }, input.publish);
  if (input.targets.length > 1) {
    const strategyX = usesVideoResolution(input.targets[0]?.endpointType) ? 940 : 790;
    const strategy = createNode("strategy", { x: strategyX, y: (input.offsetY || 0) + 128 }, { strategyEntries: entries });
    nodes.push(strategy);
    qualityIds.forEach((qualityId, index) => edges.push(edge(qualityId, strategy.id, entries[index].tier !== "P0")));
    edges.push(edge(strategy.id, publish.id));
  } else if (qualityIds[0]) {
    edges.push(edge(qualityIds[0], publish.id));
  }
  nodes.push(publish);
  return { nodes, edges };
}

export function createGraphFromGroup(group: ModelRouteGroup, pool: ModelPoolItem[]) {
  const poolByBinding = new Map(pool.map((item) => [`${item.channelId}|${item.upstreamModel}`, item]));
  const targets = group.targets.map((target) => {
    const poolItem = poolByBinding.get(`${target.channelId}|${target.upstreamModel}`);
    return {
      poolId: poolItem?.poolId,
      routeTargetId: target.id,
      scope: group.scope,
      workspaceId: group.workspaceId,
      endpointType: group.endpointType,
      channelId: target.channelId,
      channelName: target.channelName,
      provider: target.provider,
      upstreamModel: target.upstreamModel,
      health: target.health,
      tier: target.tier,
      weight: target.trafficWeight,
      routeConfig: target.routeConfig,
    };
  });
  const firstRecipe = routeRecipe(group.targets[0]?.routeConfig || {});
  return graphFromTargets({
    targets,
    publish: {
      displayName: group.displayName,
      publicModel: group.publicModel,
      endpointType: group.endpointType,
      targetResolution: resolution(firstRecipe.targetResolution, "1080p"),
      pricingUnit: group.pricing?.unit || endpointPricingUnits[group.endpointType]?.[0]?.value || "task",
      priceGu: group.pricing ? microsToGu(group.pricing.unitPriceMicros, group.pricing.unit).split(",").join("") : "",
      reservationTokens: Number(group.pricing?.ruleConfig?.reservationUpperBoundTokens || 0),
      pricingRuleConfig: editableLogicalPriceRuleConfig(group.pricing?.ruleConfig),
      enabled: !group.disabled,
      existingGroupKey: group.groupKey,
      status: ["published", "degraded"].includes(group.publication.status) ? "ready" : "draft",
    },
  });
}

export function createStarterGraph(pool: ModelPoolItem[], sourcePoolId?: string | null) {
  if (!pool.length) return { nodes: [] as RouteCanvasNode[], edges: [] as RouteCanvasEdge[] };
  const selected = sourcePoolId ? pool.find((item) => item.poolId === sourcePoolId) : pool.find((item) => item.endpointType === "video_generation") || pool[0];
  if (!selected) return { nodes: [] as RouteCanvasNode[], edges: [] as RouteCanvasEdge[] };
  const matching = sourcePoolId
    ? [selected]
    : pool.filter((item) => item.endpointType === selected.endpointType && item.upstreamModel === selected.upstreamModel).slice(0, 2);
  return graphFromTargets({
    targets: matching.map((item, index) => ({
      ...item,
      tier: "P0" as const,
      weight: index === 0 ? 70 : 30,
      routeConfig: { routeRecipe: usesVideoResolution(item.endpointType)
        ? index === 0
          ? { schemaVersion: 1, pipelineKind: "video", parameterMapping: true, mode: "native", sourceResolution: "1080p", targetResolution: "1080p", qualityGate: true }
          : { schemaVersion: 1, pipelineKind: "video", parameterMapping: true, mode: "upscale", sourceResolution: "720p", targetResolution: "1080p", upscaleFactor: "1.5", qualityGate: true }
        : { schemaVersion: 1, pipelineKind: pipelineKind(item.endpointType), parameterMapping: true, qualityGate: true } },
    })),
    publish: {
      displayName: selected.upstreamModel,
      publicModel: selected.upstreamModel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "public-model",
      endpointType: selected.endpointType,
      targetResolution: "1080p",
      pricingUnit: endpointPricingUnits[selected.endpointType]?.[0]?.value || "task",
      priceGu: sourcePoolId ? "1.00" : "",
      enabled: Boolean(sourcePoolId),
    },
  });
}

export function createGraphFromGroups(groups: ModelRouteGroup[], pool: ModelPoolItem[]) {
  const documents: Array<{ nodes: RouteCanvasNode[]; edges: RouteCanvasEdge[] }> = [];
  let offsetY = 0;
  for (const group of groups) {
    const graph = createGraphFromGroup(group, pool);
    graph.nodes = graph.nodes.map((node) => ({ ...node, position: { ...node.position, y: node.position.y + offsetY } }));
    documents.push(graph);
    offsetY += Math.max(360, group.targets.length * 236 + 150);
  }

  // A default route belongs to the public model identity, not to every
  // provider copy. Once that identity already has an explicit route, other
  // same-name channel models remain available in the pool library so an
  // operator can intentionally add them to the existing strategy group.
  const routedIdentities = new Set(groups.map((group) => (
    [group.scope, group.workspaceId || "", group.endpointType, group.publicModel].join("|")
  )));
  const unrouted = pool.filter((item) => (
    item.routedGroupKeys.length === 0
    && !routedIdentities.has([item.scope, item.workspaceId || "", item.endpointType, item.upstreamModel].join("|"))
  ));
  const defaults = new Map<string, ModelPoolItem[]>();
  for (const item of unrouted) {
    const key = [item.scope, item.workspaceId || "", item.endpointType, item.upstreamModel].join("|");
    defaults.set(key, [...(defaults.get(key) || []), item]);
  }
  for (const items of defaults.values()) {
    const selected = items[0];
    const graph = graphFromTargets({
      offsetY,
      targets: items.map((item) => ({
        ...item,
        tier: "P0" as const,
        weight: 100,
        routeConfig: { routeRecipe: usesVideoResolution(item.endpointType)
          ? { schemaVersion: 1, pipelineKind: "video", parameterMapping: true, mode: "native", sourceResolution: "1080p", targetResolution: "1080p", qualityGate: true }
          : { schemaVersion: 1, pipelineKind: pipelineKind(item.endpointType), parameterMapping: true, qualityGate: true } },
      })),
      publish: {
        displayName: selected.upstreamModel,
        publicModel: selected.upstreamModel,
        endpointType: selected.endpointType,
        targetResolution: usesVideoResolution(selected.endpointType) ? "1080p" : undefined,
        pricingUnit: endpointPricingUnits[selected.endpointType]?.[0]?.value || "task",
        priceGu: "",
        enabled: false,
        status: "draft",
      },
    });
    documents.push(graph);
    offsetY += Math.max(360, items.length * 236 + 150);
  }
  return {
    nodes: documents.flatMap((document) => document.nodes),
    edges: documents.flatMap((document) => document.edges),
  };
}

function ancestors(nodeId: string, nodes: RouteCanvasNode[], edges: RouteCanvasEdge[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const result = new Set<string>();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    edges.filter((candidate) => candidate.target === current).forEach((candidate) => {
      if (result.has(candidate.source)) return;
      result.add(candidate.source);
      queue.push(candidate.source);
    });
  }
  return [...result].map((candidate) => nodeById.get(candidate)).filter(Boolean) as RouteCanvasNode[];
}

function descendants(nodeId: string, nodes: RouteCanvasNode[], edges: RouteCanvasEdge[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const result = new Set<string>();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    edges.filter((candidate) => candidate.source === current).forEach((candidate) => {
      if (result.has(candidate.target)) return;
      result.add(candidate.target);
      queue.push(candidate.target);
    });
  }
  return [...result].map((candidate) => nodeById.get(candidate)).filter(Boolean) as RouteCanvasNode[];
}

function hasCycle(nodes: RouteCanvasNode[], edges: RouteCanvasEdge[]) {
  const adjacency = new Map<string, string[]>();
  edges.forEach((candidate) => adjacency.set(candidate.source, [...(adjacency.get(candidate.source) || []), candidate.target]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    if ((adjacency.get(nodeId) || []).some(visit)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}

function branchRecipe(sourceId: string, publishId: string, nodes: RouteCanvasNode[], edges: RouteCanvasEdge[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const publishAncestors = new Set(ancestors(publishId, nodes, edges).map((node) => node.id));
  publishAncestors.add(publishId);
  const pathNodes: RouteCanvasNode[] = [];
  const queue = [sourceId];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = nodeById.get(current);
    if (node) pathNodes.push(node);
    if (current === publishId) break;
    edges
      .filter((candidate) => candidate.source === current && publishAncestors.has(candidate.target))
      .forEach((candidate) => queue.push(candidate.target));
  }
  const source = nodeById.get(sourceId)!;
  const transform = pathNodes.find((node) => node.data.kind === "upscale" || node.data.kind === "resolution");
  const quality = pathNodes.find((node) => node.data.kind === "quality");
  const endpointType = String(source.data.endpointType || "text");
  const common = {
    schemaVersion: 2,
    pipelineKind: pipelineKind(endpointType),
    parameterMapping: pathNodes.some((node) => node.data.kind === "mapping"),
    qualityGate: Boolean(quality),
  };
  if (!usesVideoResolution(endpointType)) return common;
  return {
    ...common,
    mode: transform?.data.kind === "upscale" ? "upscale" : "native",
    sourceResolution: transform?.data.sourceResolution || source.data.nativeResolution || "1080p",
    targetResolution: transform?.data.targetResolution || quality?.data.targetResolution || "1080p",
    ...(transform?.data.kind === "upscale" ? {
      upscaleFactor: transform.data.upscaleFactor || "1.5",
      enhanceChannelId: String(transform.data.enhanceChannelId || ""),
    } : {}),
  };
}

export interface CanvasValidationIssue {
  nodeId?: string;
  message: string;
}

export function validateCanvas(nodes: RouteCanvasNode[], edges: RouteCanvasEdge[]): CanvasValidationIssue[] {
  const issues: CanvasValidationIssue[] = [];
  const publishes = nodes.filter((node) => node.data.kind === "publish");
  if (!publishes.length) issues.push({ message: "至少需要一个发布目标节点。" });
  if (hasCycle(nodes, edges)) issues.push({ message: "画布存在循环连线，请保持路由从模型实例单向流向发布目标。" });
  const publicModels = new Set<string>();
  publishes.forEach((publish) => {
    const publicModel = String(publish.data.publicModel || "").trim();
    if (!String(publish.data.displayName || "").trim()) issues.push({ nodeId: publish.id, message: "发布目标缺少用户可见名称。" });
    if (!publicModel) issues.push({ nodeId: publish.id, message: "发布目标缺少公开模型标识。" });
    const publicIdentity = `${String(publish.data.endpointType || "")}|${publicModel}`;
    if (publicModel && publicModels.has(publicIdentity)) issues.push({ nodeId: publish.id, message: `同一能力下的公开模型标识 ${publicModel} 在画布中重复。` });
    publicModels.add(publicIdentity);
    if (publish.data.enabled !== false && Number(publish.data.priceGu || 0) <= 0) issues.push({ nodeId: publish.id, message: "用户可见的发布目标价格必须大于 0。" });
    if (publish.data.enabled !== false && String(publish.data.endpointType) === "video_generation" && publish.data.pricingUnit === "token" && (!Number.isSafeInteger(Number(publish.data.reservationTokens)) || Number(publish.data.reservationTokens) <= 0)) {
      issues.push({ nodeId: publish.id, message: "视频 Token 定价必须设置单任务最大预留 Token。" });
    }
    const incoming = edges.filter((candidate) => candidate.target === publish.id);
    if (incoming.length !== 1) issues.push({ nodeId: publish.id, message: "发布目标必须且只能连接一个最终输入。" });
    const graphAncestors = ancestors(publish.id, nodes, edges);
    const sources = graphAncestors.filter((node) => node.data.kind === "model");
    if (!sources.length) issues.push({ nodeId: publish.id, message: "发布目标尚未连接模型实例。" });
    const finalInput = nodes.find((node) => node.id === incoming[0]?.source);
    if (sources.length > 1 && finalInput?.data.kind !== "strategy") {
      issues.push({ nodeId: publish.id, message: "多个模型输入必须先经过模型组策略节点。" });
    }
    if (sources.some((source) => source.data.health === "unhealthy")) {
      issues.push({ nodeId: publish.id, message: "路由包含不可用的模型实例。" });
    }
    const endpointTypes = new Set(sources.map((source) => String(source.data.endpointType || "")));
    if (endpointTypes.size > 1) issues.push({ nodeId: publish.id, message: "同一发布目标连接了不同能力类型的模型实例。" });
    const scopes = new Set(sources.map((source) => `${source.data.scope || "platform"}|${source.data.workspaceId || ""}`));
    if (scopes.size > 1) issues.push({ nodeId: publish.id, message: "同一发布目标连接了不同作用域的模型实例。" });
    const pricingUnits = endpointPricingUnits[String(sources[0]?.data.endpointType || "")] || [];
    if (publish.data.pricingUnit && !pricingUnits.some((unit) => unit.value === publish.data.pricingUnit)) {
      issues.push({ nodeId: publish.id, message: "发布目标计费单位不适用于当前模型能力。" });
    }
    const strategyEntries = finalInput?.data.kind === "strategy" ? finalInput.data.strategyEntries || [] : [];
    if (strategyEntries.some((entry) => !Number.isInteger(entry.weight) || entry.weight < 1 || entry.weight > 1000)) {
      issues.push({ nodeId: finalInput?.id, message: "模型组权重必须是 1–1000 的整数。" });
    }
    sources.forEach((source) => {
      const pathNodes = descendants(source.id, nodes, edges).filter((node) => graphAncestors.some((candidate) => candidate.id === node.id) || node.id === publish.id);
      const hasMapping = pathNodes.some((node) => node.data.kind === "mapping");
      const transform = pathNodes.find((node) => node.data.kind === "resolution" || node.data.kind === "upscale");
      const quality = pathNodes.find((node) => node.data.kind === "quality");
      const resolutionRequired = usesVideoResolution(source.data.endpointType);
      if (!hasMapping || !quality || (resolutionRequired && !transform)) {
        issues.push({ nodeId: source.id, message: resolutionRequired
          ? `${source.data.channelName || source.data.title} 的路径必须依次包含参数映射、分辨率处理和质量校验。`
          : `${source.data.channelName || source.data.title} 的路径必须包含参数映射和能力输出校验。` });
        return;
      }
      const publishResolution = publish.data.targetResolution || "1080p";
      if (resolutionRequired && (transform?.data.targetResolution !== publishResolution || quality.data.targetResolution !== publishResolution)) {
        issues.push({ nodeId: source.id, message: `${source.data.channelName || source.data.title} 的路径输出分辨率与发布目标不一致。` });
      }
      const valuePair = valueVideoPair(publicModel, publishResolution);
      if (isValueVideoModel(publicModel) && (!valuePair || transform?.data.kind !== "upscale" || transform.data.sourceResolution !== valuePair.source)) {
        issues.push({ nodeId: publish.id, message: "繁境特价版仅支持 480p＋大模型版超分→720p、720p＋大模型版超分→1080p；保存时同时维护两档。" });
      }
      if (transform?.data.kind === "upscale" && transform.data.targetResolution === "4K") {
        issues.push({ nodeId: transform.id, message: "MediaKit 大模型版不支持 4K 输出。" });
      }
      if (transform?.data.kind === "upscale" && !String(transform.data.enhanceChannelId || "").trim()) {
        issues.push({ nodeId: transform.id, message: "超分处理节点必须显式选择当前路由使用的媒体服务。" });
      }
    });
  });
  return issues;
}

export function buildDrafts(nodes: RouteCanvasNode[], edges: RouteCanvasEdge[]): ModelRouteGroupDraft[] {
  const issues = validateCanvas(nodes, edges);
  if (issues.length) throw new Error(issues[0].message);
  return nodes.filter((node) => node.data.kind === "publish").map((publish) => {
    const graphAncestors = ancestors(publish.id, nodes, edges);
    const sources = graphAncestors.filter((node) => node.data.kind === "model");
    const strategy = graphAncestors.find((node) => node.data.kind === "strategy");
    const entries = new Map((strategy?.data.strategyEntries || []).map((entry) => [entry.sourceNodeId, entry]));
    const first = sources[0];
    const pricingUnit = String(publish.data.pricingUnit || endpointPricingUnits[String(first.data.endpointType)]?.[0]?.value || "task");
    const pricingRuleConfig = editableLogicalPriceRuleConfig(publish.data.pricingRuleConfig);
    if (pricingUnit === "token" && Number(publish.data.reservationTokens || 0) > 0) {
      pricingRuleConfig.reservationUpperBoundTokens = Math.round(Number(publish.data.reservationTokens));
    } else {
      delete pricingRuleConfig.reservationUpperBoundTokens;
    }
    return {
      existingGroupKey: publish.data.existingGroupKey || null,
      scope: first.data.scope || "platform",
      workspaceId: first.data.scope === "workspace" ? first.data.workspaceId || null : null,
      endpointType: String(first.data.endpointType || "video_generation"),
      publicModel: String(publish.data.publicModel || "").trim(),
      displayName: String(publish.data.displayName || "").trim(),
      disabled: publish.data.enabled === false,
      targets: sources.map((source, index) => {
        const config = entries.get(source.id);
        return {
          id: source.data.routeTargetId || null,
          channelId: String(source.data.channelId || ""),
          upstreamModel: String(source.data.upstreamModel || source.data.title || ""),
          tier: config?.tier || "P0",
          trafficWeight: Math.max(1, Math.min(1000, Math.round(config?.weight || (sources.length === 1 ? 100 : 1)))),
          routeRecipe: branchRecipe(source.id, publish.id, nodes, edges),
        };
      }),
      pricing: publish.data.enabled === false && Number(publish.data.priceGu || 0) <= 0 ? null : {
        unit: pricingUnit,
        unitPriceMicros: guToMicros(String(publish.data.priceGu || ""), pricingUnit),
        currency: "GU",
        ruleConfig: pricingRuleConfig,
      },
    } as ModelRouteGroupDraft;
  });
}

export function deriveStrategyEntries(
  strategy: RouteCanvasNode,
  nodes: RouteCanvasNode[],
  edges: RouteCanvasEdge[],
): StrategyEntry[] {
  const existing = new Map((strategy.data.strategyEntries || []).map((entry) => [entry.sourceNodeId, entry]));
  return ancestors(strategy.id, nodes, edges)
    .filter((node) => node.data.kind === "model")
    .sort((left, right) => left.position.y - right.position.y)
    .map((source, index) => ({
      sourceNodeId: source.id,
      label: String(source.data.upstreamModel || source.data.title),
      channelName: String(source.data.channelName || source.data.provider || "未命名渠道"),
      tier: existing.get(source.id)?.tier || "P0",
      weight: existing.get(source.id)?.weight || (index === 0 ? 70 : 30),
    }));
}
