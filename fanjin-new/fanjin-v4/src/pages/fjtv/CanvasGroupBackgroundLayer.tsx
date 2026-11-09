import type { Dispatch, SetStateAction } from "react";
import type { StoryboardGroupType, GroupData, GroupDragState } from "./canvasDataTypes";
import { type CanvasRect as Rect } from "./canvasGeometry";

export interface CanvasGroupBackgroundLayerDependencies {
  groups: GroupData[];
  groupBoundsMap: Map<string, Rect>;
  isStoryboardGroup: (group: GroupData | null | undefined) => group is GroupData & { groupType: StoryboardGroupType; };
  activeGroupId: string | null;
  groupDrag: GroupDragState;
  editingTextNodeId: string | null;
  commitTextNodeEditing: () => void;
  toWorld: (clientX: number, clientY: number) => { x: number; y: number; };
  beginGroupDrag: (group: GroupData, startWorldX: number, startWorldY: number, startBounds: Rect) => void;
  closePromptMenus: () => void;
  setLayoutDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setColorPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setSelectionLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
}

export function createCanvasGroupBackgroundLayer(deps: CanvasGroupBackgroundLayerDependencies) {
  const {
    groups,
    groupBoundsMap,
    isStoryboardGroup,
    activeGroupId,
    groupDrag,
    editingTextNodeId,
    commitTextNodeEditing,
    toWorld,
    beginGroupDrag,
    closePromptMenus,
    setLayoutDropdownOpen,
    setColorPaletteOpen,
    setSelectionLayoutMenuOpen,
  } = deps;
  function renderCanvasGroupBackgroundLayer() { return (groups.map((group) => {
          const bounds = groupBoundsMap.get(group.id);
          if (!bounds || isStoryboardGroup(group)) return null;
          const isActive = group.id === activeGroupId;
          return (
            <div
              key={`${group.id}_bg`}
              className="absolute transition"
              style={{
                left: bounds.left,
                top: bounds.top,
                width: bounds.right - bounds.left,
                height: bounds.bottom - bounds.top,
                borderRadius: 10,
                backgroundColor: isActive ? `${group.themeColor}66` : `${group.themeColor}4d`,
                boxShadow: isActive ? `inset 0 0 0 1px ${group.themeColor}aa, 0 18px 44px rgba(0,0,0,0.22)` : `inset 0 0 0 1px ${group.themeColor}66`,
                zIndex: 0,
                cursor: groupDrag.active && groupDrag.groupId === group.id ? "grabbing" : "grab",
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (editingTextNodeId) commitTextNodeEditing();
                const worldPoint = toWorld(event.clientX, event.clientY);
                beginGroupDrag(group, worldPoint.x, worldPoint.y, bounds);
                closePromptMenus();
                setLayoutDropdownOpen(false);
                setColorPaletteOpen(false);
                setSelectionLayoutMenuOpen(false);
              }}
            />
          );
        })); }
  return renderCanvasGroupBackgroundLayer;
}
