import type { GroupData } from "./canvasDataTypes";
import { useRef, useState } from "react";

export function useCanvasGroupState() {
  const [groups, setGroups] = useState<GroupData[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [layoutDropdownOpen, setLayoutDropdownOpen] = useState(false);
  const [colorPaletteOpen, setColorPaletteOpen] = useState(false);
  const [selectionLayoutMenuOpen, setSelectionLayoutMenuOpen] = useState(false);
  const [groupExecutionDialog, setGroupExecutionDialog] = useState<{ groupId: string } | null>(null);
  const [groupExecutionRunning, setGroupExecutionRunning] = useState(false);
  const groupExecutionOpenerRef = useRef<HTMLButtonElement | null>(null);
  const groupExecutionCancelRef = useRef<HTMLButtonElement | null>(null);

  return {
    groups, setGroups,
    activeGroupId, setActiveGroupId,
    layoutDropdownOpen, setLayoutDropdownOpen,
    colorPaletteOpen, setColorPaletteOpen,
    selectionLayoutMenuOpen, setSelectionLayoutMenuOpen,
    groupExecutionDialog, setGroupExecutionDialog,
    groupExecutionRunning, setGroupExecutionRunning,
    groupExecutionOpenerRef, groupExecutionCancelRef,
  };
}
