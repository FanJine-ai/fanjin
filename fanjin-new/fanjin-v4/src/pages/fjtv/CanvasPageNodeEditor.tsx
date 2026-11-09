import type * as React from "react";
import type * as Router from "react-router-dom";
import { PROMPT_EXPANDED_WIDTH, PROMPT_EXPANDED_HEIGHT, PROMPT_PANEL_FONT_STACK } from "./canvasPageConstants";
import { shouldHideCanvasPromptShell } from "./canvasNodeDefaults";
import { normalizeNodeResolution, getCatalogRatioPanelItems, getAiModelUnavailableMessage, getVideoResolutionOptions, normalizeVideoResolutionForModel, buildVideoSettingsSummary, getModelVisualMeta } from "./canvasModelDefinitions";
import { findCameraPreset } from "./canvasCameraDefinitions";
import { createCanvasNodeEditor } from "./CanvasNodeEditor";
import { type PromptEditorOptions } from "./canvasPromptEditor";
import { type CameraPresetKind, type CameraSettings, type NodeData, type DraftLine, type CreationMenuState } from "./canvasDataTypes";
import { type RatioKey, type ImageOutpaintDraft, type ImageCropDraft } from "./canvasMediaTypes";
import { CanvasCompactNodeEditorLauncher } from "./CanvasCompactNodeEditorLauncher";
import { type AiModelOption } from "@/lib/api";

export interface CanvasPageNodeEditorProps {
  activeNode: NodeData | null;
  controlsPos: { uploadX: number; uploadY: number; promptX: number; promptY: number; } | null;
  draftLine: DraftLine | null;
  creationMenu: CreationMenuState;
  editingTextNodeId: string | null;
  activeNodeHasMedia: boolean;
  activeImageOutpaint: ImageOutpaintDraft | null;
  activeImageCrop: ImageCropDraft | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleUploadChange: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  nodeEditorPresentation: import("@/pages/fjtv/CanvasCompactNodeEditorLauncher").CanvasNodeEditorPresentation;
  nodeUploadIsActive: (node: NodeData) => boolean;
  renderCompactNodeEditorLauncher: () => React.ReactNode;
  renderCollapsedPromptShell: () => React.JSX.Element | null;
  renderVideoEnhancePanel: (node: NodeData) => React.ReactNode;
  renderImageEnhancePanel: (node: NodeData) => React.ReactNode;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  modelOpen: boolean;
  videoSettingsOpen: boolean;
  ratioOpen: boolean;
  quantityOpen: boolean;
  cameraOpen: boolean;
  referencePickerOpen: boolean;
  renderUpstreamReferenceStrip: (options?: { showPickerButton?: boolean; compact?: boolean; marginClassName?: string; }) => React.JSX.Element | null;
  renderCanvasArtifactSourcePicker: (node: NodeData) => React.ReactNode;
  renderReferencePicker: () => React.JSX.Element | null;
  renderPromptEditor: (options: PromptEditorOptions) => React.JSX.Element;
  modelMenuOpenerRef: React.RefObject<HTMLButtonElement | null>;
  setModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setRatioOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setQuantityOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setCameraOpen: React.Dispatch<React.SetStateAction<boolean>>;
  activePromptModelLabel: string;
  renderModelCatalogStatus: () => React.ReactNode;
  activeNodeModelOptions: AiModelOption[];
  setActiveNodeModel: (model: AiModelOption) => void;
  activeNodeModelOption: AiModelOption | undefined;
  setActiveNodeResolution: (next: "1K" | "2K" | "4K") => void;
  setActiveNodeRatio: (nextRatio: RatioKey) => void;
  renderImageOutputCountSelector: () => React.ReactNode;
  openCameraPanel: () => void;
  activeNodeTotalPriceLabel: string;
  renderGenerateButton: (node: NodeData) => React.ReactNode;
  renderVideoPromptTabs: () => React.JSX.Element;
  renderStoryboardVideoPrompt: () => React.JSX.Element | null;
  activeStoryboardVideoInputs: { prompts: string[]; names: string[]; errors: string[]; };
  setVideoSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  videoSettingsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  videoSettingsOpenerRef: React.RefObject<HTMLButtonElement | null>;
  setActiveNodeResolutionGeneric: (next: string) => void;
  renderVideoOutputFormatPicker: () => React.ReactNode;
  parseDurationSeconds: (raw?: string) => number;
  activeNodeVideoDurationCapability: import("@/pages/fjtv/canvasCatalogContract").CanvasCatalogVideoDuration | null;
  setActiveNodeDuration: (nextSeconds: number) => void;
  activeNodeVideoDurationMode: "text_to_video" | "omni_reference" | "image_to_video" | "first_last_frame" | "image_reference" | "video_extension" | "video_edit" | null;
  setActiveNodeGenerateAudio: (enabled: boolean) => void;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  renderCanvasArtifactToolbar: (node: NodeData) => React.JSX.Element;
  cameraSemanticsEnabled: boolean;
  setCameraSemanticsEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  cameraDraft: CameraSettings;
  cycleCameraDraft: (kind: CameraPresetKind, direction: 1 | -1) => void;
  applyCameraDraft: () => void;
}
export function CanvasPageNodeEditor({
  activeNode,
  controlsPos,
  draftLine,
  creationMenu,
  editingTextNodeId,
  activeNodeHasMedia,
  activeImageOutpaint,
  activeImageCrop,
  fileInputRef,
  handleUploadChange,
  nodeEditorPresentation,
  nodeUploadIsActive,
  renderCompactNodeEditorLauncher,
  renderCollapsedPromptShell,
  renderVideoEnhancePanel,
  renderImageEnhancePanel,
  setExpanded,
  modelOpen,
  videoSettingsOpen,
  ratioOpen,
  quantityOpen,
  cameraOpen,
  referencePickerOpen,
  renderUpstreamReferenceStrip,
  renderCanvasArtifactSourcePicker,
  renderReferencePicker,
  renderPromptEditor,
  modelMenuOpenerRef,
  setModelOpen,
  setRatioOpen,
  setQuantityOpen,
  setCameraOpen,
  activePromptModelLabel,
  renderModelCatalogStatus,
  activeNodeModelOptions,
  setActiveNodeModel,
  activeNodeModelOption,
  setActiveNodeResolution,
  setActiveNodeRatio,
  renderImageOutputCountSelector,
  openCameraPanel,
  activeNodeTotalPriceLabel,
  renderGenerateButton,
  renderVideoPromptTabs,
  renderStoryboardVideoPrompt,
  activeStoryboardVideoInputs,
  setVideoSettingsOpen,
  videoSettingsTriggerRef,
  videoSettingsOpenerRef,
  setActiveNodeResolutionGeneric,
  renderVideoOutputFormatPicker,
  parseDurationSeconds,
  activeNodeVideoDurationCapability,
  setActiveNodeDuration,
  activeNodeVideoDurationMode,
  setActiveNodeGenerateAudio,
  setNodePatch,
  setStatus,
  renderCanvasArtifactToolbar,
  cameraSemanticsEnabled,
  setCameraSemanticsEnabled,
  cameraDraft,
  cycleCameraDraft,
  applyCameraDraft,
}: CanvasPageNodeEditorProps) {
  return <>
{createCanvasNodeEditor({
      activeNode,
      shouldHideCanvasPromptShell,
      controlsPos,
      draftLine,
      creationMenu,
      editingTextNodeId,
      activeNodeHasMedia,
      activeImageOutpaint,
      activeImageCrop,
      fileInputRef,
      handleUploadChange,
      nodeEditorPresentation,
      nodeUploadIsActive,
      renderCompactNodeEditorLauncher,
      renderCollapsedPromptShell,
      renderVideoEnhancePanel,
      renderImageEnhancePanel,
      setExpanded,
      modelOpen,
      videoSettingsOpen,
      ratioOpen,
      quantityOpen,
      cameraOpen,
      referencePickerOpen,
      PROMPT_EXPANDED_WIDTH,
      PROMPT_EXPANDED_HEIGHT,
      PROMPT_PANEL_FONT_STACK,
      renderUpstreamReferenceStrip,
      renderCanvasArtifactSourcePicker,
      renderReferencePicker,
      renderPromptEditor,
      modelMenuOpenerRef,
      setModelOpen,
      setRatioOpen,
      setQuantityOpen,
      setCameraOpen,
      activePromptModelLabel,
      renderModelCatalogStatus,
      activeNodeModelOptions,
      getModelVisualMeta,
      getAiModelUnavailableMessage,
      setActiveNodeModel,
      normalizeNodeResolution,
      activeNodeModelOption,
      setActiveNodeResolution,
      getCatalogRatioPanelItems,
      setActiveNodeRatio,
      renderImageOutputCountSelector,
      openCameraPanel,
      activeNodeTotalPriceLabel,
      renderGenerateButton,
      renderVideoPromptTabs,
      renderStoryboardVideoPrompt,
      activeStoryboardVideoInputs,
      setVideoSettingsOpen,
      videoSettingsTriggerRef,
      videoSettingsOpenerRef,
      buildVideoSettingsSummary,
      getVideoResolutionOptions,
      normalizeVideoResolutionForModel,
      setActiveNodeResolutionGeneric,
      renderVideoOutputFormatPicker,
      parseDurationSeconds,
      activeNodeVideoDurationCapability,
      setActiveNodeDuration,
      activeNodeVideoDurationMode,
      setActiveNodeGenerateAudio,
      setNodePatch,
      setStatus,
      renderCanvasArtifactToolbar,
      cameraSemanticsEnabled,
      setCameraSemanticsEnabled,
      findCameraPreset,
      cameraDraft,
      cycleCameraDraft,
      applyCameraDraft,
    })()}
</>;
}
