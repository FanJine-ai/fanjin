import type * as React from "react";
import type * as Router from "react-router-dom";
import { createCanvasProjectBrowser } from "./CanvasProjectBrowser";
import { trapCanvasModalFocus } from "./canvasModalFocus";
import { CanvasCancelGenerationDialog } from "./CanvasCancelGenerationDialog";
import { CanvasProjectDeleteDialog } from "./CanvasProjectDeleteDialog";
import { type NodeData, type ProjectListItem, type ProjectFolderItem } from "./canvasDataTypes";
import { isPreparingGeneration } from "../../features/quick-create/generationPreparation";

export interface CanvasPageProjectDialogsProps {
  cancelGenerationConfirmNodeId: string | null;
  nodeMap: Map<string, NodeData>;
  cancelGenerationPending: boolean;
  cancelGenerationReturnRef: React.RefObject<HTMLButtonElement | null>;
  closeCancelGenerationDialog: ({ restoreFocus }?: { restoreFocus?: boolean | undefined; }) => void;
  confirmCancelNodeGeneration: () => Promise<void>;
  projectDeleteConfirmId: string | null;
  projectDeletePending: boolean;
  canDelete: boolean;
  projectDeleteError: string;
  projectDeleteCancelRef: React.RefObject<HTMLButtonElement | null>;
  closeProjectDeleteDialog: ({ restoreFocus }?: { restoreFocus?: boolean | undefined; }) => void;
  confirmDeleteProjectItem: () => Promise<void>;
  projectBrowserOpen: boolean;
  canvasColorMode: import("@/ui/theme").ThemeMode;
  folderCreateToastOpen: boolean;
  setFolderCreateToastOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeProjectBrowser: () => void;
  createProjectFolder: () => Promise<void>;
  projectsError: string;
  projectFoldersError: string;
  refreshProjects: (options?: { throwOnError?: boolean; }) => Promise<ProjectListItem[]>;
  refreshProjectFolders: (options?: { throwOnError?: boolean; }) => Promise<ProjectFolderItem[]>;
  projectsLoading: boolean;
  projectFoldersLoading: boolean;
  projects: ProjectListItem[];
  projectFolders: ProjectFolderItem[];
  createNewProject: () => Promise<void>;
  projectBrowserFolderId: string | null;
  setProjectBrowserFolderId: React.Dispatch<React.SetStateAction<string | null>>;
  projectBrowserRenamingId: string | null;
  projectBrowserRenameDraft: string;
  setProjectBrowserRenameDraft: React.Dispatch<React.SetStateAction<string>>;
  commitProjectBrowserRename: (id: string, kind: "project" | "folder", fallbackName: string) => Promise<void>;
  handleProjectBrowserRenameKeyDown: (event: React.KeyboardEvent<HTMLInputElement>, id: string, kind: "project" | "folder", fallbackName: string) => void;
  setFolderActionMenuId: React.Dispatch<React.SetStateAction<string | null>>;
  folderActionMenuId: string | null;
  setProjectBrowserRenamingId: React.Dispatch<React.SetStateAction<string | null>>;
  deleteFolderItem: (folderId: string) => Promise<void>;
  visibleProjects: ProjectListItem[];
  openProjectById: (projectId: string) => Promise<void>;
  setProjectActionMenuId: React.Dispatch<React.SetStateAction<string | null>>;
  projectActionMenuId: string | null;
  duplicateProjectItem: (project: ProjectListItem) => Promise<void>;
  moveProjectToFolder: (projectId: string, folderId: string) => Promise<void>;
  requestDeleteProjectItem: (projectId: string) => void;
}
export function CanvasPageProjectDialogs({
  cancelGenerationConfirmNodeId,
  nodeMap,
  cancelGenerationPending,
  cancelGenerationReturnRef,
  closeCancelGenerationDialog,
  confirmCancelNodeGeneration,
  projectDeleteConfirmId,
  projectDeletePending,
  canDelete,
  projectDeleteError,
  projectDeleteCancelRef,
  closeProjectDeleteDialog,
  confirmDeleteProjectItem,
  projectBrowserOpen,
  canvasColorMode,
  folderCreateToastOpen,
  setFolderCreateToastOpen,
  closeProjectBrowser,
  createProjectFolder,
  projectsError,
  projectFoldersError,
  refreshProjects,
  refreshProjectFolders,
  projectsLoading,
  projectFoldersLoading,
  projects,
  projectFolders,
  createNewProject,
  projectBrowserFolderId,
  setProjectBrowserFolderId,
  projectBrowserRenamingId,
  projectBrowserRenameDraft,
  setProjectBrowserRenameDraft,
  commitProjectBrowserRename,
  handleProjectBrowserRenameKeyDown,
  setFolderActionMenuId,
  folderActionMenuId,
  setProjectBrowserRenamingId,
  deleteFolderItem,
  visibleProjects,
  openProjectById,
  setProjectActionMenuId,
  projectActionMenuId,
  duplicateProjectItem,
  moveProjectToFolder,
  requestDeleteProjectItem,
}: CanvasPageProjectDialogsProps) {
  return <>
{cancelGenerationConfirmNodeId ? (
        <CanvasCancelGenerationDialog preparing={isPreparingGeneration(nodeMap.get(cancelGenerationConfirmNodeId) || {})} pending={cancelGenerationPending} returnRef={cancelGenerationReturnRef} onClose={closeCancelGenerationDialog} onConfirm={() => void confirmCancelNodeGeneration()} onTrapFocus={trapCanvasModalFocus} />
      ) : null}

      {projectDeleteConfirmId ? (
        <CanvasProjectDeleteDialog pending={projectDeletePending} canDelete={canDelete} error={projectDeleteError} cancelRef={projectDeleteCancelRef} onCancel={closeProjectDeleteDialog} onConfirm={() => void confirmDeleteProjectItem()} onTrapFocus={trapCanvasModalFocus} />
      ) : null}

      {createCanvasProjectBrowser({
      projectBrowserOpen,
      canvasColorMode,
      folderCreateToastOpen,
      setFolderCreateToastOpen,
      closeProjectBrowser,
      createProjectFolder,
      projectsError,
      projectFoldersError,
      refreshProjects,
      refreshProjectFolders,
      projectsLoading,
      projectFoldersLoading,
      projects,
      projectFolders,
      createNewProject,
      projectBrowserFolderId,
      setProjectBrowserFolderId,
      projectBrowserRenamingId,
      projectBrowserRenameDraft,
      setProjectBrowserRenameDraft,
      commitProjectBrowserRename,
      handleProjectBrowserRenameKeyDown,
      setFolderActionMenuId,
      folderActionMenuId,
      setProjectBrowserRenamingId,
      canDelete,
      deleteFolderItem,
      visibleProjects,
      openProjectById,
      setProjectActionMenuId,
      projectActionMenuId,
      duplicateProjectItem,
      moveProjectToFolder,
      projectDeleteConfirmId,
      requestDeleteProjectItem,
    })()}
</>;
}
