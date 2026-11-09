import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { CANVAS_VISUAL_SCALE, EDGE_HIT_TOLERANCE_PX, EDGE_SAMPLE_COUNT, EDGE_RECT_SAMPLE_COUNT } from "./canvasPageConstants";
import { createNode } from "./canvasNodeDefaults";
import { isAiModelSelectable, getAiModelUnavailableMessage, normalizeVideoResolutionForModel, summarizeVideoReferenceNodes, getDefaultVideoPromptTab, getVideoPromptTabAvailability } from "./canvasModelDefinitions";
import { defaultNodeTitle } from "./canvasSnapshotCodec";
import type { Side, MenuSource, ViewportState, NodeData, EdgeData, CreationMenuState, PendingConnection, CanvasMetaState } from "./canvasDataTypes";
import type { NodeType } from "./canvasMediaTypes";
import { supportsCanvasVideoDraft, canvasDraftFinalRequest } from "./canvasVideoDraft";
import { type DraftQuote } from "./CanvasDraftQuoteDialog";
import { generationPreparationPatch } from "../../features/quick-create/generationPreparation";
import { getCanvasFirstNodeAutoFitSuppressionDeadline, getCanvasSidebarNodePlacement } from "./canvasAdaptiveLayout";
import { isCanvasCatalogVideoModeSupported, validateCanvasCatalogModeReferenceCounts } from "./canvasCatalogContract";
import { api, type AiModelOption } from "@/lib/api";
import { bezierControl, bezierPoint, rectFromNode, type CanvasRect as Rect } from "./canvasGeometry";

export interface CanvasNodeCreationControllerDependencies {
  viewportVisualScale: (nextViewport?: ViewportState) => number;
  edges: EdgeData[];
  nodeMap: Map<string, NodeData>;
  nodes: NodeData[];
  models: AiModelOption[];
  setWorkflowPanelOpen: Dispatch<SetStateAction<boolean>>;
  setHistoryPanelOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutPanelOpen: Dispatch<SetStateAction<boolean>>;
  setCreationMenu: Dispatch<SetStateAction<CreationMenuState>>;
  setPendingConnection: Dispatch<SetStateAction<PendingConnection | null>>;
  studioChrome: boolean;
  canvasMeta: CanvasMetaState;
  activeProjectContextId: string | null;
  setStatus: Dispatch<SetStateAction<string>>;
  nodeSerialCounter: Record<NodeType, number>;
  creationMenu: CreationMenuState;
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setNodeSerialCounter: Dispatch<SetStateAction<Record<NodeType, number>>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  rootRef: RefObject<HTMLDivElement | null>;
  studioTopologyFitSuppressedUntilRef: RefObject<number>;
  studioTopologyFitTimerRef: RefObject<number | null>;
  assetManagerOpen: boolean;
  viewport: ViewportState;
  viewportRef: RefObject<ViewportState>;
  setViewport: Dispatch<SetStateAction<ViewportState>>;
  pendingConnection: PendingConnection | null;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  availableModels: AiModelOption[];
  nodesRef: RefObject<NodeData[]>;
  draftDecisionRef: RefObject<((approved: boolean) => void) | null>;
  setDraftQuote: Dispatch<SetStateAction<DraftQuote | null>>;
  draftSubmittingRef: RefObject<Set<string>>;
  beginNodeGenerationSession: (nodeId: string) => string;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
  beginNodeProgressSimulation: (nodeId: string, phase: "upload" | "generation") => any;
  pollTaskUntilDone: (taskId: string, node: NodeData, sessionId: string, startedAt?: number, options?: { kind?: "generation" | "video_enhance"; queryFailures?: number; }) => Promise<boolean>;
}

export function createCanvasNodeCreationController(deps: CanvasNodeCreationControllerDependencies) {
  const { viewportVisualScale, edges, nodeMap, nodes, models, setWorkflowPanelOpen, setHistoryPanelOpen, setShortcutPanelOpen, setCreationMenu, setPendingConnection, studioChrome, canvasMeta, activeProjectContextId, setStatus, nodeSerialCounter, creationMenu, setNodes, setNodeSerialCounter, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId, rootRef, studioTopologyFitSuppressedUntilRef, studioTopologyFitTimerRef, assetManagerOpen, viewport, viewportRef, setViewport, pendingConnection, setEdges, availableModels, nodesRef, draftDecisionRef, setDraftQuote, draftSubmittingRef, beginNodeGenerationSession, setNodePatch, finishNodeGenerationSession, beginNodeProgressSimulation, pollTaskUntilDone } = deps;
function nodeSocket(node: NodeData, side: Side) {
    return { x: side === "left" ? node.x : node.x + node.width, y: node.y + node.height / 2 };
  }

function connectionSideToward(node: NodeData, targetX: number): Side {
    return targetX < node.x + node.width / 2 ? "left" : "right";
  }

function edgeHitToleranceInWorld() {
    return EDGE_HIT_TOLERANCE_PX / Math.max(0.001, viewportVisualScale());
  }

function detectEdgeHover(worldX: number, worldY: number) {
    const tolerance = edgeHitToleranceInWorld();
    let best: { edgeId: string; point: { x: number; y: number }; distance: number } | null = null;

    for (const edge of edges) {
      const fromNode = nodeMap.get(edge.fromNodeId);
      const toNode = nodeMap.get(edge.toNodeId);
      if (!fromNode || !toNode) continue;
      const from = nodeSocket(fromNode, edge.fromSide);
      const to = nodeSocket(toNode, edge.toSide);
      const { p0, p1, p2, p3 } = bezierControl(from.x, from.y, to.x, to.y);

      for (let i = 0; i <= EDGE_SAMPLE_COUNT; i += 1) {
        const point = bezierPoint(i / EDGE_SAMPLE_COUNT, p0, p1, p2, p3);
        const distance = Math.hypot(worldX - point.x, worldY - point.y);
        if (!best || distance < best.distance) best = { edgeId: edge.id, point, distance };
      }
    }

    if (!best || best.distance > tolerance) return null;
    return best;
  }

function edgeIntersectsRect(edge: EdgeData, rect: Rect) {
    const fromNode = nodeMap.get(edge.fromNodeId);
    const toNode = nodeMap.get(edge.toNodeId);
    if (!fromNode || !toNode) return false;
    const from = nodeSocket(fromNode, edge.fromSide);
    const to = nodeSocket(toNode, edge.toSide);
    const { p0, p1, p2, p3 } = bezierControl(from.x, from.y, to.x, to.y);
    for (let i = 0; i <= EDGE_RECT_SAMPLE_COUNT; i += 1) {
      const point = bezierPoint(i / EDGE_RECT_SAMPLE_COUNT, p0, p1, p2, p3);
      if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) return true;
    }
    return false;
  }

function detectEdgeDropTarget(worldX: number, worldY: number, fromNodeId: string): { nodeId: string; side: Side } | null {
    const sourceNode = nodeMap.get(fromNodeId);
    for (const node of [...nodes].reverse()) {
      if (node.id === fromNodeId) continue;
      const rect = rectFromNode(node);
      if (worldX < rect.left || worldX > rect.right || worldY < rect.top || worldY > rect.bottom) continue;
      return {
        nodeId: node.id,
        side: sourceNode && sourceNode.x + sourceNode.width / 2 > node.x + node.width / 2 ? "right" : "left",
      };
    }
    return null;
  }

function hasDuplicateEdge(fromNodeId: string, fromSide: Side, toNodeId: string, toSide: Side) {
    return edges.some((edge) => edge.fromNodeId === fromNodeId && edge.fromSide === fromSide && edge.toNodeId === toNodeId && edge.toSide === toSide);
  }

function admitCanvasReferenceEdge(fromNodeId: string, toNodeId: string): { ok: true } | { ok: false; message: string } {
    const source = nodeMap.get(fromNodeId);
    const target = nodeMap.get(toNodeId);
    if (source && target && (target.videoWorkflow === "redraw" || target.videoRedrawSourceNodeId)) {
      if (source.type !== "video" && source.type !== "image") return { ok: false, message: "转绘节点目前支持一段原片和多个图片参考。" };
      const inputVideos = edges.filter(edge => edge.toNodeId === toNodeId).map(edge => nodeMap.get(edge.fromNodeId)).filter(node => node?.type === "video");
      if (source.type === "video" && inputVideos.some(node => node?.id !== source.id)) return { ok: false, message: "一个转绘节点只接一段原片，多段原片请分别创建转绘节点。" };
      return { ok: true };
    }

    if (
      !source
      || !target
      || target.type !== "video"
      || !["image", "video", "audio"].includes(source.type)
    ) return { ok: true };
    const model = models.find((item) => item.type === "video" && item.id === target.model);
    if (!model || !isAiModelSelectable(model)) {
      return { ok: false, message: model ? getAiModelUnavailableMessage(model) : "请先为视频节点选择可用模型" };
    }
    const references = edges
      .filter((edge) => edge.toNodeId === toNodeId)
      .map((edge) => nodeMap.get(edge.fromNodeId))
      .filter((node): node is NodeData => Boolean(node && ["image", "video", "audio"].includes(node.type)));
    const summary = summarizeVideoReferenceNodes([...references, source]);
    if (isCanvasCatalogVideoModeSupported(model, "omni_reference")) {
      const limits = validateCanvasCatalogModeReferenceCounts(model, "omni_reference", {
        image: summary.imageCount,
        video: summary.videoCount,
        file: summary.audioCount,
      });
      if (!limits.ok) return limits;
    }
    const tab = getDefaultVideoPromptTab(summary, target.model, model);
    const admission = getVideoPromptTabAvailability(tab, summary, target.model, model);
    return admission.enabled
      ? { ok: true }
      : { ok: false, message: admission.hintLines[0] || "参考素材超过当前模型上限" };
  }

function openCreationMenuAtWorld(x: number, y: number, source: MenuSource, nextPending: PendingConnection | null = null) {
    setWorkflowPanelOpen(false);
    setHistoryPanelOpen(false);
    setShortcutPanelOpen(false);
    const sourceNodeType = nextPending ? nodeMap.get(nextPending.fromNodeId)?.type : undefined;
    setCreationMenu({
      open: true,
      x,
      y,
      source,
      sourceNodeType,
      sourceNodeId: nextPending?.fromNodeId,
    });
    setPendingConnection(nextPending);
  }

function closeCreationMenu() {
    setCreationMenu((prev) => ({ ...prev, open: false }));
    setPendingConnection(null);
  }

function createNodeAt(type: NodeType, worldX: number, worldY: number) {
    if (studioChrome && (!canvasMeta.canvasId || !activeProjectContextId)) {
      setStatus("请先选择项目并打开真实画布，再添加节点");
      return;
    }
    const id = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const nextIndex = (nodeSerialCounter[type] ?? 0) + 1;
    const requireVideoModelSelection = type === "video";
    const next = {
      ...createNode(id, type, worldX, worldY),
      title: defaultNodeTitle(type, nextIndex),
      titleCustomized: false,
      ...(requireVideoModelSelection ? { model: "" } : {}),
    };
    const firstSidebarNode =
      creationMenu.source === "sidebar" && nodes.length === 0;
    setNodes((prev) => [...prev, next]);
    setNodeSerialCounter((prev) => ({ ...prev, [type]: nextIndex }));
    setSelectedNodeIds([id]);
    setSelectedEdgeIds([]);
    setActiveNodeId(id);
    if (requireVideoModelSelection) setStatus("请从模型目录选择视频模型");

    if (firstSidebarNode && rootRef.current) {
      studioTopologyFitSuppressedUntilRef.current =
        getCanvasFirstNodeAutoFitSuppressionDeadline(Date.now());
      if (studioTopologyFitTimerRef.current !== null) {
        window.clearTimeout(studioTopologyFitTimerRef.current);
        studioTopologyFitTimerRef.current = null;
      }
      const rect = rootRef.current.getBoundingClientRect();
      const placement = getCanvasSidebarNodePlacement(
        rect.width,
        rect.height,
        assetManagerOpen,
        true,
      );
      const targetScale = placement.viewportScale ?? viewport.scale;
      const visualScale = targetScale * CANVAS_VISUAL_SCALE;
      const nextViewport = {
        scale: targetScale,
        panX: placement.centerX - worldX * visualScale,
        panY: placement.centerY - worldY * visualScale,
      };
      viewportRef.current = nextViewport;
      setViewport(nextViewport);
    }

    if (pendingConnection) {
      const toSide: Side = pendingConnection.fromSide === "right" ? "left" : "right";
      setEdges((prev) => [...prev, { id: `edge_${Date.now()}_${prev.length}`, fromNodeId: pendingConnection.fromNodeId, fromSide: pendingConnection.fromSide, toNodeId: id, toSide }]);
    }

    closeCreationMenu();
    return id;
  }

function createVideoDeriveFromNode(
    kind: "extend" | "edit",
    sourceNode: NodeData | null,
    worldX: number,
    worldY: number,
  ) {
    if (studioChrome && (!canvasMeta.canvasId || !activeProjectContextId)) {
      setStatus("请先选择项目并打开真实画布，再添加节点");
      return;
    }
    const deriveMode = kind === "extend" ? "video_extension" : "video_edit";
    const extensionModel = availableModels.find((model) => model.id === sourceNode?.model && isAiModelSelectable(model) && isCanvasCatalogVideoModeSupported(model, deriveMode))
      ?? availableModels.find((model) => model.type === "video" && isAiModelSelectable(model) && isCanvasCatalogVideoModeSupported(model, deriveMode));
    if (!extensionModel) {
      setStatus("当前模型目录尚未开放此原生视频操作，请刷新模型目录后重试");
      return;
    }
    const id = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const nextIndex = (nodeSerialCounter.video ?? 0) + 1;
    const baseTitle = kind === "extend"
      ? sourceNode ? `延长 · ${sourceNode.title || "原片"}` : "延长视频"
      : sourceNode ? `修改 · ${sourceNode.title || "原片"}` : "修改视频";
    const next: NodeData = {
      ...createNode(id, "video", worldX, worldY),
      title: baseTitle,
      titleCustomized: true,
      ...(sourceNode ? { ratio: sourceNode.ratio, width: sourceNode.width, height: sourceNode.height } : {}),
      model: extensionModel?.id || sourceNode?.model || "",
      resolution: extensionModel ? normalizeVideoResolutionForModel(extensionModel.id, sourceNode?.resolution || "720P", extensionModel) : sourceNode?.resolution || "720P",
      duration: kind === "extend" ? "5" : "-1",
      videoMode: deriveMode,
      cameraControl: sourceNode?.cameraControl || "",
      cameraSettings: sourceNode?.cameraSettings,
      prompt: kind === "extend"
        ? "向后延长@视频1，保持人物、服装、光线与运镜风格连贯，自然接续原片结尾动作。"
        : "编辑@视频1：按参考图片替换指定人物和场景，保留原片动作、机位、运镜、切点与节奏。请补充每张参考图对应的替换对象。",
    };
    setNodes((prev) => [...prev, next]);
    setNodeSerialCounter((prev) => ({ ...prev, video: nextIndex }));
    const edge: EdgeData | null = sourceNode ? {
      id: `edge_${Date.now()}_derive`,
      fromNodeId: sourceNode.id,
      fromSide: "right",
      toNodeId: id,
      toSide: "left",
    } : null;
    if (edge) setEdges((prev) => [...prev, edge]);
    setSelectedNodeIds([id]);
    setSelectedEdgeIds(edge ? [edge.id] : []);
    setActiveNodeId(id);
    setStatus(kind === "extend"
      ? "已创建延长视频节点：连接 1 段原片并填写接续剧情，画幅自动跟随原片"
      : "已创建原生编辑节点：连接 1 段原片和替换参考图，填写修改要求，画幅和时长跟随原片");
    closeCreationMenu();
    return id;
  }

function createVideoDraftNode(x: number, y: number) {
    if (studioChrome && (!canvasMeta.canvasId || !activeProjectContextId)) { setStatus("请先打开项目画布"); return; }
    const model = availableModels.find(model => isAiModelSelectable(model) && supportsCanvasVideoDraft(model));
    if (!model) { setStatus("当前没有开放样片的模型通道"); return; }
    const id = `node_${crypto.randomUUID()}`;
    const next: NodeData = { ...createNode(id, "video", x, y), title: "视频样片", titleCustomized: true,
      model: model.id, resolution: "480P", videoRenderMode: "draft", videoMode: "text_to_video", duration: "5" };
    setNodes(previous => [...previous, next]); setSelectedNodeIds([id]); setActiveNodeId(id); closeCreationMenu();
    setStatus("已添加视频样片：480p 试拍，满意后可在 7 天内另行生成 1080p 正式片");
  }

function createDraftFinalNode(source: NodeData) {
    if (!source.videoDraftTaskId) return;
    const existing = nodesRef.current.find(node => node.videoRenderMode === "finalize" && node.videoDraftTaskId === source.videoDraftTaskId);
    if (existing) { setSelectedNodeIds([existing.id]); setActiveNodeId(existing.id); setStatus("已定位这条样片对应的正式片节点"); return; }
    const id = `node_${crypto.randomUUID()}`;
    const next: NodeData = { ...createNode(id, "video", source.x + source.width + 100, source.y), title: `正式片 · ${source.title}`, titleCustomized: true,
      model: source.model, ratio: source.ratio, width: source.width, height: source.height, resolution: "1080P", duration: source.duration,
      videoRenderMode: "finalize", videoDraftTaskId: source.videoDraftTaskId, videoDraftParentNodeId: source.id,
      videoDraftExpiresAt: source.videoDraftExpiresAt, prompt: "", videoGenerationAttemptId: crypto.randomUUID() };
    const edge: EdgeData = { id: `edge_${crypto.randomUUID()}`, fromNodeId: source.id, toNodeId: id, fromSide: "right", toSide: "left", relationship: "draft_final" };
    setNodes(previous => [...previous, next]); setEdges(previous => [...previous, edge]); setSelectedNodeIds([id]); setActiveNodeId(id);
    setStatus("已创建正式片节点，确认本次报价后开始生成；样片保留");
  }

async function executeDraftWithApproval(node: NodeData, request: Record<string, unknown>, attemptId: string) {
    if (draftDecisionRef.current) throw new Error("请先确认或取消当前报价");
    const quote = await api.canvasDraft({ action: "quote", request, generationAttemptId: attemptId });
    if (draftDecisionRef.current) throw new Error("请先确认或取消当前报价");
    setStatus("请确认本次报价，尚未提交生成");
    const approved = await new Promise<boolean>(resolve => { draftDecisionRef.current = resolve; setDraftQuote(quote); });
    if (!approved) return null;
    if (Date.now() >= quote.expiresAt) throw new Error("报价已过期，请重新获取报价");
    const result = await api.canvasDraft({ action: "submit", request, generationAttemptId: attemptId, confirmationToken: quote.token });
    return result;
  }

async function submitDraftFinalNode(node: NodeData): Promise<boolean> {
    if (!node.videoDraftTaskId || draftSubmittingRef.current.has(node.id) || node.isGenerating) return false;
    const projectId = Number(activeProjectContextId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) { setStatus("请先选择项目"); return false; }
    if (node.taskId || node.videoUrl) { setStatus("已有正式片任务，请刷新任务状态，避免重复提交"); return false; }
    draftSubmittingRef.current.add(node.id);
    const attempt = node.videoGenerationAttemptId || crypto.randomUUID();
    const sessionId = beginNodeGenerationSession(node.id);
    setNodePatch(node.id, { videoGenerationAttemptId: attempt, isGenerating: true, generationState: "submitting", taskStatus: "processing", generationProgress: 1 });
    try {
      const result = await executeDraftWithApproval(node, canvasDraftFinalRequest(projectId, node.videoDraftTaskId), attempt);
      if (!result) { setNodePatch(node.id, { isGenerating: false, generationState: "idle", taskStatus: "idle", generationProgress: 0 }); finishNodeGenerationSession(node.id, sessionId); setStatus("已取消，未提交正式片"); return false; }
      if (!result.taskId) throw new Error("正式片任务编号缺失，请保留当前节点后重试");
      setNodePatch(node.id, { taskId: result.taskId, taskKind: "generation", taskStatus: "processing", generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) });
      beginNodeProgressSimulation(node.id, "generation");
      return await pollTaskUntilDone(result.taskId, node, sessionId);
    } catch (error) {
      setNodePatch(node.id, { isGenerating: false, generationState: "idle", taskStatus: "failed", generationProgress: 0 });
      finishNodeGenerationSession(node.id, sessionId); setStatus(error instanceof Error ? error.message : "正式片请求未完成"); return false;
    } finally { draftSubmittingRef.current.delete(node.id); }
  }
  return { nodeSocket, connectionSideToward, edgeHitToleranceInWorld, detectEdgeHover, edgeIntersectsRect, detectEdgeDropTarget, hasDuplicateEdge, admitCanvasReferenceEdge, openCreationMenuAtWorld, closeCreationMenu, createNodeAt, createVideoDeriveFromNode, createVideoDraftNode, createDraftFinalNode, executeDraftWithApproval, submitDraftFinalNode };
}
