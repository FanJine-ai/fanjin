import { VIDEO_PROMPT_TABS } from "./canvasModelDefinitions";
import { DEFAULT_CAMERA_SETTINGS } from "./canvasCameraDefinitions";
import type { VideoPromptTab } from "./canvasDataTypes";
import type { CameraSettings, UpstreamReferenceItem } from "./canvasDataTypes";
import { useRef, useState } from "react";

export function useCanvasPromptState() {
  const [ratioOpen, setRatioOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [quantityOpen, setQuantityOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraSemanticsEnabled, setCameraSemanticsEnabled] = useState(false);
  const [videoSettingsOpen, setVideoSettingsOpen] = useState(false);
  const modelMenuOpenerRef = useRef<HTMLButtonElement | null>(null);
  const videoSettingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const videoSettingsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [referencePreview, setReferencePreview] = useState<UpstreamReferenceItem | null>(null);
  const [hoveredVideoPromptTab, setHoveredVideoPromptTab] = useState<VideoPromptTab | null>(null);
  const [cameraDraft, setCameraDraft] = useState<CameraSettings>({ ...DEFAULT_CAMERA_SETTINGS });
  const [videoPromptTab, setVideoPromptTab] = useState<(typeof VIDEO_PROMPT_TABS)[number]>("文生视频");
  const [expanded, setExpanded] = useState(false);
  const [nodeEditorPinned, setNodeEditorPinned] = useState(false);
  const [mediaViewerNodeId, setMediaViewerNodeId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState("");
  const [portraitAdmissionLayout, setPortraitAdmissionLayout] = useState<"hidden" | "pill" | "panel">("panel");
  const [submittingNodeIds, setSubmittingNodeIds] = useState<string[]>([]);
  const [submitButtonPendingKeys, setSubmitButtonPendingKeys] = useState<string[]>([]);
  const [generateButtonPendingNodeIds, setGenerateButtonPendingNodeIds] = useState<string[]>([]);
  return {
    ratioOpen, setRatioOpen,
    modelOpen, setModelOpen,
    quantityOpen, setQuantityOpen,
    cameraOpen, setCameraOpen,
    cameraSemanticsEnabled, setCameraSemanticsEnabled,
    videoSettingsOpen, setVideoSettingsOpen,
    modelMenuOpenerRef, videoSettingsTriggerRef,
    videoSettingsOpenerRef, referencePickerOpen,
    setReferencePickerOpen, referencePreview,
    setReferencePreview, hoveredVideoPromptTab,
    setHoveredVideoPromptTab, cameraDraft,
    setCameraDraft, videoPromptTab,
    setVideoPromptTab, expanded,
    setExpanded, nodeEditorPinned,
    setNodeEditorPinned, mediaViewerNodeId,
    setMediaViewerNodeId, setUploading,
    status, setStatus,
    portraitAdmissionLayout, setPortraitAdmissionLayout,
    submittingNodeIds, setSubmittingNodeIds,
    submitButtonPendingKeys, setSubmitButtonPendingKeys,
    generateButtonPendingNodeIds, setGenerateButtonPendingNodeIds,
  };
}
