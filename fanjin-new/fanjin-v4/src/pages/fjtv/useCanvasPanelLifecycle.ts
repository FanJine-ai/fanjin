import type { ThemeMode } from "@/ui/theme";
import { useEffect, type DependencyList, type Dispatch, type SetStateAction, type RefObject, type ReactNode, type JSX } from "react";
import type { AssetManagerTab } from "./canvasDataTypes";

interface UseCanvasAssetManagerNotificationContext {
  onAssetManagerOpenChange: ((open: boolean) => void) | undefined;
  assetManagerOpen: boolean;
}

export function useCanvasAssetManagerNotification(readContext: () => UseCanvasAssetManagerNotificationContext, dependencies: DependencyList) {
  useEffect(() => {
    const { onAssetManagerOpenChange, assetManagerOpen } = readContext();

    onAssetManagerOpenChange?.(assetManagerOpen);

  }, dependencies);
}

interface UseCanvasAssetManagerCloseRequestContext {
  assetManagerCloseRequest: number;
  previousAssetManagerCloseRequestRef: RefObject<number>;
  setOpenNodeMenuId: Dispatch<SetStateAction<string | null>>;
  setSidebarRenamingNodeId: Dispatch<SetStateAction<string | null>>;
  setAssetManagerOpen: Dispatch<SetStateAction<boolean>>;
}

export function useCanvasAssetManagerCloseRequest(readContext: () => UseCanvasAssetManagerCloseRequestContext, dependencies: DependencyList) {
  useEffect(() => {
    const { assetManagerCloseRequest, previousAssetManagerCloseRequestRef, setOpenNodeMenuId, setSidebarRenamingNodeId, setAssetManagerOpen } = readContext();

    const nextRequest = Number.isFinite(assetManagerCloseRequest)
      ? Math.max(0, Math.trunc(assetManagerCloseRequest))
      : 0;
    const previousRequest = previousAssetManagerCloseRequestRef.current;
    previousAssetManagerCloseRequestRef.current = nextRequest;
    if (nextRequest <= previousRequest) return;

    setOpenNodeMenuId(null);
    setSidebarRenamingNodeId(null);
    setAssetManagerOpen(false);

  }, dependencies);
}

interface UseCanvasAssetManagerToggleRequestContext {
  assetManagerToggleRequest: number;
  previousAssetManagerToggleRequestRef: RefObject<number>;
  setOpenNodeMenuId: Dispatch<SetStateAction<string | null>>;
  setSidebarRenamingNodeId: Dispatch<SetStateAction<string | null>>;
  selectAssetManagerTab: (nextTab: AssetManagerTab, moveFocus?: boolean) => void;
  setAssetManagerOpen: Dispatch<SetStateAction<boolean>>;
}

export function useCanvasAssetManagerToggleRequest(readContext: () => UseCanvasAssetManagerToggleRequestContext, dependencies: DependencyList) {
  useEffect(() => {
    const { assetManagerToggleRequest, previousAssetManagerToggleRequestRef, setOpenNodeMenuId, setSidebarRenamingNodeId, selectAssetManagerTab, setAssetManagerOpen } = readContext();

    const nextRequest = Number.isFinite(assetManagerToggleRequest)
      ? Math.max(0, Math.trunc(assetManagerToggleRequest))
      : 0;
    const previousRequest = previousAssetManagerToggleRequestRef.current;
    previousAssetManagerToggleRequestRef.current = nextRequest;
    const requestCount = nextRequest - previousRequest;
    if (requestCount <= 0) return;

    if (requestCount % 2 === 0) return;
    setOpenNodeMenuId(null);
    setSidebarRenamingNodeId(null);
    selectAssetManagerTab("asset");
    setAssetManagerOpen((open) => !open);

  }, dependencies);
}

interface UseCanvasProjectDeleteFocusContext {
  projectDeleteConfirmId: string | null;
  projectDeleteCancelRef: RefObject<HTMLButtonElement | null>;
}

export function useCanvasProjectDeleteFocus(readContext: () => UseCanvasProjectDeleteFocusContext, dependencies: DependencyList) {
  useEffect(() => {
    const { projectDeleteConfirmId, projectDeleteCancelRef } = readContext();

    if (!projectDeleteConfirmId) return;
    const frame = window.requestAnimationFrame(() => projectDeleteCancelRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);

  }, dependencies);
}

interface UseCanvasCancelGenerationFocusContext {
  cancelGenerationConfirmNodeId: string | null;
  cancelGenerationReturnRef: RefObject<HTMLButtonElement | null>;
}

export function useCanvasCancelGenerationFocus(readContext: () => UseCanvasCancelGenerationFocusContext, dependencies: DependencyList) {
  useEffect(() => {
    const { cancelGenerationConfirmNodeId, cancelGenerationReturnRef } = readContext();

    if (!cancelGenerationConfirmNodeId) return;
    const frame = window.requestAnimationFrame(() => cancelGenerationReturnRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);

  }, dependencies);
}

interface UseCanvasShareFocusContext {
  canvasShareOverlay: "menu" | "pointsPopover" | "user" | null;
  canvasSharePopoverRef: RefObject<HTMLDivElement | null>;
}

export function useCanvasShareFocus(readContext: () => UseCanvasShareFocusContext, dependencies: DependencyList) {
  useEffect(() => {
    const { canvasShareOverlay, canvasSharePopoverRef } = readContext();

    if (!canvasShareOverlay) return;
    const frame = window.requestAnimationFrame(() => {
      const popover = canvasSharePopoverRef.current;
      const firstAction = popover?.querySelector<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      (firstAction || popover)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);

  }, dependencies);
}

interface UseCanvasGroupExecutionFocusContext {
  groupExecutionDialog: { groupId: string; } | null;
  groupExecutionCancelRef: RefObject<HTMLButtonElement | null>;
}

export function useCanvasGroupExecutionFocus(readContext: () => UseCanvasGroupExecutionFocusContext, dependencies: DependencyList) {
  useEffect(() => {
    const { groupExecutionDialog, groupExecutionCancelRef } = readContext();

    if (!groupExecutionDialog) return;
    const frame = window.requestAnimationFrame(() => {
      groupExecutionCancelRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);

  }, dependencies);
}

interface UseCanvasThemeContext {
  canvasColorMode: ThemeMode;
}

export function useCanvasTheme(readContext: () => UseCanvasThemeContext, dependencies: DependencyList) {
  useEffect(() => {
    const { canvasColorMode } = readContext();

    if (typeof window === "undefined") return;
    document.documentElement.dataset.themeMode = canvasColorMode;
    document.body.dataset.themeMode = canvasColorMode;
    document.documentElement.classList.toggle("theme-light", canvasColorMode === "light");
    document.documentElement.classList.toggle("theme-dark", canvasColorMode === "dark");

  }, dependencies);
}

interface UseCanvasProjectBrowserRequestContext {
  projectBrowserToggleRequest: number;
  previousProjectBrowserToggleRequestRef: RefObject<number>;
  projectBrowserOpen: boolean;
  closeProjectBrowser: () => void;
  openProjectBrowser: (preserveCanvas?: boolean) => void;
}

export function useCanvasProjectBrowserRequest(readContext: () => UseCanvasProjectBrowserRequestContext, dependencies: DependencyList) {
  useEffect(() => {
    const { projectBrowserToggleRequest, previousProjectBrowserToggleRequestRef, projectBrowserOpen, closeProjectBrowser, openProjectBrowser } = readContext();

    const nextRequest = Number.isFinite(projectBrowserToggleRequest)
      ? Math.max(0, Math.trunc(projectBrowserToggleRequest))
      : 0;
    const previousRequest = previousProjectBrowserToggleRequestRef.current;
    previousProjectBrowserToggleRequestRef.current = nextRequest;
    const requestCount = nextRequest - previousRequest;
    if (requestCount <= 0 || requestCount % 2 === 0) return;

    if (projectBrowserOpen) {
      closeProjectBrowser();
      return;
    }
    openProjectBrowser();

  }, dependencies);
}

interface UseCanvasPublicationRefreshContext {
  canvasShareOverlay: "menu" | "pointsPopover" | "user" | null;
  refreshCanvasPublications: () => Promise<void>;
}

export function useCanvasPublicationRefresh(readContext: () => UseCanvasPublicationRefreshContext, dependencies: DependencyList) {
  useEffect(() => {
    const { canvasShareOverlay, refreshCanvasPublications } = readContext();

    if (canvasShareOverlay !== "menu") return;
    void refreshCanvasPublications();

  }, dependencies);
}

interface UseCanvasHistoryLoadingContext {
  historyPanelOpen: boolean;
  loadHistoryItems: () => Promise<void>;
}

export function useCanvasHistoryLoading(readContext: () => UseCanvasHistoryLoadingContext, dependencies: DependencyList) {
  useEffect(() => {
    const { historyPanelOpen, loadHistoryItems } = readContext();

    if (!historyPanelOpen) return;
    void loadHistoryItems();

  }, dependencies);
}

interface UseCanvasProjectBrowserEntryContext {
  openProjectBrowserOnEntry: boolean;
  setProjectBrowserOpen: Dispatch<SetStateAction<boolean>>;
  setProjectMenuOpen: Dispatch<SetStateAction<boolean>>;
  setCanvasSwitcherOpen: Dispatch<SetStateAction<boolean>>;
  clearEntryQueryFlags: (flagNames: string[]) => void;
}

export function useCanvasProjectBrowserEntry(readContext: () => UseCanvasProjectBrowserEntryContext, dependencies: DependencyList) {
  useEffect(() => {
    const { openProjectBrowserOnEntry, setProjectBrowserOpen, setProjectMenuOpen, setCanvasSwitcherOpen, clearEntryQueryFlags } = readContext();

    if (!openProjectBrowserOnEntry) return;
    setProjectBrowserOpen(true);
    setProjectMenuOpen(false);
    setCanvasSwitcherOpen(false);
    // `browser=projects` is an entry signal, not durable route state. Consume
    // it now so opening a project does not reopen the browser after refresh.
    clearEntryQueryFlags(["browser"]);

  }, dependencies);
}
