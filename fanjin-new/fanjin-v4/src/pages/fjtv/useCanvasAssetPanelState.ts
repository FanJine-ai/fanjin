import type { AssetManagerTab } from "./canvasDataTypes";
import { useCallback, useRef, useState } from "react";

export function useCanvasAssetPanelState({ studioChrome }: { studioChrome: boolean }) {
  const [assetManagerOpen, setAssetManagerOpen] = useState(() => (
    studioChrome && (typeof window === "undefined" || window.matchMedia("(min-width: 821px)").matches)
  ));
  const [assetManagerTab, setAssetManagerTab] = useState<AssetManagerTab>("canvas");
  const [canvasNodeSearch, setCanvasNodeSearch] = useState("");
  const [openNodeMenuId, setOpenNodeMenuId] = useState<string | null>(null);
  const [sidebarRenamingNodeId, setSidebarRenamingNodeId] = useState<string | null>(null);
  const [sidebarRenameDraft, setSidebarRenameDraft] = useState("");
  const previousAssetManagerCloseRequestRef = useRef(0);
  const previousAssetManagerToggleRequestRef = useRef(0);
  const toggleAssetManager = useCallback(() => {
    setAssetManagerOpen((open) => !open);
    setOpenNodeMenuId(null);
    setSidebarRenamingNodeId(null);
  }, []);
  const selectAssetManagerTab = useCallback((nextTab: AssetManagerTab, moveFocus = false) => {
    setAssetManagerTab(nextTab);
    if (!moveFocus) return;
    window.requestAnimationFrame(() => {
      document.getElementById(nextTab === "canvas" ? "project-studio-canvas-tab" : "project-studio-assets-tab")?.focus();
    });
  }, []);
  const handleAssetManagerTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextTab: AssetManagerTab = event.key === "Home"
      ? "canvas"
      : event.key === "End"
        ? "asset"
        : assetManagerTab === "canvas"
          ? "asset"
          : "canvas";
    selectAssetManagerTab(nextTab, true);
  }, [assetManagerTab, selectAssetManagerTab]);
  return {
    assetManagerOpen, setAssetManagerOpen,
    assetManagerTab, setAssetManagerTab,
    canvasNodeSearch, setCanvasNodeSearch,
    openNodeMenuId, setOpenNodeMenuId,
    sidebarRenamingNodeId, setSidebarRenamingNodeId,
    sidebarRenameDraft, setSidebarRenameDraft,
    previousAssetManagerCloseRequestRef, previousAssetManagerToggleRequestRef,
    toggleAssetManager, selectAssetManagerTab,
    handleAssetManagerTabKeyDown,
  };
}
