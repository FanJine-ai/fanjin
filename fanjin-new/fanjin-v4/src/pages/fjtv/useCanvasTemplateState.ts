import type { CanvasAssetType, WorkflowTemplate, AssetTemplate } from "./canvasDataTypes";
import { useState } from "react";

export function useCanvasTemplateState() {
  const [workflowPanelOpen, setWorkflowPanelOpen] = useState(false);
  const [createWorkflowModalOpen, setCreateWorkflowModalOpen] = useState(false);
  const [workflowName, setWorkflowName] = useState("");
  const [workflowCoverNodeId, setWorkflowCoverNodeId] = useState<string | null>(null);
  const [workflowNote, setWorkflowNote] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [workflowTemplatesAvailable, setWorkflowTemplatesAvailable] = useState(false);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);
  const [workflowsError, setWorkflowsError] = useState("");

  const [assetCreateModalOpen, setAssetCreateModalOpen] = useState(false);
  const [assetDetailId, setAssetDetailId] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetTemplate[]>([]);
  const [canvasAssetsLoading, setCanvasAssetsLoading] = useState(false);
  const [canvasAssetsError, setCanvasAssetsError] = useState("");
  const [assetCreateMode, setAssetCreateMode] = useState<CanvasAssetType>("snapshot");
  const [assetName, setAssetName] = useState("");
  const [assetCategory, setAssetCategory] = useState<AssetTemplate["category"]>("人物");
  const [portraitAssetUri, setPortraitAssetUri] = useState("");
  const [portraitPreviewUrl, setPortraitPreviewUrl] = useState("");
  return {
    workflowPanelOpen, setWorkflowPanelOpen,
    createWorkflowModalOpen, setCreateWorkflowModalOpen,
    workflowName, setWorkflowName,
    workflowCoverNodeId, setWorkflowCoverNodeId,
    workflowNote, setWorkflowNote,
    workflows, setWorkflows,
    workflowTemplatesAvailable, setWorkflowTemplatesAvailable,
    workflowsLoading, setWorkflowsLoading,
    workflowsError, setWorkflowsError,
    assetCreateModalOpen, setAssetCreateModalOpen,
    assetDetailId, setAssetDetailId,
    assets, setAssets,
    canvasAssetsLoading, setCanvasAssetsLoading,
    canvasAssetsError, setCanvasAssetsError,
    assetCreateMode, setAssetCreateMode,
    assetName, setAssetName,
    setAssetCategory, portraitAssetUri,
    setPortraitAssetUri, portraitPreviewUrl,
    setPortraitPreviewUrl,
  };
}
