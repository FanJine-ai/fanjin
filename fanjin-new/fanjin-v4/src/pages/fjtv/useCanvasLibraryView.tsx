import {
normalizeCanvasSnapshotCatalog,
type AssetCatalogItem,
type CanvasSnapshotCatalogItem,
type ProjectAssetCatalogItem,
} from "@/features/assets/assetCatalog";
import { clearAuth,readAuth } from "@/lib/auth-storage";
import { normalizeProjectId } from "@/stores/projectStore";
import { useMemo } from "react";
import type { NavigateFunction } from "react-router-dom";
import type {
AssetTemplate,
CanvasMetaState,
EdgeData,
GroupData,
NodeData,
ProjectCanvasItem,ProjectFolderItem,
ProjectListItem
} from "./canvasDataTypes";
import {
formatCanvasBalanceGu
} from "./canvasPricing";
import { buildSidebarGroups,filterAssetCatalogEntries,filterCanvasNodes,filterProjectsByFolder,getRootCanvasNodes,getWorkflowCoverCandidates } from "./canvasViewModel";
interface Context {
  groups: GroupData[];
  activeGroupId: string | null;
  assetDetailId: string | null;
  assets: AssetTemplate[];
  nodes: NodeData[];
  canvasNodeSearch: string;
  projects: ProjectListItem[];
  currentProjectId: string | null;
  projectCanvases: Record<string, ProjectCanvasItem[]>;
  canvasMeta: CanvasMetaState;
  canvasBalance: { refresh: () => void; loading: boolean; error: string; availableMicros: number; reservedMicros: number; baselineMicros: number; spentMicros: number; percent: number; lastRechargeAt: number | null; };
  setCanvasShareOverlay: React.Dispatch<React.SetStateAction<"menu" | "pointsPopover" | "user" | null>>;
  navigate: NavigateFunction;
  edges: EdgeData[];
  studioChrome: boolean;
  routeProjectContextId: string | number | null | undefined;
  selectedProjectId: number | null;
  projectAssetCatalogProjectId: number | null;
  projectAssetCatalog: ProjectAssetCatalogItem[];
  projectFolders: ProjectFolderItem[];
  projectBrowserFolderId: string | null;
}
export function useCanvasLibraryView({ groups, activeGroupId, assetDetailId, assets, nodes, canvasNodeSearch, projects, currentProjectId, projectCanvases, canvasMeta, canvasBalance, setCanvasShareOverlay, navigate, edges, studioChrome, routeProjectContextId, selectedProjectId, projectAssetCatalogProjectId, projectAssetCatalog, projectFolders, projectBrowserFolderId }: Context) {
  const activeGroup = useMemo(() => groups.find((group) => group.id === activeGroupId) ?? null, [groups, activeGroupId]);
  const assetDetail = useMemo(() => (assetDetailId ? assets.find((item) => item.id === assetDetailId) ?? null : null), [assetDetailId, assets]);
  const filteredCanvasNodes = useMemo(() => filterCanvasNodes(nodes, canvasNodeSearch, true), [canvasNodeSearch, nodes]);
  const currentProject = useMemo(() => projects.find((item) => item.projectId === currentProjectId) ?? null, [projects, currentProjectId]);
  const currentProjectCanvases = useMemo(() => (currentProjectId ? projectCanvases[currentProjectId] ?? [] : []), [currentProjectId, projectCanvases]);
  const headerProjectName = currentProject?.name || canvasMeta.name || "未命名项目";
  const showStudioCanvasSwitcher =
    currentProjectCanvases.length > 1 || canvasMeta.name.trim() !== headerProjectName.trim();
  const accountBalanceLabel = canvasBalance.loading
    ? "读取中…"
    : canvasBalance.error
      ? "暂不可用"
      : `${formatCanvasBalanceGu(canvasBalance.availableMicros)} GU`;
  const accountProfile = useMemo(() => {
    const auth = readAuth() as any;
    const displayName = auth?.nickname || (auth?.phone ? `微信用户${String(auth.phone).slice(-5)}` : "当前用户");
    return {
      displayName,
      avatarUrl: auth?.avatarUrl || "",
      userId: auth?.userId ?? auth?.id ?? "",
      initial: String(displayName || "L").trim().slice(0, 1).toUpperCase() || "L",
    };
  }, []);
  const navigateFromCanvasPanel = (path: string) => {
    setCanvasShareOverlay(null);
    navigate(path);
  };
  const handleCanvasLogout = () => {
    clearAuth();
    setCanvasShareOverlay(null);
    navigate("/login");
  };
  const groupedNodeIds = useMemo(() => new Set(groups.flatMap((group) => group.nodeIds)), [groups]);
  const rootCanvasNodes = useMemo(() => getRootCanvasNodes(nodes, edges), [edges, nodes]);
  const filteredRootCanvasNodes = useMemo(() => filterCanvasNodes(rootCanvasNodes, canvasNodeSearch), [canvasNodeSearch, rootCanvasNodes]);
  const effectiveAssetProjectId = normalizeProjectId(
    studioChrome
      ? routeProjectContextId ?? canvasMeta.projectId ?? currentProjectId
      : currentProjectId ?? selectedProjectId,
  );
  const canvasSnapshotCatalog = useMemo<CanvasSnapshotCatalogItem[]>(() => {
    if (effectiveAssetProjectId === null) return [];
    return normalizeCanvasSnapshotCatalog(
      effectiveAssetProjectId,
      assets.map((asset) => ({
        id: asset.id,
        projectId: asset.projectId,
        name: asset.name,
        tag: asset.tag || asset.category,
        coverUrl: asset.coverUrl,
        assetType: asset.assetType,
        referenceAssetUri: asset.referenceAssetUri,
        createdAt: asset.createdAt,
        snapshot: asset.snapshot,
      })),
    );
  }, [assets, effectiveAssetProjectId]);
  const assetCatalogEntries = useMemo<AssetCatalogItem[]>(() => {
    if (effectiveAssetProjectId === null) return [];
    const scopedProjectAssets = projectAssetCatalogProjectId === effectiveAssetProjectId
      ? projectAssetCatalog
      : [];
    return [...scopedProjectAssets, ...canvasSnapshotCatalog];
  }, [canvasSnapshotCatalog, effectiveAssetProjectId, projectAssetCatalog, projectAssetCatalogProjectId]);
  const filteredAssetEntries = useMemo(() => filterAssetCatalogEntries(assetCatalogEntries, canvasNodeSearch), [assetCatalogEntries, canvasNodeSearch]);
  const sidebarGroups = useMemo(() => buildSidebarGroups(groups, filteredCanvasNodes), [filteredCanvasNodes, groups]);
  const sidebarUngroupedNodes = useMemo(
    () => filteredCanvasNodes.filter((node) => !groupedNodeIds.has(node.id)),
    [filteredCanvasNodes, groupedNodeIds],
  );
  const workflowCoverCandidates = useMemo(() => getWorkflowCoverCandidates(activeGroup, nodes), [activeGroup, nodes]);
  const visibleProjects = useMemo(
    () => filterProjectsByFolder(projects, projectFolders, projectBrowserFolderId),
    [projectBrowserFolderId, projectFolders, projects],
  );
  return {
    activeGroup, filteredCanvasNodes, currentProject,
    currentProjectCanvases, headerProjectName, showStudioCanvasSwitcher,
    accountBalanceLabel, accountProfile, navigateFromCanvasPanel,
    handleCanvasLogout, effectiveAssetProjectId, assetCatalogEntries,
    filteredAssetEntries, sidebarGroups, sidebarUngroupedNodes,
    workflowCoverCandidates, visibleProjects,
  };
}
