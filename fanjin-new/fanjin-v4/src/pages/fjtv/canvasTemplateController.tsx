import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { defaultNodeTitle } from "./canvasSnapshotCodec";
import type { AssetManagerTab, CanvasAssetType, NodeData, EdgeData, GroupData, WorkflowTemplate, AssetSnapshot, AssetTemplate } from "./canvasDataTypes";
import type { NodeType } from "./canvasMediaTypes";
import { remapCanvasArtifactNode } from "./canvasTextArtifacts";
import { getCanvasUsableLayout } from "./canvasAdaptiveLayout";
import { api } from "@/lib/api";
import { toApiErrorView } from "@/api/http";
import { type AssetCatalogItem, type ProjectAssetCatalogItem } from "@/features/assets/assetCatalog";
import { normalizeProjectId } from "@/stores/projectStore";
import { stripLegacyDemoMedia } from "./canvasAssetPresentation";

export interface CanvasTemplateControllerDependencies {
  toTimestamp: (value: unknown, fallback?: number) => number;
  repairLegacyNodes: (rawNodes: any[]) => NodeData[];
  GROUP_THEME_COLORS: string[];
  normalizeAssetCategory: (value: unknown) => AssetTemplate["category"];
  setWorkflowsLoading: Dispatch<SetStateAction<boolean>>;
  setWorkflowsError: Dispatch<SetStateAction<string>>;
  setWorkflowTemplatesAvailable: Dispatch<SetStateAction<boolean>>;
  setWorkflows: Dispatch<SetStateAction<WorkflowTemplate[]>>;
  WORKFLOW_STORAGE_KEY: "menghuiai_infinite_canvas_workflows_v2";
  ASSET_STORAGE_KEY: "menghuiai_infinite_canvas_assets_v1";
  activeGroup: GroupData | null;
  activeGroupBounds: { left: number; top: number; right: number; bottom: number; } | null;
  workflowCoverCandidates: NodeData[];
  setWorkflowName: Dispatch<SetStateAction<string>>;
  setWorkflowCoverNodeId: Dispatch<SetStateAction<string | null>>;
  setWorkflowNote: Dispatch<SetStateAction<string>>;
  setCreateWorkflowModalOpen: Dispatch<SetStateAction<boolean>>;
  nodes: NodeData[];
  workflowCoverNodeId: string | null;
  workflowName: string;
  workflowNote: string;
  edges: EdgeData[];
  setStatus: Dispatch<SetStateAction<string>>;
  setWorkflowPanelOpen: Dispatch<SetStateAction<boolean>>;
  rootRef: RefObject<HTMLDivElement | null>;
  assetManagerOpen: boolean;
  toWorld: (clientX: number, clientY: number) => { x: number; y: number; };
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  canDelete: boolean;
  workflows: WorkflowTemplate[];
  selectedNodeIds: string[];
  setAssetCreateMode: Dispatch<SetStateAction<CanvasAssetType>>;
  setAssetName: Dispatch<SetStateAction<string>>;
  setAssetCategory: Dispatch<SetStateAction<"人物" | "场景" | "物品" | "风格" | "其它">>;
  setAssetSaveLocation: Dispatch<SetStateAction<string>>;
  ASSET_SAVE_LOCATIONS: string[];
  setAssetSaveTag: Dispatch<SetStateAction<string>>;
  ASSET_TAGS: string[];
  setAssetCreateModalOpen: Dispatch<SetStateAction<boolean>>;
  setPortraitAssetUri: Dispatch<SetStateAction<string>>;
  setPortraitPreviewUrl: Dispatch<SetStateAction<string>>;
  effectiveAssetProjectId: number | null;
  assetName: string;
  assetSaveTag: string;
  assetSaveLocation: string;
  setAssets: Dispatch<SetStateAction<AssetTemplate[]>>;
  setAssetManagerOpen: Dispatch<SetStateAction<boolean>>;
  setAssetManagerTab: Dispatch<SetStateAction<AssetManagerTab>>;
  setAssetDetailId: Dispatch<SetStateAction<string | null>>;
  portraitAssetUri: string;
  portraitPreviewUrl: string;
  isAssetUri: (value: string | undefined | null) => value is string;
  buildPortraitReferenceNode: (name: string, previewUrl: string, referenceAssetUri: string) => NodeData;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  nodeSerialCounter: Record<NodeType, number>;
  createNode: (id: string, type: NodeType, centerX: number, centerY: number) => NodeData;
  setNodeSerialCounter: Dispatch<SetStateAction<Record<NodeType, number>>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  assets: AssetTemplate[];
}

export function createCanvasTemplateController(deps: CanvasTemplateControllerDependencies) {
  const { toTimestamp, repairLegacyNodes, GROUP_THEME_COLORS, normalizeAssetCategory, setWorkflowsLoading, setWorkflowsError, setWorkflowTemplatesAvailable, setWorkflows, WORKFLOW_STORAGE_KEY, ASSET_STORAGE_KEY, activeGroup, activeGroupBounds, workflowCoverCandidates, setWorkflowName, setWorkflowCoverNodeId, setWorkflowNote, setCreateWorkflowModalOpen, nodes, workflowCoverNodeId, workflowName, workflowNote, edges, setStatus, setWorkflowPanelOpen, rootRef, assetManagerOpen, toWorld, setNodes, setEdges, setGroups, setSelectedNodeIds, setSelectedEdgeIds, setActiveGroupId, canDelete, workflows, selectedNodeIds, setAssetCreateMode, setAssetName, setAssetCategory, setAssetSaveLocation, ASSET_SAVE_LOCATIONS, setAssetSaveTag, ASSET_TAGS, setAssetCreateModalOpen, setPortraitAssetUri, setPortraitPreviewUrl, effectiveAssetProjectId, assetName, assetSaveTag, assetSaveLocation, setAssets, setAssetManagerOpen, setAssetManagerTab, setAssetDetailId, portraitAssetUri, portraitPreviewUrl, isAssetUri, buildPortraitReferenceNode, setActiveNodeId, nodeSerialCounter, createNode, setNodeSerialCounter, persistCanvas, assets } = deps;
function normalizeWorkflowTemplate(raw: any): WorkflowTemplate {
    raw = stripLegacyDemoMedia(raw) as any;
    const snapshot = raw?.groupSnapshot && typeof raw.groupSnapshot === "object" ? raw.groupSnapshot : {};
    const bounds = snapshot?.bounds && typeof snapshot.bounds === "object" ? snapshot.bounds : {};
    return {
      id: String(raw?.id || `wf_${Date.now()}`),
      name: String(raw?.name || "未命名工作流"),
      createdAt: toTimestamp(raw?.createdAt),
      coverUrl: raw?.coverUrl ? String(raw.coverUrl) : undefined,
      coverNodeId: raw?.coverNodeId ? String(raw.coverNodeId) : undefined,
      note: raw?.note ? String(raw.note) : undefined,
      groupSnapshot: {
        nodes: Array.isArray(snapshot?.nodes) ? repairLegacyNodes(snapshot.nodes) : [],
        edges: Array.isArray(snapshot?.edges) ? snapshot.edges : [],
        layoutMode: snapshot?.layoutMode === "horizontal" || snapshot?.layoutMode === "vertical" ? snapshot.layoutMode : "grid",
        themeColor: String(snapshot?.themeColor || GROUP_THEME_COLORS[0]),
        bounds: {
          left: Number(bounds?.left || 0),
          top: Number(bounds?.top || 0),
          right: Number(bounds?.right || 0),
          bottom: Number(bounds?.bottom || 0),
        },
      },
    };
  }

function normalizeAssetTemplate(raw: any): AssetTemplate {
    raw = stripLegacyDemoMedia(raw) as any;
    const snapshot = raw?.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : {};
    const meta = snapshot?.meta && typeof snapshot.meta === "object" ? snapshot.meta : {};
    const bounds = snapshot?.bounds && typeof snapshot.bounds === "object" ? snapshot.bounds : {};
    const tag = raw?.tag ? normalizeAssetCategory(raw.tag) : undefined;
    const assetType = raw?.assetType === "portrait" || meta?.assetType === "portrait" ? "portrait" : "snapshot";
    const referenceAssetUri =
      typeof raw?.referenceAssetUri === "string" && raw.referenceAssetUri.trim()
        ? raw.referenceAssetUri.trim()
        : typeof meta?.referenceAssetUri === "string"
          ? meta.referenceAssetUri.trim()
          : undefined;
    const projectId = normalizeProjectId(raw?.projectId ?? meta?.projectId) ?? undefined;
    return {
      id: String(raw?.id || `asset_${Date.now()}`),
      projectId,
      name: String(raw?.name || "未命名资产"),
      category: normalizeAssetCategory(raw?.category || raw?.tag),
      assetType,
      referenceAssetUri,
      saveLocation: raw?.saveLocation ? String(raw.saveLocation) : undefined,
      tag,
      coverUrl: raw?.coverUrl ? String(raw.coverUrl) : undefined,
      createdAt: toTimestamp(raw?.createdAt),
      snapshot: {
        nodes: Array.isArray(snapshot?.nodes) ? repairLegacyNodes(snapshot.nodes) : [],
        edges: Array.isArray(snapshot?.edges) ? snapshot.edges : [],
        bounds: {
          left: Number(bounds?.left || 0),
          top: Number(bounds?.top || 0),
          right: Number(bounds?.right || 0),
          bottom: Number(bounds?.bottom || 0),
        },
      },
    };
  }

function workflowSignature(template: WorkflowTemplate) {
    return JSON.stringify({
      name: template.name,
      coverUrl: template.coverUrl || "",
      nodes: template.groupSnapshot.nodes.length,
      edges: template.groupSnapshot.edges.length,
      note: template.note || "",
    });
  }

function assetSignature(template: AssetTemplate) {
    return JSON.stringify({
      projectId: template.projectId || null,
      name: template.name,
      assetType: template.assetType || "snapshot",
      referenceAssetUri: template.referenceAssetUri || "",
      coverUrl: template.coverUrl || "",
      tag: template.tag || "",
      saveLocation: template.saveLocation || "",
      nodes: template.snapshot.nodes.length,
      edges: template.snapshot.edges.length,
    });
  }

async function refreshWorkflowTemplates() {
    setWorkflowsLoading(true);
    setWorkflowsError("");
    try {
      const result = await api.getCanvasWorkflows();
      if (!Array.isArray((result as any)?.workflows)) {
        throw new Error("工作流服务返回了无效数据");
      }
      const available = (result as any)?.available === true;
      const nextWorkflows = (result as any).workflows.map((item: any) => normalizeWorkflowTemplate(item));
      setWorkflowTemplatesAvailable(available);
      setWorkflows(nextWorkflows);
      return { available, workflows: nextWorkflows };
    } catch (error) {
      setWorkflowTemplatesAvailable(false);
      setWorkflowsError(toApiErrorView(error).message || "工作流加载失败，请稍后重试");
      throw error;
    } finally {
      setWorkflowsLoading(false);
    }
  }

async function loadAssetTemplates(projectId: number) {
    const result = await api.getCanvasAssets(projectId);
    return Array.isArray((result as any)?.assets)
      ? (result as any).assets.map((item: any) => normalizeAssetTemplate(item))
      : [];
  }

async function migrateLegacyWorkflowTemplates(remoteWorkflows: WorkflowTemplate[]) {
    const raw = window.localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) return remoteWorkflows;
    let parsed: unknown;
    try {
      parsed = stripLegacyDemoMedia(JSON.parse(raw));
      window.localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(parsed));
    } catch {
      window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
      return remoteWorkflows;
    }
    try {
      const legacyWorkflows = Array.isArray(parsed) ? parsed.map((item: any) => normalizeWorkflowTemplate(item)) : [];
      if (legacyWorkflows.length === 0) {
        window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
        return remoteWorkflows;
      }
      const existing = new Set(remoteWorkflows.map(workflowSignature));
      const missing = legacyWorkflows.filter((item) => !existing.has(workflowSignature(item)));
      if (missing.length > 0) {
        await Promise.all(
          missing.map((item) =>
            api.createCanvasWorkflow({
              name: item.name,
              coverUrl: item.coverUrl,
              coverNodeId: item.coverNodeId,
              note: item.note,
              groupSnapshot: item.groupSnapshot,
            }),
          ),
        );
      }
      window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
      if (missing.length > 0) {
        return (await refreshWorkflowTemplates()).workflows;
      }
    } catch {
      // Keep the sanitized cache so a transient API failure can be retried.
    }
    return remoteWorkflows;
  }

async function migrateLegacyAssetTemplates(remoteAssets: AssetTemplate[], activeProjectId: number) {
    const raw = window.localStorage.getItem(ASSET_STORAGE_KEY);
    if (!raw) return remoteAssets;
    let parsed: unknown;
    try {
      parsed = stripLegacyDemoMedia(JSON.parse(raw));
      window.localStorage.setItem(ASSET_STORAGE_KEY, JSON.stringify(parsed));
    } catch {
      window.localStorage.removeItem(ASSET_STORAGE_KEY);
      return remoteAssets;
    }
    const legacyAssets = Array.isArray(parsed) ? parsed.map((item: any) => normalizeAssetTemplate(item)) : [];
    if (legacyAssets.length === 0) {
      window.localStorage.removeItem(ASSET_STORAGE_KEY);
      return remoteAssets;
    }
    // Legacy snapshots without a project owner cannot be safely attached to
    // whichever project happens to be open now. Keep them in legacy storage
    // instead of silently leaking them into another project's catalog.
    if (legacyAssets.some((item) => !item.projectId)) return remoteAssets;
    const existing = new Set(remoteAssets.map(assetSignature));
    const missing = legacyAssets.filter((item) => !existing.has(assetSignature(item)));
    if (missing.length > 0) {
      await Promise.all(
        missing.map((item) =>
          api.createCanvasAsset({
            projectId: item.projectId!,
            name: item.name,
            saveLocation: item.saveLocation,
            tag: item.tag || item.category,
            coverUrl: item.coverUrl,
            nodes: item.snapshot.nodes,
            edges: item.snapshot.edges,
            bounds: item.snapshot.bounds,
          }),
        ),
      );
    }
    window.localStorage.removeItem(ASSET_STORAGE_KEY);
    return missing.length > 0 ? loadAssetTemplates(activeProjectId) : remoteAssets;
  }

function openCreateWorkflowModal() {
    if (!activeGroup || !activeGroupBounds) return;
    const defaultCoverNode = workflowCoverCandidates[0] ?? null;
    setWorkflowName(activeGroup.title || "新建工作流");
    setWorkflowCoverNodeId(defaultCoverNode?.id ?? null);
    setWorkflowNote("");
    setCreateWorkflowModalOpen(true);
  }

async function createWorkflowFromGroup() {
    if (!activeGroup) return;
    const groupNodes = nodes.filter((node) => activeGroup.nodeIds.includes(node.id));
    if (groupNodes.length === 0) return;

    const minX = Math.min(...groupNodes.map((n) => n.x));
    const minY = Math.min(...groupNodes.map((n) => n.y));
    const maxX = Math.max(...groupNodes.map((n) => n.x + n.width));
    const maxY = Math.max(...groupNodes.map((n) => n.y + n.height));
    const member = new Set(groupNodes.map((n) => n.id));
    const selectedCoverNode =
      groupNodes.find((node) => node.id === workflowCoverNodeId) ??
      groupNodes.find((node) => node.type === "image" && (node.imageUrl || node.localPreviewUrl)) ??
      groupNodes.find((node) => node.type === "video" && (node.videoUrl || node.localVideoUrl)) ??
      null;
    const coverUrl = selectedCoverNode
      ? selectedCoverNode.type === "video"
        ? selectedCoverNode.videoUrl || selectedCoverNode.localVideoUrl || ""
        : selectedCoverNode.imageUrl || selectedCoverNode.localPreviewUrl || ""
      : "";

    const template: WorkflowTemplate = {
      id: `wf_${Date.now()}`,
      name: workflowName.trim() || "新建工作流",
      createdAt: Date.now(),
      coverUrl,
      coverNodeId: selectedCoverNode?.id,
      note: workflowNote.trim(),
      groupSnapshot: {
        nodes: groupNodes.map((node) => ({ ...node, x: node.x - minX, y: node.y - minY })),
        edges: edges.filter((edge) => member.has(edge.fromNodeId) && member.has(edge.toNodeId)),
        layoutMode: activeGroup.layoutMode,
        themeColor: activeGroup.themeColor,
        bounds: { left: minX, top: minY, right: maxX, bottom: maxY },
      },
    };

    const created = await api
      .createCanvasWorkflow({
        name: template.name,
        coverUrl: template.coverUrl,
        coverNodeId: template.coverNodeId,
        note: template.note,
        groupSnapshot: template.groupSnapshot,
      })
      .catch(() => null);

    if (!created) {
      setStatus("工作流保存失败");
      return;
    }

    const createdWorkflow = (created as any).workflow;
    const storedLocally = createdWorkflow?.userId === "local";
    const nextTemplate = normalizeWorkflowTemplate(createdWorkflow);
    setWorkflows((prev) => [nextTemplate, ...prev.filter((item) => item.id !== nextTemplate.id)]);
    setCreateWorkflowModalOpen(false);
    setWorkflowPanelOpen(true);
    setStatus(storedLocally
      ? `工作流「${nextTemplate.name}」仅保存在当前浏览器，未同步云端`
      : `工作流「${nextTemplate.name}」已保存到云端`);
  }

function applyWorkflow(template: WorkflowTemplate) {
    if (template.groupSnapshot.nodes.length === 0) {
      setStatus("该预设没有可用节点");
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const usableLayout = getCanvasUsableLayout(rect.width, assetManagerOpen);
    const center = toWorld(rect.left + usableLayout.centerX, rect.top + rect.height / 2);
    const width = template.groupSnapshot.bounds.right - template.groupSnapshot.bounds.left;
    const height = template.groupSnapshot.bounds.bottom - template.groupSnapshot.bounds.top;
    const offsetX = center.x - width / 2;
    const offsetY = center.y - height / 2;

    const idMap = new Map<string, string>();
    const stamp = Date.now();

    const newNodes = template.groupSnapshot.nodes.map((node, index) => {
      const id = `node_${stamp}_${index}_${Math.floor(Math.random() * 1000)}`;
      idMap.set(node.id, id);
      return { ...node, id, x: offsetX + node.x, y: offsetY + node.y };
    }).map((node) => remapCanvasArtifactNode(node, idMap));

    const newEdges = template.groupSnapshot.edges
      .map((edge, index) => {
        const from = idMap.get(edge.fromNodeId);
        const to = idMap.get(edge.toNodeId);
        if (!from || !to) return null;
        return { ...edge, id: `edge_${stamp}_${index}_${Math.floor(Math.random() * 1000)}`, fromNodeId: from, toNodeId: to };
      })
      .filter((edge): edge is EdgeData => Boolean(edge));

    const groupId = `group_${stamp}`;
    setNodes((prev) => [...prev, ...newNodes]);
    setEdges((prev) => [...prev, ...newEdges]);
    setGroups((prev) => [...prev, { id: groupId, nodeIds: newNodes.map((node) => node.id), layoutMode: template.groupSnapshot.layoutMode, themeColor: template.groupSnapshot.themeColor, title: template.name }]);
    setSelectedNodeIds(newNodes.map((node) => node.id));
    setSelectedEdgeIds([]);
    setActiveGroupId(groupId);
    setWorkflowPanelOpen(false);
  }

async function removeWorkflow(id: string) {
    if (!canDelete) return;
    const removed = workflows.find((workflow) => workflow.id === id);
    const deleted = await api.deleteCanvasWorkflow(id).catch(() => null);
    if (!deleted) {
      setStatus("删除工作流失败");
      return;
    }
    setWorkflows((prev) => prev.filter((workflow) => workflow.id !== id));
    if (removed) {
      setStatus(`工作流「${removed.name}」已删除`);
    }
  }

function openCreateAssetModal() {
    if (selectedNodeIds.length === 0) return;
    setAssetCreateMode("snapshot");
    setAssetName("\u4eba\u50cf\u8d44\u4ea7");
    setAssetCategory("\u5176\u5b83");
    setAssetSaveLocation(ASSET_SAVE_LOCATIONS[0]);
    setAssetSaveTag(ASSET_TAGS[0]);
    setAssetCreateModalOpen(true);
  }

function openCreatePortraitAssetModal() {
    setAssetCreateMode("portrait");
    setAssetName("\u4eba\u50cf\u8d44\u4ea7");
    setAssetCategory("\u5176\u5b83");
    setAssetSaveLocation(ASSET_SAVE_LOCATIONS[0]);
    setAssetSaveTag("\u4eba\u7269");
    setPortraitAssetUri("asset://");
    setPortraitPreviewUrl("");
    setAssetCreateModalOpen(true);
  }

async function createAssetFromSelection() {
    if (selectedNodeIds.length === 0) return;
    const selectedSet = new Set(selectedNodeIds);
    const selectedNodes = nodes.filter((node) => selectedSet.has(node.id));
    const mediaNodes = selectedNodes.filter((node) => (node.type === "image" && (node.imageUrl || node.localPreviewUrl)) || (node.type === "video" && (node.videoUrl || node.localVideoUrl)));
    if (mediaNodes.length === 0) return;
    const ownerProjectId = effectiveAssetProjectId;
    if (ownerProjectId === null) {
      setStatus("请先选择项目，再保存看板资产");
      return;
    }

    const createdAssets = mediaNodes.map((node, index) => {
      const coverUrl = node.type === "video" ? node.videoUrl || node.localVideoUrl : node.imageUrl || node.localPreviewUrl;
      const normalizedNode = { ...node, id: "asset_node_0", x: 0, y: 0 };
      const template: AssetTemplate = {
        id: `asset_${Date.now()}_${index}`,
        projectId: ownerProjectId,
        name: node.title || `${assetName.trim() || "资产"} ${index + 1}`,
        category: normalizeAssetCategory(assetSaveTag),
        saveLocation: assetSaveLocation,
        tag: assetSaveTag,
        coverUrl,
        createdAt: Date.now(),
        snapshot: {
          nodes: [normalizedNode],
          edges: [],
          bounds: { left: 0, top: 0, right: node.width, bottom: node.height },
        },
      };
      return template;
    });

    const createdRemoteAssets = await Promise.all(
      createdAssets.map((item) =>
        api
          .createCanvasAsset({
            projectId: ownerProjectId,
            name: item.name,
            saveLocation: item.saveLocation,
            tag: item.tag || item.category,
            coverUrl: item.coverUrl,
            nodes: item.snapshot.nodes,
            edges: item.snapshot.edges,
            bounds: item.snapshot.bounds,
          })
          .then((result) => ({ ...normalizeAssetTemplate((result as any).asset), projectId: ownerProjectId }))
          .catch(() => null),
      ),
    );

    const validAssets = createdRemoteAssets.filter(
      (item): item is NonNullable<typeof item> => item !== null,
    );
    if (validAssets.length === 0) {
      setStatus("保存资产失败");
      return;
    }

    setAssets((prev) => [...validAssets, ...prev.filter((asset) => !validAssets.some((next) => next.id === asset.id))]);
    setAssetCreateModalOpen(false);
    setAssetManagerOpen(true);
    setAssetManagerTab("asset");
    setAssetDetailId(null);
    setStatus(`已保存 ${validAssets.length} 个资产`);
  }

async function createPortraitAsset() {
    const nextName = assetName.trim() || "未命名人像资产";
    const nextReferenceAssetUri = portraitAssetUri.trim();
    const nextPreviewUrl = portraitPreviewUrl.trim();
    if (!isAssetUri(nextReferenceAssetUri)) {
      setStatus("请输入有效的 asset:// 资产地址");
      return;
    }
    if (!nextPreviewUrl) {
      setStatus("请先选择预览图");
      return;
    }
    const ownerProjectId = effectiveAssetProjectId;
    if (ownerProjectId === null) {
      setStatus("请先选择项目，再创建人像资产");
      return;
    }

    const portraitNode = buildPortraitReferenceNode(nextName, nextPreviewUrl, nextReferenceAssetUri);
    const created = await api
      .createCanvasAsset({
        projectId: ownerProjectId,
        name: nextName,
        saveLocation: assetSaveLocation,
        tag: assetSaveTag || "人物",
        coverUrl: nextPreviewUrl,
        assetType: "portrait",
        referenceAssetUri: nextReferenceAssetUri,
        nodes: [portraitNode],
        edges: [],
        bounds: { left: 0, top: 0, right: portraitNode.width, bottom: portraitNode.height },
      })
      .then((result) => ({ ...normalizeAssetTemplate((result as any).asset), projectId: ownerProjectId }))
      .catch(() => null);

    if (!created) {
      setStatus("保存资产失败");
      return;
    }

    setAssets((prev) => [created, ...prev.filter((asset) => asset.id !== created.id)]);
    setAssetCreateModalOpen(false);
    setAssetManagerOpen(true);
    setAssetManagerTab("asset");
    setAssetDetailId(null);
    setStatus(`已创建人像资产：${created.name}`);
  }

function appendAssetSnapshot(
    snapshot: AssetSnapshot,
    mode: "all" | "single",
    singleNodeId?: string,
    targetWorld?: { x: number; y: number },
  ) {
    let center = targetWorld;
    if (!center) {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const usableLayout = getCanvasUsableLayout(rect.width, assetManagerOpen);
      center = toWorld(rect.left + usableLayout.centerX, rect.top + rect.height / 2);
    }

    const sourceNodes = mode === "single" && singleNodeId ? snapshot.nodes.filter((node) => node.id === singleNodeId) : snapshot.nodes;
    if (sourceNodes.length === 0) return;
    const sourceSet = new Set(sourceNodes.map((node) => node.id));
    const sourceEdges = snapshot.edges.filter((edge) => sourceSet.has(edge.fromNodeId) && sourceSet.has(edge.toNodeId));

    const minX = Math.min(...sourceNodes.map((node) => node.x));
    const minY = Math.min(...sourceNodes.map((node) => node.y));
    const maxX = Math.max(...sourceNodes.map((node) => node.x + node.width));
    const maxY = Math.max(...sourceNodes.map((node) => node.y + node.height));
    const offsetX = center.x - (minX + maxX) / 2;
    const offsetY = center.y - (minY + maxY) / 2;

    const idMap = new Map<string, string>();
    const stamp = Date.now();
    const newNodes = sourceNodes.map((node, index) => {
      const nextId = `node_${stamp}_asset_${index}_${Math.floor(Math.random() * 1000)}`;
      idMap.set(node.id, nextId);
      return { ...node, id: nextId, x: node.x + offsetX, y: node.y + offsetY };
    }).map((node) => remapCanvasArtifactNode(node, idMap));
    const newEdges = sourceEdges
      .map((edge, index) => {
        const from = idMap.get(edge.fromNodeId);
        const to = idMap.get(edge.toNodeId);
        if (!from || !to) return null;
        return { ...edge, id: `edge_${stamp}_asset_${index}`, fromNodeId: from, toNodeId: to };
      })
      .filter((edge): edge is EdgeData => Boolean(edge));

    setNodes((prev) => [...prev, ...newNodes]);
    setEdges((prev) => [...prev, ...newEdges]);
    setSelectedNodeIds(newNodes.map((node) => node.id));
    setSelectedEdgeIds(newEdges.map((edge) => edge.id));
    setActiveNodeId(newNodes.length === 1 ? newNodes[0].id : null);
    setStatus(mode === "single" ? "节点已添加到画布" : "资产已添加到画布");
  }

function applyAsset(template: AssetTemplate) {
    appendAssetSnapshot(template.snapshot, "all");
    if (template.assetType === "portrait") {
      setStatus("人像资产已添加到画布");
    }
  }

function appendProjectAssetCatalogItem(
    item: ProjectAssetCatalogItem,
    targetWorld?: { x: number; y: number },
  ) {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const usableLayout = getCanvasUsableLayout(rect.width, assetManagerOpen);
    const center = targetWorld ?? toWorld(rect.left + usableLayout.centerX, rect.top + rect.height / 2);
    const nodeType: NodeType = item.previewUrl && item.mediaKind === "video"
      ? "video"
      : item.previewUrl && item.mediaKind === "audio"
        ? "audio"
        : item.previewUrl && item.mediaKind === "image"
          ? "image"
          : "text";
    const id = `node_${Date.now()}_project_asset_${item.assetId}`;
    const nextIndex = (nodeSerialCounter[nodeType] ?? 0) + 1;
    const nextNode: NodeData = {
      ...createNode(id, nodeType, center.x, center.y),
      title: item.name || defaultNodeTitle(nodeType, nextIndex),
      titleCustomized: true,
      prompt: item.description === "项目资产" ? "" : item.description,
      fileName: item.name,
      referenceAssetUri: `asset://${item.assetId}`,
      assetVersionId: item.assetVersionId || undefined,
      imageUrl: nodeType === "image" ? item.previewUrl || undefined : undefined,
      primaryImageUrl: nodeType === "image" ? item.previewUrl || undefined : undefined,
      videoUrl: nodeType === "video" ? item.previewUrl || undefined : undefined,
      audioUrl: nodeType === "audio" ? item.previewUrl || undefined : undefined,
      textVisited: nodeType === "text",
      taskStatus: item.previewUrl ? "success" : "idle",
      generationState: "idle",
      isGenerating: false,
    };
    setNodes((previous) => [...previous, nextNode]);
    setNodeSerialCounter((previous) => ({ ...previous, [nodeType]: nextIndex }));
    setSelectedNodeIds([id]);
    setSelectedEdgeIds([]);
    setActiveNodeId(id);
    setStatus(`项目资产「${item.name}」已放入看板`);
    window.setTimeout(() => void persistCanvas(), 40);
  }

function applyAssetCatalogItem(
    item: AssetCatalogItem,
    targetWorld?: { x: number; y: number },
  ) {
    if (item.source === "project-asset") {
      appendProjectAssetCatalogItem(item, targetWorld);
      return;
    }
    const template = assets.find((asset) => asset.id === item.snapshotId);
    if (!template) {
      setStatus("这个看板快照已经失效，请刷新资产列表");
      return;
    }
    appendAssetSnapshot(template.snapshot, "all", undefined, targetWorld);
    setStatus(`看板资产「${item.name}」已放入看板`);
  }

function applySingleAssetNode(template: AssetTemplate, nodeId: string) {
    appendAssetSnapshot(template.snapshot, "single", nodeId);
  }
  return { normalizeWorkflowTemplate, normalizeAssetTemplate, workflowSignature, assetSignature, refreshWorkflowTemplates, loadAssetTemplates, migrateLegacyWorkflowTemplates, migrateLegacyAssetTemplates, openCreateWorkflowModal, createWorkflowFromGroup, applyWorkflow, removeWorkflow, openCreateAssetModal, openCreatePortraitAssetModal, createAssetFromSelection, createPortraitAsset, appendAssetSnapshot, applyAsset, appendProjectAssetCatalogItem, applyAssetCatalogItem, applySingleAssetNode };
}
