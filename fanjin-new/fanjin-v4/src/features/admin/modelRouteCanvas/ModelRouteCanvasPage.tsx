import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type OnConnectEnd,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Clock3,
  GripVertical,
  History,
  Layers3,
  Menu,
  PackageCheck,
  RefreshCcw,
  Save,
  Search,
  X,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, ConfirmDialog, Drawer, Tabs, useToast } from "../../../ui/console";
import { preflightModelRouteGroup, saveModelRouteGroup } from "../modelOperations/api";
import { listMediaServices, type MediaService } from "../mediaServices/api";
import { useModelOperations } from "../modelOperations/hooks";
import {
  endpointLabels,
  endpointPricingUnits,
  microsToGu,
  type ModelPoolItem,
  type ModelRouteGroup,
} from "../modelOperations/types";
import {
  buildDrafts,
  createGraphFromGroup,
  createGraphFromGroups,
  createNode,
  createStarterGraph,
  deriveStrategyEntries,
  validateCanvas,
} from "./graph";
import { RouteCanvasActionsProvider, routeCanvasNodeTypes, routeNodeLibrary } from "./RouteCanvasNodes";
import type {
  RouteCanvasDocument,
  RouteCanvasEdge,
  RouteCanvasNode,
  RouteCanvasNodeData,
  RouteCanvasNodeKind,
  RouteResolution,
  RouteCanvasSnapshot,
  StrategyEntry,
} from "./types";
import "./modelRouteCanvas.css";

const STORAGE_KEY = "fanjin:model-route-canvas:v2";
const DRAG_TYPE = "application/x-fanjin-route-node";

type DragPayload = { type: "pool"; poolId: string } | { type: "node"; kind: RouteCanvasNodeKind };

interface ConnectionNodePickerState {
  sourceNodeId: string;
  kinds: RouteCanvasNodeKind[];
  nodePosition: { x: number; y: number };
  menuPosition: { x: number; y: number };
}

const nextNodeKinds: Partial<Record<RouteCanvasNodeKind, RouteCanvasNodeKind[]>> = {
  model: ["mapping"],
  mapping: ["quality"],
  resolution: ["quality"],
  upscale: ["quality"],
  quality: ["strategy", "publish"],
  strategy: ["publish"],
};

const nodeEstimatedHeights: Partial<Record<RouteCanvasNodeKind, number>> = {
  mapping: 102,
  resolution: 112,
  upscale: 112,
  quality: 106,
  strategy: 154,
  publish: 330,
};

function compatibleNextKinds(node: RouteCanvasNode) {
  if (node.data.kind !== "mapping") return nextNodeKinds[node.data.kind] || [];
  return String(node.data.endpointType || "") === "video_generation"
    ? ["resolution", "upscale"] as RouteCanvasNodeKind[]
    : ["quality"] as RouteCanvasNodeKind[];
}

function connectEndClientPoint(event: MouseEvent | TouchEvent) {
  if ("changedTouches" in event) {
    const touch = event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return { x: event.clientX, y: event.clientY };
}

function upstreamContext(sourceNodeId: string, nodes: RouteCanvasNode[], edges: RouteCanvasEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const source = byId.get(sourceNodeId);
  const visited = new Set<string>();
  const queue = source ? [source] : [];
  while (queue.length) {
    const current = queue.shift()!;
    const endpointType = String(current.data.endpointType || "");
    if (current.data.kind === "model" || endpointType) {
      return {
        endpointType: endpointType || "video_generation",
        resolution: (current.data.targetResolution || current.data.nativeResolution || "1080p") as RouteResolution,
      };
    }
    edges.filter((edge) => edge.target === current.id).forEach((edge) => {
      if (visited.has(edge.source)) return;
      visited.add(edge.source);
      const parent = byId.get(edge.source);
      if (parent) queue.push(parent);
    });
  }
  return { endpointType: "video_generation", resolution: "1080p" as RouteResolution };
}

function nextResolution(value: RouteResolution) {
  if (value === "720p") return "1080p" as const;
  if (value === "1080p") return "2K" as const;
  return "4K" as const;
}

function readDocument(): RouteCanvasDocument | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<RouteCanvasDocument>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return { schemaVersion: 1, nodes: parsed.nodes, edges: parsed.edges, snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [] };
  } catch {
    return null;
  }
}

function writeDocument(document: RouteCanvasDocument) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
}

function publicModelFromName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "public-model";
}

function sourceNodeFromPool(item: ModelPoolItem, position: { x: number; y: number }): RouteCanvasNode {
  return createNode("model", position, {
    title: item.upstreamModel,
    subtitle: "模型实例",
    poolId: item.poolId,
    scope: item.scope,
    workspaceId: item.workspaceId,
    endpointType: item.endpointType,
    channelId: item.channelId,
    channelName: item.channelName,
    provider: item.provider,
    upstreamModel: item.upstreamModel,
    health: item.health,
    nativeResolution: item.endpointType === "video_generation" ? "1080p" : undefined,
    status: item.health === "unhealthy" ? "warning" : "ready",
  });
}

function sameEntries(left: StrategyEntry[] | undefined, right: StrategyEntry[]) {
  return JSON.stringify(left || []) === JSON.stringify(right);
}

function edgeIdsBetween(sourceNodeId: string, targetNodeId: string, edges: RouteCanvasEdge[]) {
  const fromSource = new Set([sourceNodeId]);
  const forwardQueue = [sourceNodeId];
  while (forwardQueue.length) {
    const current = forwardQueue.shift()!;
    edges.filter((edge) => edge.source === current).forEach((edge) => {
      if (fromSource.has(edge.target)) return;
      fromSource.add(edge.target);
      forwardQueue.push(edge.target);
    });
  }
  const toTarget = new Set([targetNodeId]);
  const reverseQueue = [targetNodeId];
  while (reverseQueue.length) {
    const current = reverseQueue.shift()!;
    edges.filter((edge) => edge.target === current).forEach((edge) => {
      if (toTarget.has(edge.source)) return;
      toTarget.add(edge.source);
      reverseQueue.push(edge.source);
    });
  }
  return new Set(edges.filter((edge) => fromSource.has(edge.source) && toTarget.has(edge.target)).map((edge) => edge.id));
}

function endpointTypeForPublish(nodeId: string, nodes: RouteCanvasNode[], edges: RouteCanvasEdge[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const candidate of edges.filter((edge) => edge.target === current)) {
      if (visited.has(candidate.source)) continue;
      visited.add(candidate.source);
      const source = nodeById.get(candidate.source);
      if (source?.data.kind === "model" && source.data.endpointType) return String(source.data.endpointType);
      queue.push(candidate.source);
    }
  }
  return "";
}

function ModelPoolCard({ item, onDragStart, onActivate }: { item: ModelPoolItem; onDragStart: (event: DragEvent, payload: DragPayload) => void; onActivate: (payload: DragPayload) => void }) {
  return (
    <button
      type="button"
      className="routePaletteModel"
      draggable
      onDragStart={(event) => onDragStart(event, { type: "pool", poolId: item.poolId })}
      onClick={() => onActivate({ type: "pool", poolId: item.poolId })}
      title="拖到画布创建模型实例"
    >
      <GripVertical size={15} aria-hidden="true" />
      <span className="routePaletteModel__copy">
        <strong>{item.upstreamModel}</strong>
        <small>{item.channelName} · {item.provider}</small>
      </span>
      <span className={`routePaletteModel__health routePaletteModel__health--${item.health}`} aria-label={`健康状态：${item.health}`} />
    </button>
  );
}

function RouteCanvasContent() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const state = useModelOperations();
  const { toast } = useToast();
  const [nodes, setNodes, onNodesChange] = useNodesState<RouteCanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RouteCanvasEdge>([]);
  const [flow, setFlow] = useState<ReactFlowInstance<RouteCanvasNode, RouteCanvasEdge> | null>(null);
  const [paletteTab, setPaletteTab] = useState("pool");
  const [query, setQuery] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [publishedTargetsOpen, setPublishedTargetsOpen] = useState(false);
  const [publishedTargetQuery, setPublishedTargetQuery] = useState("");
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<ModelRouteGroup | "overview" | null>(null);
  const [connectionNodePicker, setConnectionNodePicker] = useState<ConnectionNodePickerState | null>(null);
  const [snapshots, setSnapshots] = useState<RouteCanvasSnapshot[]>([]);
  const [canvasError, setCanvasError] = useState("");
  const dragDepth = useRef(0);
  const initialFitState = useRef<"idle" | "scheduled" | "done">("idle");
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const connectionNodePickerRef = useRef<HTMLDivElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    document.body.classList.add("routeCanvasImmersiveMode");
    return () => document.body.classList.remove("routeCanvasImmersiveMode");
  }, []);

  useEffect(() => {
    if (!connectionNodePicker) return;
    const focusTimer = window.setTimeout(() => {
      connectionNodePickerRef.current?.querySelector<HTMLButtonElement>(".routeConnectionNodePicker__list > button")?.focus();
    }, 0);
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!connectionNodePickerRef.current?.contains(event.target as globalThis.Node)) setConnectionNodePicker(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConnectionNodePicker(null);
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [connectionNodePicker]);

  useEffect(() => {
    if (initialized || state.loading) return;
    const stored = readDocument();
    if (stored?.nodes.length && searchParams.get("draft") === "local") {
      setNodes(stored.nodes);
      setEdges(stored.edges);
      setSnapshots(stored.snapshots);
    } else if (searchParams.get("sourcePoolId")) {
      const graph = createStarterGraph(state.pool, searchParams.get("sourcePoolId"));
      setNodes(graph.nodes);
      setEdges(graph.edges);
    } else {
      const graph = createGraphFromGroups(state.groups, state.pool);
      setNodes(graph.nodes);
      setEdges(graph.edges);
    }
    setInitialized(true);
    setDirty(false);
  }, [initialized, searchParams, setEdges, setNodes, state.groups, state.loading, state.pool]);

  useEffect(() => {
    if (
      !initialized
      || !flow
      || !nodes.length
      || initialFitState.current !== "idle"
    ) return;
    initialFitState.current = "scheduled";
    let secondFrame = 0;
    let readableZoomTimer = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const minimumReadableZoom = window.innerWidth >= 1280 ? 0.62 : 0.5;
        void flow.fitView({
          padding: 0.14,
          minZoom: minimumReadableZoom,
          maxZoom: 0.9,
          duration: 0,
        });
        readableZoomTimer = window.setTimeout(() => {
          const currentZoom = flow.getZoom?.() ?? minimumReadableZoom;
          if (currentZoom < minimumReadableZoom) {
            void flow.zoomTo?.(minimumReadableZoom, { duration: 0 });
          }
        }, 120);
        initialFitState.current = "done";
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      if (readableZoomTimer) window.clearTimeout(readableZoomTimer);
      if (initialFitState.current === "scheduled") initialFitState.current = "idle";
    };
  }, [flow, initialized, nodes.length]);

  useEffect(() => {
    if (!initialized) return;
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        if (node.data.kind === "strategy") {
          const entries = deriveStrategyEntries(node, current, edges);
          if (!sameEntries(node.data.strategyEntries, entries)) {
            changed = true;
            return { ...node, data: { ...node.data, strategyEntries: entries } };
          }
        }
        if (node.data.kind === "publish") {
          const incoming = edges.filter((candidate) => candidate.target === node.id);
          const finalInput = current.find((candidate) => candidate.id === incoming[0]?.source);
          const subtitle = finalInput?.data.kind === "strategy" ? "模型组 · 用户可见" : "单模型 · 用户可见";
          const endpointType = endpointTypeForPublish(node.id, current, edges) || node.data.endpointType;
          if (node.data.subtitle !== subtitle || node.data.endpointType !== endpointType) {
            changed = true;
            return { ...node, data: { ...node.data, subtitle, endpointType } };
          }
        }
        return node;
      });
      return changed ? next : current;
    });
  }, [edges, initialized, setNodes]);

  const issues = useMemo(() => validateCanvas(nodes, edges), [edges, nodes]);
  const checkCount = Math.max(0, 9 - Math.min(9, issues.length));
  const filteredPool = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.pool.filter((item) => !needle || [item.upstreamModel, item.channelName, item.provider].some((value) => value.toLowerCase().includes(needle)));
  }, [query, state.pool]);
  const [mediaServices, setMediaServices] = useState<MediaService[]>([]);
  useEffect(() => {
    let active = true;
    void listMediaServices().then(items => { if (active) setMediaServices(items); }).catch(() => { if (active) setMediaServices([]); });
    return () => { active = false; };
  }, [state.pool]);
  const upscaleChannels = useMemo(() => mediaServices.filter(service => service.kind === "mediakit").map(service => ({
    id: service.id, name: service.name, provider: "MediaKit 大模型版",
    available: service.enabled && service.configured && !service.requiresConfiguration && service.healthStatus === "ok",
  })), [mediaServices]);
  const publishedTargets = useMemo(() => state.groups
    .filter((group) => group.publication.status === "published" || group.publication.status === "degraded")
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN")), [state.groups]);
  const filteredPublishedTargets = useMemo(() => {
    const needle = publishedTargetQuery.trim().toLowerCase();
    return publishedTargets.filter((group) => !needle || [
      group.displayName,
      group.publicModel,
      endpointLabels[group.endpointType] || group.endpointType,
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [publishedTargetQuery, publishedTargets]);
  const activePublishedTarget = useMemo(
    () => publishedTargets.find((group) => group.groupKey === activeGroupKey) || null,
    [activeGroupKey, publishedTargets],
  );

  const patchNode = useCallback((nodeId: string, patch: Partial<RouteCanvasNodeData>) => {
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node));
    setDirty(true);
  }, [setNodes]);

  const patchStrategyEntry = useCallback((nodeId: string, sourceNodeId: string, patch: Partial<StrategyEntry>) => {
    setNodes((current) => current.map((node) => node.id === nodeId ? {
      ...node,
      data: {
        ...node.data,
        strategyEntries: (node.data.strategyEntries || []).map((entry) => entry.sourceNodeId === sourceNodeId ? { ...entry, ...patch } : entry),
      },
    } : node));
    if (patch.tier) {
      setEdges((current) => {
        const branchEdges = edgeIdsBetween(sourceNodeId, nodeId, current);
        const dashed = patch.tier !== "P0";
        return current.map((edge) => branchEdges.has(edge.id) ? {
          ...edge,
          style: { ...edge.style, stroke: "var(--cui-accent)", strokeWidth: 2, strokeDasharray: dashed ? "7 6" : undefined },
        } : edge);
      });
    }
    setDirty(true);
  }, [setEdges, setNodes]);

  const saveDraft = useCallback(() => {
    const snapshot: RouteCanvasSnapshot = {
      id: `snapshot-${Date.now()}`,
      savedAt: Date.now(),
      label: `画布草稿 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      nodes,
      edges,
    };
    const nextSnapshots = [snapshot, ...snapshots].slice(0, 12);
    try {
      writeDocument({ schemaVersion: 1, nodes, edges, snapshots: nextSnapshots });
      setSnapshots(nextSnapshots);
      setDirty(false);
      toast({ title: "画布草稿已保存", message: "节点、连线、发布目标与定价均已保存在当前浏览器。", tone: "success" });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "浏览器存储不可用";
      setCanvasError(message);
      toast({ title: "草稿保存失败", message, tone: "danger" });
    }
  }, [edges, nodes, snapshots, toast]);

  const publish = useCallback(async () => {
    const localIssues = validateCanvas(nodes, edges);
    if (localIssues.length) {
      setCanvasError(localIssues[0].message);
      toast({ title: "画布校验未通过", message: localIssues[0].message, tone: "danger" });
      return;
    }
    setPublishing(true);
    setCanvasError("");
    try {
      const drafts = buildDrafts(nodes, edges);
      const saved = [];
      for (const draft of drafts) {
        const preflight = await preflightModelRouteGroup(draft);
        if (!preflight.valid) throw new Error(preflight.issues[0]?.message || "发布预检未通过");
        saved.push(await saveModelRouteGroup(draft));
      }
      const groupByPublicModel = new Map(saved.map((group) => [group.publicModel, group]));
      setNodes((current) => current.map((node) => {
        if (node.data.kind !== "publish") return node;
        const group = groupByPublicModel.get(String(node.data.publicModel));
        return group ? { ...node, data: { ...node.data, status: "ready", existingGroupKey: group.groupKey } } : node;
      }));
      setDirty(false);
      state.reload();
      toast({ title: "发布目标已生效", message: `${saved.length} 个用户可见模型及其统一价格已同步到创作台、中转站与模型广场。`, tone: "success" });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "发布失败";
      setCanvasError(message);
      toast({ title: "发布失败", message, tone: "danger" });
    } finally {
      setPublishing(false);
    }
  }, [edges, nodes, setNodes, state, toast]);

  const onConnect = useCallback((connection: Connection) => {
    setConnectionNodePicker(null);
    setEdges((current) => addEdge({ ...connection, type: "smoothstep", style: { stroke: "var(--cui-accent)", strokeWidth: 2 } }, current));
    setDirty(true);
  }, [setEdges]);

  const onConnectEnd = useCallback<OnConnectEnd>((event, connectionState) => {
    if (connectionState.isValid || !connectionState.fromNode || connectionState.fromHandle?.type !== "source" || !flow) return;
    const point = connectEndClientPoint(event);
    const surface = surfaceRef.current;
    if (!point || !surface) return;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width > 0 && (point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom)) return;
    const elementAtPoint = document.elementFromPoint?.(point.x, point.y);
    if (elementAtPoint?.closest(".react-flow__node")) return;
    const sourceNode = nodes.find((node) => node.id === connectionState.fromNode?.id);
    if (!sourceNode) return;
    const kinds = compatibleNextKinds(sourceNode);
    if (!kinds.length) return;
    const flowPoint = flow.screenToFlowPosition(point);
    const estimatedHeight = Math.max(...kinds.map((kind) => nodeEstimatedHeights[kind] || 110));
    const menuWidth = 244;
    const menuHeight = 76 + kinds.length * 58;
    const menuPageMinY = Math.max(12, bounds.top + 12);
    const menuPageMaxY = Math.max(menuPageMinY, Math.min(window.innerHeight, bounds.bottom) - menuHeight - 12);
    const menuPageX = Math.max(12, Math.min(point.x + 14, Math.max(12, window.innerWidth - menuWidth - 12)));
    const menuPageY = Math.max(menuPageMinY, Math.min(point.y - 38, menuPageMaxY));
    setPublishedTargetsOpen(false);
    setConnectionNodePicker({
      sourceNodeId: sourceNode.id,
      kinds,
      nodePosition: { x: flowPoint.x, y: flowPoint.y - estimatedHeight / 2 },
      menuPosition: {
        x: menuPageX - bounds.left,
        y: menuPageY - bounds.top,
      },
    });
  }, [flow, nodes]);

  const addConnectedNode = useCallback((kind: RouteCanvasNodeKind) => {
    if (!connectionNodePicker) return;
    const source = nodes.find((node) => node.id === connectionNodePicker.sourceNodeId);
    if (!source) {
      setConnectionNodePicker(null);
      return;
    }
    const context = upstreamContext(source.id, nodes, edges);
    const resolutionAware = context.endpointType === "video_generation";
    const targetResolution = kind === "upscale" ? nextResolution(context.resolution) : context.resolution;
    const publishModelBase = publicModelFromName(String(source.data.upstreamModel || source.data.title || "new-public-model"));
    const overrides: Partial<RouteCanvasNodeData> = kind === "mapping"
      ? { endpointType: context.endpointType }
      : kind === "resolution"
        ? { endpointType: context.endpointType, resolutionAware, sourceResolution: context.resolution, targetResolution: context.resolution, subtitle: `原生 ${context.resolution} → 目标 ${context.resolution}` }
        : kind === "upscale"
          ? { endpointType: context.endpointType, resolutionAware, sourceResolution: context.resolution, targetResolution, subtitle: `${context.resolution} → ${targetResolution}` }
          : kind === "quality"
            ? {
                endpointType: context.endpointType,
                resolutionAware,
                targetResolution: context.resolution,
                title: resolutionAware ? `${context.resolution} 质量校验` : "能力与输出校验",
                subtitle: resolutionAware ? "分辨率与质量校验" : "能力合同与计费输出",
              }
            : kind === "strategy"
              ? { endpointType: context.endpointType }
              : kind === "publish"
                ? {
                    endpointType: context.endpointType,
                    targetResolution: context.resolution,
                    displayName: String(source.data.upstreamModel || source.data.title || "新发布目标"),
                    publicModel: `${publishModelBase}-route-${Date.now().toString(36).slice(-4)}`,
                    pricingUnit: endpointPricingUnits[context.endpointType]?.[0]?.value || "task",
                    priceGu: "1.00",
                  }
                : {};
    const node = createNode(kind, connectionNodePicker.nodePosition, overrides);
    setNodes((current) => [...current, node]);
    setEdges((current) => addEdge({
      id: `${source.id}-${node.id}`,
      source: source.id,
      target: node.id,
      type: "smoothstep",
      style: { stroke: "var(--cui-accent)", strokeWidth: 2 },
    }, current));
    setConnectionNodePicker(null);
    setDirty(true);
  }, [connectionNodePicker, edges, nodes, setEdges, setNodes]);

  const startDrag = useCallback((event: DragEvent, payload: DragPayload) => {
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragEnter = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }, []);

  const onDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragActive(false);
  }, []);

  const insertPayload = useCallback((payload: DragPayload, position: { x: number; y: number }) => {
    if (payload.type === "pool") {
      const item = state.pool.find((candidate) => candidate.poolId === payload.poolId);
      if (!item) return;
      setNodes((current) => [...current, sourceNodeFromPool(item, position)]);
    } else {
      const overrides = payload.kind === "publish"
        ? { displayName: "新发布目标", publicModel: publicModelFromName("new-public-model") }
        : {};
      setNodes((current) => [...current, createNode(payload.kind, position, overrides)]);
    }
    setDirty(true);
  }, [setNodes, state.pool]);

  const activatePaletteItem = useCallback((payload: DragPayload) => {
    if (!flow) return;
    insertPayload(payload, flow.screenToFlowPosition({ x: window.innerWidth * 0.58, y: window.innerHeight * 0.52 }));
  }, [flow, insertPayload]);

  const onDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    if (!flow) return;
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as DragPayload;
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      insertPayload(payload, position);
    } catch {
      setCanvasError("拖拽数据无法识别，请重试。");
    }
  }, [flow, insertPayload]);

  const restoreSnapshot = useCallback((snapshot: RouteCanvasSnapshot) => {
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setDirty(true);
    setHistoryOpen(false);
    window.setTimeout(() => flow?.fitView({
      padding: 0.16,
      minZoom: window.innerWidth <= 1180 ? 0.5 : 0.35,
      duration: 350,
    }), 0);
    toast({ title: "已恢复历史草稿", message: snapshot.label, tone: "success" });
  }, [flow, setEdges, setNodes, toast]);

  const fitRestoredCanvas = useCallback(() => {
    window.setTimeout(() => flow?.fitView({
      padding: 0.18,
      minZoom: window.innerWidth <= 1180 ? 0.5 : 0.62,
      maxZoom: 1,
      duration: 320,
    }), 0);
  }, [flow]);

  const restorePublishedTarget = useCallback((group: ModelRouteGroup) => {
    const graph = createGraphFromGroup(group, state.pool);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setActiveGroupKey(group.groupKey);
    setDirty(false);
    setCanvasError("");
    setPublishedTargetsOpen(false);
    fitRestoredCanvas();
    toast({
      title: "已恢复发布目标画布",
      message: `${group.displayName} 的上游、处理节点、策略与价格已载入，可直接修改。`,
      tone: "success",
    });
  }, [fitRestoredCanvas, setEdges, setNodes, state.pool, toast]);

  const restoreOverview = useCallback(() => {
    const graph = createGraphFromGroups(state.groups, state.pool);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setActiveGroupKey(null);
    setDirty(false);
    setCanvasError("");
    setPublishedTargetsOpen(false);
    fitRestoredCanvas();
    toast({ title: "已恢复全部路由概览", message: "画布已重新载入全部路由与默认草稿。", tone: "success" });
  }, [fitRestoredCanvas, setEdges, setNodes, state.groups, state.pool, toast]);

  const requestPublishedTarget = useCallback((group: ModelRouteGroup) => {
    if (group.groupKey === activeGroupKey) {
      setPublishedTargetsOpen(false);
      return;
    }
    if (dirty) {
      setPendingSelection(group);
      return;
    }
    restorePublishedTarget(group);
  }, [activeGroupKey, dirty, restorePublishedTarget]);

  const requestOverview = useCallback(() => {
    if (!activeGroupKey) {
      setPublishedTargetsOpen(false);
      return;
    }
    if (dirty) {
      setPendingSelection("overview");
      return;
    }
    restoreOverview();
  }, [activeGroupKey, dirty, restoreOverview]);

  const canvasActions = useMemo(
    () => ({ patchNode, patchStrategyEntry, upscaleChannels }),
    [patchNode, patchStrategyEntry, upscaleChannels],
  );

  return (
    <RouteCanvasActionsProvider actions={canvasActions}>
      <div className="routeCanvasPage">
        <header className="routeCanvasTopbar">
          <div className="routeCanvasTopbar__identity">
            <Button
              className="routeCanvasMobileNavButton"
              variant="secondary"
              icon={<Menu size={16} />}
              aria-label="打开后台导航"
              onClick={() => document.querySelector<HTMLButtonElement>(".consoleMobileNavButton")?.click()}
            >导航</Button>
            <Button variant="secondary" icon={<ArrowLeft size={16} />} onClick={() => navigate("/fjadmin/model-pool")}>退出画布</Button>
            <div className="routeCanvasTopbar__copy">
              <h1>模型路由画布</h1>
              <span>{activePublishedTarget ? `正在编辑：${activePublishedTarget.displayName} · ` : ""}{dirty ? "有未保存修改" : "所有修改已保存"}</span>
            </div>
          </div>
          <div className="routeCanvasPage__actions">
          <Button variant="secondary" icon={<History size={16} />} onClick={() => setHistoryOpen(true)}>版本记录</Button>
          <Button variant="secondary" icon={<Save size={16} />} onClick={saveDraft}>{dirty ? "保存草稿" : "已保存"}</Button>
          <span className={`routeCanvasCheck ${issues.length ? "is-warning" : "is-ready"}`}><CircleCheck size={15} />{checkCount}/9 通过</span>
          <Button icon={<CheckCheck size={16} />} loading={publishing} onClick={() => void publish()}>校验并发布</Button>
          </div>
        </header>
        {canvasError ? <Alert className="routeCanvasPage__error" tone="danger" title="当前画布无法发布">{canvasError}</Alert> : null}
        <section className="routeCanvasWorkspace" aria-label="模型路由无限画布">
          <aside className="routeCanvasPalette" aria-label="模型与节点资源">
            <div className="routeCanvasPalette__content">
              <Tabs ariaLabel="画布资源" value={paletteTab} onValueChange={setPaletteTab} items={[{ value: "pool", label: "模型池" }, { value: "nodes", label: "节点库" }]} />
              {paletteTab === "pool" ? <>
                <label className="routeCanvasPalette__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索模型或渠道" /></label>
                <p className="routeCanvasPalette__hint">拖入画布或单击卡片后才会创建可连线的模型实例。同名模型会按供应商渠道分别显示。</p>
                <div className="routeCanvasPalette__list">
                  {state.loading ? <div className="routeCanvasPalette__state"><RefreshCcw className="is-spinning" size={17} />正在读取模型池</div> : null}
                  {!state.loading && state.error ? <div className="routeCanvasPalette__state is-error"><CircleAlert size={17} />{state.error}</div> : null}
                  {!state.loading && !state.error && !filteredPool.length ? <div className="routeCanvasPalette__state"><Layers3 size={18} />暂无匹配模型</div> : null}
                  {filteredPool.map((item) => <ModelPoolCard item={item} onDragStart={startDrag} onActivate={activatePaletteItem} key={item.poolId} />)}
                </div>
              </> : <div className="routeCanvasPalette__list routeCanvasPalette__list--nodes">
                <p className="routeCanvasPalette__hint">拖入或单击添加处理节点，再从端口连线组成单模型路径或模型组。</p>
                {routeNodeLibrary.map(({ kind, label, description, icon: Icon }) => <button type="button" draggable className="routePaletteNode" key={kind} onClick={() => activatePaletteItem({ type: "node", kind })} onDragStart={(event) => startDrag(event, { type: "node", kind })}><GripVertical size={15} /><Icon size={16} /><span><strong>{label}</strong><small>{description}</small></span></button>)}
              </div>}
            </div>

            <div className="routeCanvasPalette__footer">
              <button
                type="button"
                className="routePublishedTargetLauncher"
                aria-expanded={publishedTargetsOpen}
                aria-controls="route-published-targets"
                onClick={() => setPublishedTargetsOpen((open) => !open)}
              >
                <span className="routePublishedTargetLauncher__icon"><PackageCheck size={16} /></span>
                <span><strong>发布目标</strong><small>{publishedTargets.length} 个已发布目标</small></span>
                <ChevronUp size={16} aria-hidden="true" />
              </button>
            </div>

            <section
              id="route-published-targets"
              className={`routePublishedTargets ${publishedTargetsOpen ? "is-open" : ""}`}
              aria-label="已发布目标列表"
              aria-hidden={!publishedTargetsOpen}
            >
              <header className="routePublishedTargets__header">
                <div><PackageCheck size={17} /><span><strong>发布目标</strong><small>选择目标恢复完整画布</small></span></div>
                <button type="button" aria-label="收起发布目标" onClick={() => setPublishedTargetsOpen(false)}><ChevronDown size={17} /></button>
              </header>
              <label className="routeCanvasPalette__search routePublishedTargets__search"><Search size={15} /><input value={publishedTargetQuery} onChange={(event) => setPublishedTargetQuery(event.currentTarget.value)} placeholder="搜索发布名称或模型 ID" /></label>
              {activeGroupKey ? <button type="button" className="routePublishedTargets__overview" onClick={requestOverview}><Layers3 size={15} /><span><strong>全部路由概览</strong><small>返回所有路由与默认草稿</small></span></button> : null}
              <div className="routePublishedTargets__list">
                {!filteredPublishedTargets.length ? <div className="routeCanvasPalette__state"><PackageCheck size={18} />暂无匹配的已发布目标</div> : null}
                {filteredPublishedTargets.map((group) => <button
                  type="button"
                  className={`routePublishedTargetCard ${activeGroupKey === group.groupKey ? "is-active" : ""}`}
                  aria-current={activeGroupKey === group.groupKey ? "true" : undefined}
                  onClick={() => requestPublishedTarget(group)}
                  key={group.groupKey}
                >
                  <span className={`routePublishedTargetCard__status routePublishedTargetCard__status--${group.publication.status}`} />
                  <span className="routePublishedTargetCard__copy"><strong>{group.displayName}</strong><code>{group.publicModel}</code><small>{endpointLabels[group.endpointType] || group.endpointType} · {group.targets.length} 个上游</small></span>
                  <span className="routePublishedTargetCard__price">{group.pricing ? `${microsToGu(group.pricing.unitPriceMicros, group.pricing.unit)} GU` : "—"}</span>
                </button>)}
              </div>
            </section>
          </aside>

          <div ref={surfaceRef} className={`routeCanvasSurface ${dragActive ? "is-drag-active" : ""}`} onDragOver={onDragOver} onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDrop={onDrop}>
            {dragActive ? <div className="routeCanvasDropPrompt"><Layers3 size={18} /><span>松开以创建画布节点</span></div> : null}
            {!nodes.length && initialized ? <div className="routeCanvasEmpty"><Layers3 size={27} /><strong>从左侧拖入第一个模型</strong><span>模型池本身不连线，拖入后才会生成模型实例节点。</span></div> : null}
            <ReactFlow<RouteCanvasNode, RouteCanvasEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={routeCanvasNodeTypes}
              onInit={setFlow}
              onNodesChange={(changes) => {
                onNodesChange(changes);
                if (initialized && changes.some((change) =>
                  change.type === "add"
                  || change.type === "remove"
                  || change.type === "replace"
                  || (change.type === "position" && Boolean(change.dragging)))) setDirty(true);
              }}
              onEdgesChange={(changes) => {
                onEdgesChange(changes);
                if (initialized && changes.some((change) => change.type !== "select")) setDirty(true);
              }}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              minZoom={0.5}
              maxZoom={1.5}
              snapToGrid
              snapGrid={[16, 16]}
              deleteKeyCode={["Backspace", "Delete"]}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--cui-border)" />
              <MiniMap
                className="routeCanvasMiniMap"
                pannable
                zoomable
                nodeColor={(node) => node.type === "publish" ? "var(--cui-accent)" : node.type === "strategy" ? "var(--cui-success-text)" : "var(--cui-surface-4)"}
                maskColor="color-mix(in srgb, var(--cui-surface) 72%, transparent)"
              />
              <Controls className="routeCanvasControls" showInteractive={false} />
            </ReactFlow>
            {connectionNodePicker ? <div
              ref={connectionNodePickerRef}
              className="routeConnectionNodePicker nodrag nopan"
              role="dialog"
              aria-label="选择下一节点"
              style={{ left: connectionNodePicker.menuPosition.x, top: connectionNodePicker.menuPosition.y }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <header><div><strong>添加下一节点</strong><span>选择后自动创建并连线</span></div><button type="button" aria-label="关闭节点选择" onClick={() => setConnectionNodePicker(null)}><X size={15} /></button></header>
              <div className="routeConnectionNodePicker__list">
                {connectionNodePicker.kinds.map((kind) => {
                  const option = routeNodeLibrary.find((candidate) => candidate.kind === kind);
                  if (!option) return null;
                  const Icon = option.icon;
                  return <button type="button" key={kind} onClick={() => addConnectedNode(kind)}>
                    <span><Icon size={16} /></span>
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>;
                })}
              </div>
            </div> : null}
            <div className="routeCanvasLegend" aria-label="连线说明"><span><i />P0 主路径</span><span><i className="is-dashed" />P1/P2 备用路径</span></div>
          </div>
        </section>

        <Drawer open={historyOpen} title="画布版本记录" description="恢复只会替换当前草稿；再次发布前仍会执行完整校验。" onOpenChange={setHistoryOpen}>
          <div className="routeCanvasHistory">
            {!snapshots.length ? <div className="routeCanvasHistory__empty"><Clock3 size={22} /><strong>还没有保存过草稿</strong><span>点击页面顶部“保存草稿”后会在这里形成版本。</span></div> : snapshots.map((snapshot) => <article key={snapshot.id}><div><strong>{snapshot.label}</strong><span>{snapshot.nodes.length} 个节点 · {snapshot.edges.length} 条连线</span></div><Button size="compact" variant="secondary" onClick={() => restoreSnapshot(snapshot)}>恢复</Button></article>)}
          </div>
        </Drawer>
        <ConfirmDialog
          open={Boolean(pendingSelection)}
          title="切换画布并放弃未保存修改？"
          description={pendingSelection === "overview"
            ? "将返回全部路由概览，当前画布尚未保存的修改会丢失。"
            : pendingSelection
              ? `将载入 ${pendingSelection.displayName} 的已发布画布，当前尚未保存的修改会丢失。`
              : undefined}
          confirmLabel="放弃修改并切换"
          tone="danger"
          onCancel={() => setPendingSelection(null)}
          onConfirm={() => {
            const selection = pendingSelection;
            setPendingSelection(null);
            if (selection === "overview") restoreOverview();
            else if (selection) restorePublishedTarget(selection);
            return true;
          }}
        />
      </div>
    </RouteCanvasActionsProvider>
  );
}

export default function ModelRouteCanvasPage() {
  return <ReactFlowProvider><RouteCanvasContent /></ReactFlowProvider>;
}
