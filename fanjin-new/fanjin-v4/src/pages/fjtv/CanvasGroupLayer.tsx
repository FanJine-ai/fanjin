import type { Dispatch, SetStateAction } from "react";
import type { StoryboardGroupType, GroupData } from "./canvasDataTypes";
import { Fragment } from "react";
import { type CanvasRect as Rect } from "./canvasGeometry";

export interface CanvasGroupLayerDependencies {
  groups: GroupData[];
  groupBoundsMap: Map<string, Rect>;
  activeGroupId: string | null;
  isStoryboardGroup: (group: GroupData | null | undefined) => group is GroupData & { groupType: StoryboardGroupType; };
  editingGroupTitleId: string | null;
  toWorld: (clientX: number, clientY: number) => { x: number; y: number; };
  beginGroupDrag: (group: GroupData, startWorldX: number, startWorldY: number, startBounds: Rect) => void;
  editingTextNodeId: string | null;
  commitTextNodeEditing: () => void;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  closePromptMenus: () => void;
  setLayoutDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setColorPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setSelectionLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
  editingGroupTitleDraft: string;
  setEditingGroupTitleDraft: Dispatch<SetStateAction<string>>;
  commitGroupTitle: (groupId: string, fallbackTitle: string) => void;
  cancelGroupTitleEdit: () => void;
  startEditGroupTitle: (group: GroupData) => void;
  getGroupDisplayTitle: (group: GroupData) => string;
}

export function createCanvasGroupLayer(deps: CanvasGroupLayerDependencies) {
  const {
    groups,
    groupBoundsMap,
    activeGroupId,
    isStoryboardGroup,
    editingGroupTitleId,
    toWorld,
    beginGroupDrag,
    editingTextNodeId,
    commitTextNodeEditing,
    setActiveGroupId,
    setSelectedNodeIds,
    setSelectedEdgeIds,
    setActiveNodeId,
    closePromptMenus,
    setLayoutDropdownOpen,
    setColorPaletteOpen,
    setSelectionLayoutMenuOpen,
    editingGroupTitleDraft,
    setEditingGroupTitleDraft,
    commitGroupTitle,
    cancelGroupTitleEdit,
    startEditGroupTitle,
    getGroupDisplayTitle,
  } = deps;
  function renderCanvasGroupLayer() { return (groups.map((group) => {
          const bounds = groupBoundsMap.get(group.id);
          if (!bounds) return null;
          const isActive = group.id === activeGroupId;
          const storyboard = isStoryboardGroup(group);
          const isEditingGroupTitle = editingGroupTitleId === group.id;
          return (
            <Fragment key={group.id}>
              <div
                data-group-box
                className="pointer-events-none absolute border transition"
                style={{
                  left: bounds.left,
                  top: bounds.top,
                  width: bounds.right - bounds.left,
                  height: bounds.bottom - bounds.top,
                  borderRadius: storyboard ? 0 : 10,
                  borderStyle: storyboard ? "solid" : "none",
                  borderColor: storyboard ? "rgba(255,255,255,0.06)" : "transparent",
                  backgroundColor: "transparent",
                  boxShadow: isActive
                    ? storyboard
                      ? "none"
                      : "inset 0 0 0 1px rgba(255,255,255,0.05), 0 0 0 1px rgba(255,255,255,0.04)"
                    : "inset 0 0 0 1px rgba(255,255,255,0.03)",
                  zIndex: storyboard ? 1 : 6,
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const worldPoint = toWorld(event.clientX, event.clientY);
                  beginGroupDrag(group, worldPoint.x, worldPoint.y, bounds);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (editingTextNodeId) commitTextNodeEditing();
                  setActiveGroupId(group.id);
                  setSelectedNodeIds(group.nodeIds);
                  setSelectedEdgeIds([]);
                  setActiveNodeId(null);
                  closePromptMenus();
                  setLayoutDropdownOpen(false);
                  setColorPaletteOpen(false);
                  setSelectionLayoutMenuOpen(false);
                }}
              />
              <div className="absolute z-20 whitespace-nowrap text-[14px] text-[#d5d5d8]" style={{ left: bounds.left, top: bounds.top - 22 }}>
                {isEditingGroupTitle ? (
                  <input
                    data-group-title-editor
                    value={editingGroupTitleDraft}
                    autoFocus
                    className="h-6 min-w-[160px] rounded border border-[#3a404a] bg-[#10151f] px-1.5 text-[14px] text-white outline-none"
                    onChange={(event) => setEditingGroupTitleDraft(event.target.value)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onBlur={() => commitGroupTitle(group.id, group.title || (storyboard ? "宫格分镜组" : "分组"))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitGroupTitle(group.id, group.title || (storyboard ? "宫格分镜组" : "分组"));
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelGroupTitleEdit();
                      }
                    }}
                  />
                ) : (
                  <button
                    className="cursor-text text-left hover:text-white"
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      startEditGroupTitle(group);
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    {getGroupDisplayTitle(group)}
                  </button>
                )}
              </div>
            </Fragment>
          );
        })); }
  return renderCanvasGroupLayer;
}
