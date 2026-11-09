import { ASSET_SAVE_LOCATIONS, ASSET_TAGS } from "./canvasPageConstants";
import { useRef, useState } from "react";

export function useCanvasProjectRenameState() {
  const [folderCreateToastOpen, setFolderCreateToastOpen] = useState(false);
  const [projectBrowserRenamingId, setProjectBrowserRenamingId] = useState<string | null>(null);
  const [projectBrowserRenameDraft, setProjectBrowserRenameDraft] = useState("");
  const [headerProjectRenaming, setHeaderProjectRenaming] = useState(false);
  const [headerProjectRenameDraft, setHeaderProjectRenameDraft] = useState("");
  const [canvasRenamingId, setCanvasRenamingId] = useState<string | null>(null);
  const [canvasRenameDraft, setCanvasRenameDraft] = useState("");
  const [assetSaveLocation, setAssetSaveLocation] = useState(ASSET_SAVE_LOCATIONS[0]);
  const [assetSaveTag, setAssetSaveTag] = useState(ASSET_TAGS[0]);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [historyQuickOpen, setHistoryQuickOpen] = useState(false);
  const [shortcutPanelOpen, setShortcutPanelOpen] = useState(false);
  const [canvasShareOverlay, setCanvasShareOverlay] = useState<"menu" | "pointsPopover" | "user" | null>(null);
  const canvasShareTriggerRef = useRef<HTMLButtonElement | null>(null);
  const canvasSharePopoverRef = useRef<HTMLDivElement | null>(null);
  return {
    folderCreateToastOpen, setFolderCreateToastOpen,
    projectBrowserRenamingId, setProjectBrowserRenamingId,
    projectBrowserRenameDraft, setProjectBrowserRenameDraft,
    headerProjectRenaming, setHeaderProjectRenaming,
    headerProjectRenameDraft, setHeaderProjectRenameDraft,
    canvasRenamingId, setCanvasRenamingId,
    canvasRenameDraft, setCanvasRenameDraft,
    assetSaveLocation, setAssetSaveLocation,
    assetSaveTag, setAssetSaveTag,
    historyPanelOpen, setHistoryPanelOpen,
    historyQuickOpen, setHistoryQuickOpen,
    shortcutPanelOpen, setShortcutPanelOpen,
    canvasShareOverlay, setCanvasShareOverlay,
    canvasShareTriggerRef, canvasSharePopoverRef,
  };
}
