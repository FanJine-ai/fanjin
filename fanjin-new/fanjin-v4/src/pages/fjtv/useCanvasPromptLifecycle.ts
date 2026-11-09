import type { VideoPromptTab } from "./canvasDataTypes";
import { useEffect, type DependencyList, type Dispatch, type SetStateAction, type RefObject, type ReactNode, type JSX } from "react";
import type { NodeData, VideoGenerationMode, VideoReferenceSummary } from "./canvasDataTypes";
import { isCanvasCatalogVideoModeSupported } from "./canvasCatalogContract";
import { isCanvasSourceVideoMode } from "./canvasVideoExtension";
import { type AiModelOption } from "@/lib/api";

interface UseCanvasReferencePickerResetContext {
  setReferencePickerOpen: Dispatch<SetStateAction<boolean>>;
  promptSelectionRef: RefObject<{ start: number; end: number; }>;
}

export function useCanvasReferencePickerReset(readContext: () => UseCanvasReferencePickerResetContext, dependencies: DependencyList) {
  useEffect(() => {
    const { setReferencePickerOpen, promptSelectionRef } = readContext();

    setReferencePickerOpen(false);
    promptSelectionRef.current = { start: 0, end: 0 };

  }, dependencies);
}

interface UseCanvasPromptScrollResetContext {
  setPromptEditorScroll: Dispatch<SetStateAction<{ top: number; left: number; }>>;
}

export function useCanvasPromptScrollReset(readContext: () => UseCanvasPromptScrollResetContext, dependencies: DependencyList) {
  useEffect(() => {
    const { setPromptEditorScroll } = readContext();

    setPromptEditorScroll({ top: 0, left: 0 });

  }, dependencies);
}

interface UseCanvasPromptFocusContext {
  expanded: boolean;
  activeNode: NodeData | null;
  promptTextareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useCanvasPromptFocus(readContext: () => UseCanvasPromptFocusContext, dependencies: DependencyList) {
  useEffect(() => {
    const { expanded, activeNode, promptTextareaRef } = readContext();

    if (!expanded || !activeNode) return;
    window.setTimeout(() => {
      const textarea = promptTextareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
    }, 0);

  }, dependencies);
}

interface UseCanvasNodeEditorResetContext {
  setRatioOpen: Dispatch<SetStateAction<boolean>>;
  setModelOpen: Dispatch<SetStateAction<boolean>>;
  setQuantityOpen: Dispatch<SetStateAction<boolean>>;
  setCameraOpen: Dispatch<SetStateAction<boolean>>;
  setVideoSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setVideoFrameMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageNineGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomPreview: Dispatch<SetStateAction<{ nodeId: string; rows: number; cols: number; } | null>>;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  setMediaViewerNodeId: Dispatch<SetStateAction<string | null>>;
  setHoveredVideoPromptTab: Dispatch<SetStateAction<"文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频" | null>>;
}

export function useCanvasNodeEditorReset(readContext: () => UseCanvasNodeEditorResetContext, dependencies: DependencyList) {
  useEffect(() => {
    const { setRatioOpen, setModelOpen, setQuantityOpen, setCameraOpen, setVideoSettingsOpen, setVideoFrameMenuNodeId, setImageNineGridMenuNodeId, setImageGridMenuNodeId, setImageGridCustomMenuNodeId, setImageGridCustomPreview, setExpanded, setMediaViewerNodeId, setHoveredVideoPromptTab } = readContext();

    setRatioOpen(false);
    setModelOpen(false);
    setQuantityOpen(false);
    setCameraOpen(false);
    setVideoSettingsOpen(false);
    setVideoFrameMenuNodeId(null);
    setImageNineGridMenuNodeId(null);
    setImageGridMenuNodeId(null);
    setImageGridCustomMenuNodeId(null);
    setImageGridCustomPreview(null);
    setExpanded(false);
    setMediaViewerNodeId(null);
    setHoveredVideoPromptTab(null);

  }, dependencies);
}

interface UseCanvasVideoPromptTabContext {
  activeNode: NodeData | null;
  getDefaultVideoPromptTab: (summary: VideoReferenceSummary, modelId?: string, model?: AiModelOption) => VideoPromptTab;
  activeNodeVideoReferenceSummary: VideoReferenceSummary;
  activeNodeModelOption: AiModelOption | undefined;
  getVideoTabForMode: (mode?: VideoGenerationMode) => VideoPromptTab;
  isVideoPromptTabEnabled: (tab: VideoPromptTab, summary: VideoReferenceSummary, modelId?: string, model?: AiModelOption) => boolean;
  videoPromptTab: "文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频";
  setVideoPromptTab: Dispatch<SetStateAction<"文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频">>;
  getVideoModeForTab: (tab: VideoPromptTab) => VideoGenerationMode;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
}

export function useCanvasVideoPromptTab(readContext: () => UseCanvasVideoPromptTabContext, dependencies: DependencyList) {
  useEffect(() => {
    const { activeNode, getDefaultVideoPromptTab, activeNodeVideoReferenceSummary, activeNodeModelOption, getVideoTabForMode, isVideoPromptTabEnabled, videoPromptTab, setVideoPromptTab, getVideoModeForTab, setNodePatch } = readContext();

    if (!activeNode || activeNode.type !== "video") return;
    const fallbackTab = getDefaultVideoPromptTab(
      activeNodeVideoReferenceSummary,
      activeNode.model,
      activeNodeModelOption,
    );
    const persistedTab = getVideoTabForMode(activeNode.videoMode);
    const nextTab = isCanvasSourceVideoMode(activeNode.videoMode) ? getVideoTabForMode(activeNode.videoMode) : isVideoPromptTabEnabled(
      persistedTab,
      activeNodeVideoReferenceSummary,
      activeNode.model,
      activeNodeModelOption,
    )
      ? persistedTab
      : fallbackTab;
    if (videoPromptTab !== nextTab) setVideoPromptTab(nextTab);
    const nextMode = getVideoModeForTab(nextTab);
    if (
      activeNode.videoMode !== nextMode
      && isCanvasCatalogVideoModeSupported(activeNodeModelOption, nextMode)
    ) {
      setNodePatch(activeNode.id, { videoMode: nextMode });
    }

  }, dependencies);
}
