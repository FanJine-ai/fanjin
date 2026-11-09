import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { IMAGE_NINE_GRID_MENU_ITEMS, IMAGE_HD_MENU_ITEMS, IMAGE_TRANSFORM_MENU_ITEMS } from "./canvasMediaMenuConfig";
import type { ImageEraseKind, NodeData } from "./canvasDataTypes";
import { type CharacterThreeViewMode } from "./canvasPromptTemplates";

export interface CanvasImageMenuControllerDependencies {
  setImageNineGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageHdMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomPreview: Dispatch<SetStateAction<{ nodeId: string; rows: number; cols: number; } | null>>;
  setImageTransformMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setVideoEnhanceResolutionOpen: Dispatch<SetStateAction<boolean>>;
  setImageOutpaintRatioOpen: Dispatch<SetStateAction<boolean>>;
  setImageOutpaintResolutionOpen: Dispatch<SetStateAction<boolean>>;
  setImageCropRatioOpen: Dispatch<SetStateAction<boolean>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  openImageEnhanceEditor: (sourceNode: NodeData) => void;
  openImageOutpaintEditor: (node: NodeData) => void;
  openImageCropEditor: (node: NodeData) => void;
  submitRemoveImageBackground: (sourceNode: NodeData) => Promise<void>;
  submitImageErase: (sourceNode: NodeData, kind: ImageEraseKind) => Promise<void>;
  setStatus: Dispatch<SetStateAction<string>>;
  openImageTransformEditor: (sourceNode: NodeData) => void;
  submitMultiAngleNineGrid: (sourceNode: NodeData) => Promise<void>;
  submitProductSheet: (sourceNode: NodeData) => Promise<void>;
  submitSceneSheet: (sourceNode: NodeData) => Promise<void>;
  submitCharacterSheet: (sourceNode: NodeData) => Promise<void>;
  submitCharacterThreeView: (sourceNode: NodeData, mode: CharacterThreeViewMode) => Promise<void>;
  submitCinematicLighting: (sourceNode: NodeData) => Promise<void>;
  submitStoryboard25Grid: (sourceNode: NodeData) => Promise<void>;
}

export function createCanvasImageMenuController(deps: CanvasImageMenuControllerDependencies) {
  const { setImageNineGridMenuNodeId, setImageHdMenuNodeId, setImageGridMenuNodeId, setImageGridCustomMenuNodeId, setImageGridCustomPreview, setImageTransformMenuNodeId, setVideoEnhanceResolutionOpen, setImageOutpaintRatioOpen, setImageOutpaintResolutionOpen, setImageCropRatioOpen, setActiveNodeId, openImageEnhanceEditor, openImageOutpaintEditor, openImageCropEditor, submitRemoveImageBackground, submitImageErase, setStatus, openImageTransformEditor, submitMultiAngleNineGrid, submitProductSheet, submitSceneSheet, submitCharacterSheet, submitCharacterThreeView, submitCinematicLighting, submitStoryboard25Grid } = deps;
function closeImageToolbarMenus() {
    setImageNineGridMenuNodeId(null);
    setImageHdMenuNodeId(null);
    setImageGridMenuNodeId(null);
    setImageGridCustomMenuNodeId(null);
    setImageGridCustomPreview(null);
    setImageTransformMenuNodeId(null);
    setVideoEnhanceResolutionOpen(false);
    setImageOutpaintRatioOpen(false);
    setImageOutpaintResolutionOpen(false);
    setImageCropRatioOpen(false);
  }

function handleImageHdMenuAction(node: NodeData, item: (typeof IMAGE_HD_MENU_ITEMS)[number]) {
    setActiveNodeId(node.id);
    closeImageToolbarMenus();
    if (item.key === "enhance") {
      openImageEnhanceEditor(node);
      return;
    }
    if (item.key === "outpaint") {
      openImageOutpaintEditor(node);
      return;
    }
    if (item.key === "crop") {
      openImageCropEditor(node);
      return;
    }
    if (item.key === "remove-bg") {
      void submitRemoveImageBackground(node);
      return;
    }
    if (item.key === "erase") {
      const kind = window.confirm("点击“确定”擦除图标，点击“取消”改为擦除指定文字。") ? "icon" : "text";
      void submitImageErase(node, kind);
      return;
    }
    if (item.key === "redraw") {
      setStatus("重绘入口已恢复，后续继续接真实重绘链路");
      return;
    }
    setStatus("图片工具入口已恢复");
  }

function handleImageTransformMenuAction(node: NodeData, item: (typeof IMAGE_TRANSFORM_MENU_ITEMS)[number]) {
    setActiveNodeId(node.id);
    closeImageToolbarMenus();
    if (item.key === "transform" || item.key === "rotate-mirror") {
      openImageTransformEditor(node);
      return;
    }
    if (item.key === "remove-bg") {
      void submitRemoveImageBackground(node);
      return;
    }
    if (item.key === "erase-repair") {
      const kind = window.confirm("点击“确定”擦除图标，点击“取消”改为擦除指定文字。") ? "icon" : "text";
      void submitImageErase(node, kind);
      return;
    }
    setStatus("图片变换入口已恢复");
  }

function handleNineGridMenuAction(node: NodeData, item: (typeof IMAGE_NINE_GRID_MENU_ITEMS)[number]) {
    setActiveNodeId(node.id);
    if (item.key === "multi-angle-nine-grid") {
      void submitMultiAngleNineGrid(node);
      return;
    }
    if (item.key === "product-sheet") {
      void submitProductSheet(node);
      return;
    }
    if (item.key === "scene-sheet") {
      void submitSceneSheet(node);
      return;
    }
    if (item.key === "character-sheet") {
      void submitCharacterSheet(node);
      return;
    }
    if (item.key === "character-three-view") {
      void submitCharacterThreeView(node, "full");
      return;
    }
    if (item.key === "face-three-view") {
      void submitCharacterThreeView(node, "face");
      return;
    }
    if (item.key === "cinematic-lighting") {
      void submitCinematicLighting(node);
      return;
    }
    if (item.key === "storyboard-25-grid") {
      void submitStoryboard25Grid(node);
      return;
    }
    closeImageToolbarMenus();
    setStatus(`图像工具“${item.label}”入口状态异常，请刷新后重试`);
  }
  return { closeImageToolbarMenus, handleImageHdMenuAction, handleImageTransformMenuAction, handleNineGridMenuAction };
}
