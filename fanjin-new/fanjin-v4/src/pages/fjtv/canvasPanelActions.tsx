import { type PendingConnection } from "./canvasDataTypes";

export interface CanvasPanelActionsDependencies {
  closePromptMenus: () => void;
  setCreationMenu: React.Dispatch<React.SetStateAction<import("@/pages/fjtv/canvasDataTypes").CreationMenuState>>;
  setPendingConnection: React.Dispatch<React.SetStateAction<PendingConnection | null>>;
  setWorkflowPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setHistoryPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShortcutPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeComposeEditor: () => void;
  closeVideoEditor: () => void;
}

export function createCanvasPanelActions({
  closePromptMenus,
  setCreationMenu,
  setPendingConnection,
  setWorkflowPanelOpen,
  setHistoryPanelOpen,
  setShortcutPanelOpen,
  closeComposeEditor,
  closeVideoEditor,
}: CanvasPanelActionsDependencies) {
function closeBottomPanels() {
    closePromptMenus();
    setCreationMenu((prev) => ({ ...prev, open: false }));
    setPendingConnection(null);
    setWorkflowPanelOpen(false);
    setHistoryPanelOpen(false);
    setShortcutPanelOpen(false);
    closeComposeEditor();
    closeVideoEditor();
  }
  return { closeBottomPanels };
}
