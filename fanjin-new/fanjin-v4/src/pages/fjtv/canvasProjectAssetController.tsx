import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { WorkflowTemplate, AssetSnapshot, AssetTemplate, HistoryAssetItem } from "./canvasDataTypes";
import { api } from "@/lib/api";
import { type AssetCatalogItem, type ProjectAssetCatalogItem } from "@/features/assets/assetCatalog";

export interface CanvasProjectAssetControllerDependencies {
  canDelete: boolean;
  setHistoryItems: Dispatch<SetStateAction<HistoryAssetItem[]>>;
  historyPreviewItem: HistoryAssetItem | null;
  setHistoryPreviewItem: Dispatch<SetStateAction<HistoryAssetItem | null>>;
  setStatus: Dispatch<SetStateAction<string>>;
  templateController: () => { normalizeWorkflowTemplate: (raw: any) => WorkflowTemplate; normalizeAssetTemplate: (raw: any) => AssetTemplate; workflowSignature: (template: WorkflowTemplate) => string; assetSignature: (template: AssetTemplate) => string; refreshWorkflowTemplates: () => Promise<{ available: boolean; workflows: any; }>; loadAssetTemplates: (projectId: number) => Promise<any>; migrateLegacyWorkflowTemplates: (remoteWorkflows: WorkflowTemplate[]) => Promise<any>; migrateLegacyAssetTemplates: (remoteAssets: AssetTemplate[], activeProjectId: number) => Promise<any>; openCreateWorkflowModal: () => void; createWorkflowFromGroup: () => Promise<void>; applyWorkflow: (template: WorkflowTemplate) => void; removeWorkflow: (id: string) => Promise<void>; openCreateAssetModal: () => void; openCreatePortraitAssetModal: () => void; createAssetFromSelection: () => Promise<void>; createPortraitAsset: () => Promise<void>; appendAssetSnapshot: (snapshot: AssetSnapshot, mode: "all" | "single", singleNodeId?: string, targetWorld?: { x: number; y: number; }) => void; applyAsset: (template: AssetTemplate) => void; appendProjectAssetCatalogItem: (item: ProjectAssetCatalogItem, targetWorld?: { x: number; y: number; }) => void; applyAssetCatalogItem: (item: AssetCatalogItem, targetWorld?: { x: number; y: number; }) => void; applySingleAssetNode: (template: AssetTemplate, nodeId: string) => void; };
}

export function createCanvasProjectAssetController(deps: CanvasProjectAssetControllerDependencies) {
  const { canDelete, setHistoryItems, historyPreviewItem, setHistoryPreviewItem, setStatus, templateController } = deps;
async function deleteHistoryItem(item: HistoryAssetItem) {
    if (!canDelete) return;
    try {
      await api.deleteAiHistory([item.id]);
      setHistoryItems((prev) => prev.filter((entry) => entry.id !== item.id));
      if (historyPreviewItem?.id === item.id) setHistoryPreviewItem(null);
      setStatus("历史资产已删除");
    } catch (error: any) {
      setStatus(error instanceof Error ? error.message : "删除历史资产失败");
    }
  }

function appendAssetSnapshot(
    snapshot: AssetSnapshot,
    mode: "all" | "single",
    singleNodeId?: string,
    targetWorld?: { x: number; y: number },
  ) { return templateController().appendAssetSnapshot(snapshot, mode, singleNodeId, targetWorld); }

function appendProjectAssetCatalogItem(
    item: ProjectAssetCatalogItem,
    targetWorld?: { x: number; y: number },
  ) { return templateController().appendProjectAssetCatalogItem(item, targetWorld); }

function applyAssetCatalogItem(
    item: AssetCatalogItem,
    targetWorld?: { x: number; y: number },
  ) { return templateController().applyAssetCatalogItem(item, targetWorld); }

function applySingleAssetNode(template: AssetTemplate, nodeId: string) { return templateController().applySingleAssetNode(template, nodeId); }
  return { deleteHistoryItem, appendAssetSnapshot, appendProjectAssetCatalogItem, applyAssetCatalogItem, applySingleAssetNode };
}
