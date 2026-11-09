import type * as React from "react";

export function renderCompactPromptLauncher(deps: any): React.ReactNode {
  const { activeNode, controlsPos, shouldHideCanvasPromptShell, activeVideoEditor,
    imageGridSplitEditor, getCanvasCompactNodeEditorLayout, canvasSurfaceWidth,
    canvasSurfaceHeight, rootRef, assetManagerOpen, CanvasCompactNodeEditorLauncher,
    promptFontStack, closePromptMenus, setExpanded } = deps;
  if (!activeNode || !controlsPos) return null;
  if (activeNode.type === "compose") return null;
  if (shouldHideCanvasPromptShell(activeNode)) return null;
  if (activeVideoEditor) return null;
  if (activeNode.type === "image" && imageGridSplitEditor?.nodeId === activeNode.id) return null;
  if (activeNode.videoEnhanceMode) return null;
  if (activeNode.videoSubtitleEraseMode) return null;
  const compactLayout = getCanvasCompactNodeEditorLayout(
    canvasSurfaceWidth || rootRef.current?.getBoundingClientRect().width || 1,
    canvasSurfaceHeight || rootRef.current?.getBoundingClientRect().height || 1,
    assetManagerOpen, controlsPos.promptX, controlsPos.promptY,
  );
  return <CanvasCompactNodeEditorLauncher nodeId={activeNode.id} left={compactLayout.left}
    top={compactLayout.top} width={compactLayout.width} nodeTitle={activeNode.title}
    prompt={activeNode.prompt} fontFamily={promptFontStack} onEdit={() => {
      closePromptMenus(); setExpanded(true);
    }} />;
}
