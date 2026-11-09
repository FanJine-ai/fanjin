import type * as React from "react";
import type * as Router from "react-router-dom";
import { ASSET_SAVE_LOCATIONS, ASSET_TAGS } from "./canvasPageConstants";
import { createCanvasAssetCreateDialog } from "./CanvasAssetCreateDialog";
import { CanvasWorkflowTemplatePanel } from "./CanvasWorkflowTemplatePanel";
import { CanvasWorkflowCreateDialog } from "./CanvasWorkflowCreateDialog";
import { type CanvasAssetType, type NodeData, type WorkflowTemplate } from "./canvasDataTypes";

export interface CanvasPageWorkflowDialogsProps {
  assetCreateModalOpen: boolean;
  assetCreateMode: CanvasAssetType;
  setAssetCreateModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  portraitPreviewUrl: string;
  assetName: string;
  portraitAssetUri: string;
  nodes: NodeData[];
  selectedNodeIds: string[];
  nodeMap: Map<string, NodeData>;
  setAssetName: React.Dispatch<React.SetStateAction<string>>;
  assetSaveLocation: string;
  setAssetSaveLocation: React.Dispatch<React.SetStateAction<string>>;
  assetSaveTag: string;
  setAssetSaveTag: React.Dispatch<React.SetStateAction<string>>;
  setPortraitAssetUri: React.Dispatch<React.SetStateAction<string>>;
  setPortraitPreviewUrl: React.Dispatch<React.SetStateAction<string>>;
  createPortraitAsset: () => Promise<void>;
  createAssetFromSelection: () => Promise<void>;
  workflowTemplatesAvailable: boolean;
  workflowPanelOpen: boolean;
  workflows: WorkflowTemplate[];
  workflowsLoading: boolean;
  workflowsError: string;
  canDelete: boolean;
  setWorkflowPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refreshWorkflowTemplates: () => Promise<{ available: boolean; workflows: any; }>;
  migrateLegacyWorkflowTemplates: (remoteWorkflows: WorkflowTemplate[]) => Promise<any>;
  setWorkflows: React.Dispatch<React.SetStateAction<WorkflowTemplate[]>>;
  removeWorkflow: (id: string) => Promise<void>;
  applyWorkflow: (template: WorkflowTemplate) => void;
  renderGroupExecutionDialog: () => React.JSX.Element | null;
  createWorkflowModalOpen: boolean;
  workflowCoverCandidates: NodeData[];
  workflowCoverNodeId: string | null;
  workflowName: string;
  workflowNote: string;
  setCreateWorkflowModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkflowCoverNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setWorkflowName: React.Dispatch<React.SetStateAction<string>>;
  setWorkflowNote: React.Dispatch<React.SetStateAction<string>>;
  createWorkflowFromGroup: () => Promise<void>;
}
export function CanvasPageWorkflowDialogs({
  assetCreateModalOpen,
  assetCreateMode,
  setAssetCreateModalOpen,
  portraitPreviewUrl,
  assetName,
  portraitAssetUri,
  nodes,
  selectedNodeIds,
  nodeMap,
  setAssetName,
  assetSaveLocation,
  setAssetSaveLocation,
  assetSaveTag,
  setAssetSaveTag,
  setPortraitAssetUri,
  setPortraitPreviewUrl,
  createPortraitAsset,
  createAssetFromSelection,
  workflowTemplatesAvailable,
  workflowPanelOpen,
  workflows,
  workflowsLoading,
  workflowsError,
  canDelete,
  setWorkflowPanelOpen,
  refreshWorkflowTemplates,
  migrateLegacyWorkflowTemplates,
  setWorkflows,
  removeWorkflow,
  applyWorkflow,
  renderGroupExecutionDialog,
  createWorkflowModalOpen,
  workflowCoverCandidates,
  workflowCoverNodeId,
  workflowName,
  workflowNote,
  setCreateWorkflowModalOpen,
  setWorkflowCoverNodeId,
  setWorkflowName,
  setWorkflowNote,
  createWorkflowFromGroup,
}: CanvasPageWorkflowDialogsProps) {
  return <>
{createCanvasAssetCreateDialog({
      assetCreateModalOpen,
      assetCreateMode,
      setAssetCreateModalOpen,
      portraitPreviewUrl,
      assetName,
      portraitAssetUri,
      nodes,
      selectedNodeIds,
      nodeMap,
      setAssetName,
      assetSaveLocation,
      setAssetSaveLocation,
      ASSET_SAVE_LOCATIONS,
      assetSaveTag,
      setAssetSaveTag,
      ASSET_TAGS,
      setPortraitAssetUri,
      setPortraitPreviewUrl,
      createPortraitAsset,
      createAssetFromSelection,
    })()}
      {workflowTemplatesAvailable && workflowPanelOpen ? <CanvasWorkflowTemplatePanel workflows={workflows} loading={workflowsLoading} error={workflowsError} canDelete={canDelete} onClose={() => setWorkflowPanelOpen(false)} onReload={() => { void refreshWorkflowTemplates().then((response) => response.available ? migrateLegacyWorkflowTemplates(response.workflows) : []).then(setWorkflows).catch(() => undefined); }} onRemove={(id) => { void removeWorkflow(id); }} onApply={applyWorkflow} /> : null}

      {renderGroupExecutionDialog()}

      {workflowTemplatesAvailable && createWorkflowModalOpen ? <CanvasWorkflowCreateDialog candidates={workflowCoverCandidates} coverNodeId={workflowCoverNodeId} name={workflowName} note={workflowNote} onClose={() => setCreateWorkflowModalOpen(false)} onCoverChange={setWorkflowCoverNodeId} onNameChange={(event) => setWorkflowName(event.target.value)} onNoteChange={(event) => setWorkflowNote(event.target.value)} onCreate={createWorkflowFromGroup} /> : null}
</>;
}
