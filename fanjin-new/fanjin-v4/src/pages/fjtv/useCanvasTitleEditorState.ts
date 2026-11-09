import { useState } from "react";

export function useCanvasTitleEditorState() {
  const [editingNodeTitleId, setEditingNodeTitleId] = useState<string | null>(null);
  const [editingNodeTitleDraft, setEditingNodeTitleDraft] = useState("");
  const [editingGroupTitleId, setEditingGroupTitleId] = useState<string | null>(null);
  const [editingGroupTitleDraft, setEditingGroupTitleDraft] = useState("");
  const [editingTextNodeId, setEditingTextNodeId] = useState<string | null>(null);
  const [textEditorDraft, setTextEditorDraft] = useState("");
  const [textColorMenuNodeId, setTextColorMenuNodeId] = useState<string | null>(null);
  const [promptEditorScroll, setPromptEditorScroll] = useState({ top: 0, left: 0 });
  const [hoverTextNodeId, setHoverTextNodeId] = useState<string | null>(null);
  return {
    editingNodeTitleId, setEditingNodeTitleId,
    editingNodeTitleDraft, setEditingNodeTitleDraft,
    editingGroupTitleId, setEditingGroupTitleId,
    editingGroupTitleDraft, setEditingGroupTitleDraft,
    editingTextNodeId, setEditingTextNodeId,
    textEditorDraft, setTextEditorDraft,
    textColorMenuNodeId, setTextColorMenuNodeId,
    promptEditorScroll, setPromptEditorScroll,
    setHoverTextNodeId,
  };
}
