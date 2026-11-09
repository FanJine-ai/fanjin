import type { ImageGridSplitEditorState, ImageEnhanceEditorState, ImageTransformEditorState, ImageOutpaintDragState, ImageCropDragState } from "./canvasDataTypes";
import type { ImageOutpaintDraft, ImageCropDraft } from "./canvasMediaTypes";
import { useState } from "react";

export function useCanvasImageEditorState() {
  const [imageNineGridMenuNodeId, setImageNineGridMenuNodeId] = useState<string | null>(null);
  const [imageHdMenuNodeId, setImageHdMenuNodeId] = useState<string | null>(null);
  const [imageGridMenuNodeId, setImageGridMenuNodeId] = useState<string | null>(null);
  const [imageGridCustomMenuNodeId, setImageGridCustomMenuNodeId] = useState<string | null>(null);
  const [imageGridCustomPreview, setImageGridCustomPreview] = useState<{ nodeId: string; rows: number; cols: number } | null>(null);
  const [imageGridSplitEditor, setImageGridSplitEditor] = useState<ImageGridSplitEditorState | null>(null);
  const [imageTransformMenuNodeId, setImageTransformMenuNodeId] = useState<string | null>(null);
  const [activeImageEnhance, setActiveImageEnhance] = useState<ImageEnhanceEditorState | null>(null);
  const [activeImageOutpaint, setActiveImageOutpaint] = useState<ImageOutpaintDraft | null>(null);
  const [activeImageCrop, setActiveImageCrop] = useState<ImageCropDraft | null>(null);
  const [activeImageTransform, setActiveImageTransform] = useState<ImageTransformEditorState | null>(null);
  const [imageOutpaintDragging, setImageOutpaintDragging] = useState<ImageOutpaintDragState | null>(null);
  const [imageCropDragging, setImageCropDragging] = useState<ImageCropDragState | null>(null);
  const [imageOutpaintRatioOpen, setImageOutpaintRatioOpen] = useState(false);
  const [imageOutpaintResolutionOpen, setImageOutpaintResolutionOpen] = useState(false);
  const [imageCropRatioOpen, setImageCropRatioOpen] = useState(false);

  return {
    imageNineGridMenuNodeId, setImageNineGridMenuNodeId,
    imageHdMenuNodeId, setImageHdMenuNodeId,
    imageGridMenuNodeId, setImageGridMenuNodeId,
    imageGridCustomMenuNodeId, setImageGridCustomMenuNodeId,
    imageGridCustomPreview, setImageGridCustomPreview,
    imageGridSplitEditor, setImageGridSplitEditor,
    imageTransformMenuNodeId, setImageTransformMenuNodeId,
    activeImageEnhance, setActiveImageEnhance,
    activeImageOutpaint, setActiveImageOutpaint,
    activeImageCrop, setActiveImageCrop,
    activeImageTransform, setActiveImageTransform,
    imageOutpaintDragging, setImageOutpaintDragging,
    imageCropDragging, setImageCropDragging,
    imageOutpaintRatioOpen, setImageOutpaintRatioOpen,
    imageOutpaintResolutionOpen, setImageOutpaintResolutionOpen,
    imageCropRatioOpen, setImageCropRatioOpen,
  };
}
