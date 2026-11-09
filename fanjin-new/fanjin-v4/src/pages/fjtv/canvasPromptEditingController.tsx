import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { CAMERA_PRESETS, normalizeCameraSettings, formatCameraControl } from "./canvasCameraDefinitions";
import { findPromptReferenceRangeAt, getPromptReferenceRanges, snapPromptCaretToReferenceBoundary } from "./canvasPromptReferences";
import type { CameraPresetKind, CameraSettings, UpstreamReferenceItem, PromptReferenceRange, NodeData, EdgeData, GroupData, CanvasMetaState } from "./canvasDataTypes";
import { buildCanvasCameraControlPatch } from "./canvasGenerationPrompt";

export interface CanvasPromptEditingControllerDependencies {
  setRatioOpen: Dispatch<SetStateAction<boolean>>;
  setModelOpen: Dispatch<SetStateAction<boolean>>;
  setQuantityOpen: Dispatch<SetStateAction<boolean>>;
  setCameraOpen: Dispatch<SetStateAction<boolean>>;
  setVideoSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setReferencePickerOpen: Dispatch<SetStateAction<boolean>>;
  setImageNineGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomPreview: Dispatch<SetStateAction<{ nodeId: string; rows: number; cols: number; } | null>>;
  promptTextareaRef: RefObject<HTMLTextAreaElement | null>;
  setPromptEditorScroll: Dispatch<SetStateAction<{ top: number; left: number; }>>;
  expanded: boolean;
  promptSelectionRef: RefObject<{ start: number; end: number; }>;
  activeNode: NodeData | null;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  upstreamReferences: UpstreamReferenceItem[];
  setCameraDraft: Dispatch<SetStateAction<CameraSettings>>;
  setCameraSemanticsEnabled: Dispatch<SetStateAction<boolean>>;
  cameraDraft: CameraSettings;
  cameraSemanticsEnabled: boolean;
  nodes: NodeData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  edges: EdgeData[];
  canvasMeta: CanvasMetaState;
  groups: GroupData[];
}

export function createCanvasPromptEditingController(deps: CanvasPromptEditingControllerDependencies) {
  const { setRatioOpen, setModelOpen, setQuantityOpen, setCameraOpen, setVideoSettingsOpen, setReferencePickerOpen, setImageNineGridMenuNodeId, setImageGridMenuNodeId, setImageGridCustomMenuNodeId, setImageGridCustomPreview, promptTextareaRef, setPromptEditorScroll, expanded, promptSelectionRef, activeNode, setNodePatch, upstreamReferences, setCameraDraft, setCameraSemanticsEnabled, cameraDraft, cameraSemanticsEnabled, nodes, setNodes, persistCanvas, edges, canvasMeta, groups } = deps;
function closePromptMenus() {
    setRatioOpen(false);
    setModelOpen(false);
    setQuantityOpen(false);
    setCameraOpen(false);
    setVideoSettingsOpen(false);
    setReferencePickerOpen(false);
    setImageNineGridMenuNodeId(null);
    setImageGridMenuNodeId(null);
    setImageGridCustomMenuNodeId(null);
    setImageGridCustomPreview(null);
  }

function bindPromptTextarea(element: HTMLTextAreaElement | null) {
    if (element) promptTextareaRef.current = element;
  }

function syncPromptEditorScroll(element: HTMLTextAreaElement | null) {
    if (!element) return;
    setPromptEditorScroll({
      top: element.scrollTop || 0,
      left: element.scrollLeft || 0,
    });
  }

function rememberPromptSelection(element: HTMLTextAreaElement | null) {
    if (!element) return;
    promptTextareaRef.current = element;
    syncPromptEditorScroll(element);
    if (expanded) {
      promptSelectionRef.current = {
        start: element.selectionStart ?? 0,
        end: element.selectionEnd ?? element.selectionStart ?? 0,
      };
      return;
    }
    normalizePromptSelection(element, activeNode?.prompt || "");
  }

function handlePromptInputChange(value: string, element: HTMLTextAreaElement) {
    if (!activeNode) return;
    rememberPromptSelection(element);
    setNodePatch(activeNode.id, { prompt: value });
    const caret = element.selectionStart ?? value.length;
    setReferencePickerOpen(value[Math.max(0, caret - 1)] === "@" && upstreamReferences.length > 0);
  }

function insertReferenceIntoPrompt(reference: UpstreamReferenceItem) {
    if (!activeNode) return;
    const textarea = promptTextareaRef.current;
    const currentPrompt = activeNode.prompt || "";
    const cleanedPrompt = currentPrompt.replace(/(^|\s)@(?!\S)/g, "$1");
    const trimmedPrompt = cleanedPrompt.replace(/\s+$/g, "");
    const prefix = trimmedPrompt;
    const spacerBefore = prefix ? " " : "";
    const mentionText = `${spacerBefore}${reference.mentionToken}`;
    const nextPrompt = `${prefix}${mentionText}`;
    const nextCaret = nextPrompt.length;
    setNodePatch(activeNode.id, { prompt: nextPrompt });
    setReferencePickerOpen(false);
    window.setTimeout(() => {
      const nextTextarea = promptTextareaRef.current;
      if (!nextTextarea) return;
      nextTextarea.focus();
      nextTextarea.setSelectionRange(nextCaret, nextCaret);
      promptSelectionRef.current = { start: nextCaret, end: nextCaret };
    }, 0);
  }

function normalizePromptSelection(element: HTMLTextAreaElement | null, prompt: string) {
    if (!element) return;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? start;
    let nextStart = start;
    let nextEnd = end;

    const startRange = findPromptReferenceRangeAt(prompt, start);
    if (startRange) {
      nextStart = start === end ? snapPromptCaretToReferenceBoundary(startRange, start) : startRange.start;
    }

    const endRange = findPromptReferenceRangeAt(prompt, end);
    if (endRange) {
      nextEnd = start === end ? snapPromptCaretToReferenceBoundary(endRange, end) : endRange.end;
    }

    const overlappedRanges = getPromptReferenceRanges(prompt).filter((range) => nextStart < range.end && nextEnd > range.start);
    if (overlappedRanges.length > 0) {
      nextStart = Math.min(nextStart, overlappedRanges[0].start);
      nextEnd = Math.max(nextEnd, overlappedRanges[overlappedRanges.length - 1].end);
    }

    if (nextStart !== start || nextEnd !== end) {
      element.setSelectionRange(nextStart, nextEnd);
    }

    promptSelectionRef.current = { start: nextStart, end: nextEnd };
  }

function removePromptReferenceRange(range: PromptReferenceRange) {
    if (!activeNode) return;
    const currentPrompt = activeNode.prompt || "";
    const nextPrompt = `${currentPrompt.slice(0, range.start)}${currentPrompt.slice(range.end)}`;
    const nextCaret = range.start;
    setNodePatch(activeNode.id, { prompt: nextPrompt });
    window.setTimeout(() => {
      const textarea = promptTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
      promptSelectionRef.current = { start: nextCaret, end: nextCaret };
    }, 0);
  }

function handlePromptTextareaKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!activeNode) return;
    if (expanded) return;
    const prompt = activeNode.prompt || "";
    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;

    if (event.key === "Backspace" && start === end) {
      const range = getPromptReferenceRanges(prompt).find((item) => item.end === start || (start > item.start && start <= item.end));
      if (range) {
        event.preventDefault();
        removePromptReferenceRange(range);
        return;
      }
    }

    if (event.key === "Delete" && start === end) {
      const range = getPromptReferenceRanges(prompt).find((item) => item.start === start || (start >= item.start && start < item.end));
      if (range) {
        event.preventDefault();
        removePromptReferenceRange(range);
        return;
      }
    }

    if (start !== end && (event.key === "Backspace" || event.key === "Delete")) {
      const overlappedRanges = getPromptReferenceRanges(prompt).filter((range) => start < range.end && end > range.start);
      if (overlappedRanges.length > 0) {
        event.preventDefault();
        const expandedStart = Math.min(start, overlappedRanges[0].start);
        const expandedEnd = Math.max(end, overlappedRanges[overlappedRanges.length - 1].end);
        const nextPrompt = `${prompt.slice(0, expandedStart)}${prompt.slice(expandedEnd)}`;
        setNodePatch(activeNode.id, { prompt: nextPrompt });
        window.setTimeout(() => {
          const nextTextarea = promptTextareaRef.current;
          if (!nextTextarea) return;
          nextTextarea.focus();
          nextTextarea.setSelectionRange(expandedStart, expandedStart);
          promptSelectionRef.current = { start: expandedStart, end: expandedStart };
        }, 0);
      }
    }
  }

function openCameraPanel() {
    if (!activeNode) return;
    setCameraDraft({ ...normalizeCameraSettings(activeNode.cameraSettings) });
    setCameraSemanticsEnabled(Boolean(activeNode.cameraControl && activeNode.cameraControl.trim()));
    setModelOpen(false);
    setRatioOpen(false);
    setQuantityOpen(false);
    setCameraOpen(true);
  }

function cycleCameraDraft(kind: CameraPresetKind, direction: 1 | -1) {
    setCameraDraft((prev) => {
      const list = CAMERA_PRESETS[kind];
      const currentId = prev[kind];
      const currentIndex = Math.max(
        0,
        list.findIndex((item) => item.id === currentId),
      );
      const nextIndex = (currentIndex + direction + list.length) % list.length;
      return { ...prev, [kind]: list[nextIndex].id };
    });
  }

function applyCameraDraft() {
    if (!activeNode) return;
    const next = normalizeCameraSettings(cameraDraft);
    const cameraControl = cameraSemanticsEnabled ? formatCameraControl(next) : "";
    const cameraPatch = buildCanvasCameraControlPatch(next, cameraControl);
    const nextNodes = nodes.map((node) =>
      node.id === activeNode.id
        ? { ...node, ...cameraPatch }
        : node,
    );
    setNodes(nextNodes);
    void persistCanvas(nextNodes, edges, canvasMeta.name, groups);
    setCameraOpen(false);
  }

function clearCameraSemantics() {
    if (!activeNode) return;
    const cameraPatch = buildCanvasCameraControlPatch(normalizeCameraSettings(activeNode.cameraSettings), "");
    const nextNodes = nodes.map((node) =>
      node.id === activeNode.id ? { ...node, ...cameraPatch } : node,
    );
    setNodes(nextNodes);
    void persistCanvas(nextNodes, edges, canvasMeta.name, groups);
    setCameraSemanticsEnabled(false);
  }
  return { closePromptMenus, bindPromptTextarea, syncPromptEditorScroll, rememberPromptSelection, handlePromptInputChange, insertReferenceIntoPrompt, normalizePromptSelection, removePromptReferenceRange, handlePromptTextareaKeyDown, openCameraPanel, cycleCameraDraft, applyCameraDraft, clearCameraSemantics };
}
