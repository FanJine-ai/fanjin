import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { IMAGE_GRID_PRESETS, STORYBOARD_RATIO_ITEMS, STORYBOARD_STITCH_RESOLUTIONS } from "./canvasMediaMenuConfig";
import type { LayoutMode, StoryboardGroupType, StoryboardStitchResolution, NodeData, GroupData, GroupDragState } from "./canvasDataTypes";
import type { RatioKey } from "./canvasMediaTypes";
import { ChevronDown, Circle, Columns3, Download, LayoutGrid, NotebookTabs, Play, Rows3, Scissors, Square, Trash2, Workflow } from "lucide-react";

export interface CanvasGroupToolbarDependencies {
  activeGroupBounds: { left: number; top: number; right: number; bottom: number; } | null;
  activeGroup: GroupData | null;
  groupDrag: GroupDragState;
  toWorld: (clientX: number, clientY: number) => { x: number; y: number; };
  nodes: NodeData[];
  setGroupDrag: Dispatch<SetStateAction<GroupDragState>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  activeGroupFullySelected: boolean;
  groupToolbarCenterX: number | null;
  isStoryboardGroup: (group: GroupData | null | undefined) => group is GroupData & { groupType: StoryboardGroupType; };
  getCanvasToolbarTop: (targetTop: number, visualOffset?: number) => number;
  getCanvasToolbarScale: (multiplier?: number) => number;
  setStoryboardToolbarRatioOpen: Dispatch<SetStateAction<boolean>>;
  setStoryboardToolbarGridOpen: Dispatch<SetStateAction<boolean>>;
  setStoryboardToolbarStitchOpen: Dispatch<SetStateAction<boolean>>;
  storyboardToolbarRatioOpen: boolean;
  rebuildStoryboardGroupStructure: (group: GroupData, rows: number, cols: number, ratio: RatioKey) => void;
  storyboardToolbarGridOpen: boolean;
  storyboardToolbarStitchOpen: boolean;
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  stitchStoryboardGroup: (group: GroupData, resolution: StoryboardStitchResolution) => Promise<void>;
  updateActiveGroup: (patch: Partial<GroupData>) => void;
  clearStoryboardFilledSlots: (group: GroupData) => void;
  convertStoryboardGroupToRegular: (group: GroupData) => void;
  ungroupActive: () => void;
  setColorPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setLayoutDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setSelectionLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
  colorPaletteOpen: boolean;
  GROUP_THEME_COLORS: string[];
  layoutDropdownOpen: boolean;
  applyGroupLayout: (mode: LayoutMode) => void;
  groupExecutionDialog: { groupId: string; } | null;
  openGroupExecutionDialog: (group: GroupData, opener?: HTMLButtonElement) => void;
  workflowTemplatesAvailable: boolean;
  openCreateWorkflowModal: () => void;
  downloadMediaForNodeIds: (nodeIds: string[]) => Promise<void>;
  getGroupDownloadNodeIds: (group: GroupData) => string[];
}

export function createCanvasGroupToolbar(deps: CanvasGroupToolbarDependencies) {
  const {
    activeGroupBounds,
    activeGroup,
    groupDrag,
    toWorld,
    nodes,
    setGroupDrag,
    setSelectedNodeIds,
    setSelectedEdgeIds,
    setActiveNodeId,
    activeGroupFullySelected,
    groupToolbarCenterX,
    isStoryboardGroup,
    getCanvasToolbarTop,
    getCanvasToolbarScale,
    setStoryboardToolbarRatioOpen,
    setStoryboardToolbarGridOpen,
    setStoryboardToolbarStitchOpen,
    storyboardToolbarRatioOpen,
    rebuildStoryboardGroupStructure,
    storyboardToolbarGridOpen,
    storyboardToolbarStitchOpen,
    setGroups,
    stitchStoryboardGroup,
    updateActiveGroup,
    clearStoryboardFilledSlots,
    convertStoryboardGroupToRegular,
    ungroupActive,
    setColorPaletteOpen,
    setLayoutDropdownOpen,
    setSelectionLayoutMenuOpen,
    colorPaletteOpen,
    GROUP_THEME_COLORS,
    layoutDropdownOpen,
    applyGroupLayout,
    groupExecutionDialog,
    openGroupExecutionDialog,
    workflowTemplatesAvailable,
    openCreateWorkflowModal,
    downloadMediaForNodeIds,
    getGroupDownloadNodeIds,
  } = deps;
  function renderCanvasGroupToolbar() { return (activeGroupBounds && activeGroup ? (
          <>
            <button
              data-group-drag-handle
              className="absolute z-20 rounded-[10px] border border-transparent bg-transparent transition hover:border-white/10 hover:bg-white/[0.025]"
              style={{
                left: activeGroupBounds.left + 8,
                top: activeGroupBounds.top + 8,
                width: Math.max(140, Math.min(activeGroupBounds.right - activeGroupBounds.left - 16, 220)),
                height: 28,
                cursor: groupDrag.active ? "grabbing" : "grab",
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const world = toWorld(event.clientX, event.clientY);
                const originalPositions: Record<string, { x: number; y: number }> = {};
                nodes.forEach((node) => {
                  if (activeGroup.nodeIds.includes(node.id)) originalPositions[node.id] = { x: node.x, y: node.y };
                });
                setGroupDrag({
                  active: true,
                  groupId: activeGroup.id,
                  startX: world.x,
                  startY: world.y,
                  originalPositions,
                  startBounds: { ...activeGroupBounds },
                });
                setSelectedNodeIds(activeGroup.nodeIds);
                setSelectedEdgeIds([]);
                setActiveNodeId(null);
              }}
            />
            {[
              { left: activeGroupBounds.left - 4, top: activeGroupBounds.top - 4 },
              { left: activeGroupBounds.right - 4, top: activeGroupBounds.top - 4 },
              { left: activeGroupBounds.left - 4, top: activeGroupBounds.bottom - 4 },
              { left: activeGroupBounds.right - 4, top: activeGroupBounds.bottom - 4 },
            ].map((point, index) => (
              <div key={index} className="absolute h-2 w-2 rounded-[2px] bg-[#a8aaaf]" style={point} />
            ))}
            {activeGroupFullySelected && groupToolbarCenterX !== null ? (
              isStoryboardGroup(activeGroup) ? (
                <div
                  data-canvas-toolbar
                  className="absolute rounded-[22px] border border-[#3e4045] bg-[#262628] px-5 py-4 text-[15px] text-[#f2f2f3] shadow-[0_20px_42px_rgba(0,0,0,0.38)]"
                  style={{ left: groupToolbarCenterX, top: getCanvasToolbarTop(activeGroupBounds.top, 82), transform: `translateX(-50%) scale(${getCanvasToolbarScale()})`, transformOrigin: "center top" }}
                >
                  <div className="flex items-center whitespace-nowrap leading-none">
                    <div className="relative pr-4">
                      <button className="flex h-10 items-center gap-2 rounded-[12px] px-3 hover:bg-[#333336]" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setStoryboardToolbarRatioOpen((v) => !v); setStoryboardToolbarGridOpen(false); setStoryboardToolbarStitchOpen(false); }}>
                        <Square className="h-4 w-4" />
                        <span>{activeGroup.storyboardRatio || "16:9"}</span>
                        <ChevronDown className="h-3.5 w-3.5 text-[#9ea2a9]" />
                      </button>
                      {storyboardToolbarRatioOpen ? (
                        <div data-canvas-popover className="absolute bottom-[52px] left-0 z-20 w-[132px] rounded-[14px] border border-[#4a4b50] bg-[#28282a] p-2 shadow-[0_20px_42px_rgba(0,0,0,0.38)]">
                          {STORYBOARD_RATIO_ITEMS.map((ratio) => (
                            <button key={ratio} className="flex h-10 w-full items-center rounded-[10px] px-3 text-left hover:bg-[#343437]" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); rebuildStoryboardGroupStructure(activeGroup, activeGroup.storyboardRows || 2, activeGroup.storyboardCols || 2, ratio); setStoryboardToolbarRatioOpen(false); }}>
                              {ratio}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="relative pr-4">
                      <button className="flex h-10 items-center gap-2 rounded-[12px] px-3 hover:bg-[#333336]" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setStoryboardToolbarGridOpen((v) => !v); setStoryboardToolbarRatioOpen(false); setStoryboardToolbarStitchOpen(false); }}>
                        <LayoutGrid className="h-4 w-4" />
                        <span>{`${activeGroup.storyboardRows || 2}x${activeGroup.storyboardCols || 2}`}</span>
                        <ChevronDown className="h-3.5 w-3.5 text-[#9ea2a9]" />
                      </button>
                      {storyboardToolbarGridOpen ? (
                        <div data-canvas-popover className="absolute bottom-[52px] left-0 z-20 w-[180px] rounded-[14px] border border-[#4a4b50] bg-[#28282a] p-2 shadow-[0_20px_42px_rgba(0,0,0,0.38)]">
                          {IMAGE_GRID_PRESETS.map((preset) => (
                            <button key={preset.key} className="flex h-10 w-full items-center rounded-[10px] px-3 text-left hover:bg-[#343437]" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); rebuildStoryboardGroupStructure(activeGroup, preset.rows, preset.cols, activeGroup.storyboardRatio || "16:9"); setStoryboardToolbarGridOpen(false); }}>
                              {`${preset.rows}x${preset.cols}`}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="relative px-4">
                      <button className="flex h-10 items-center gap-2 rounded-[12px] px-3 hover:bg-[#333336]" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setStoryboardToolbarStitchOpen((v) => !v); setStoryboardToolbarGridOpen(false); setStoryboardToolbarRatioOpen(false); }}>
                        <Columns3 className="h-4 w-4" />
                        <span>{`拼接(${(activeGroup.storyboardStitchResolution || "2k").toUpperCase()})`}</span>
                      </button>
                      {storyboardToolbarStitchOpen ? (
                        <div data-canvas-popover className="absolute bottom-[52px] left-0 z-20 w-[132px] rounded-[14px] border border-[#4a4b50] bg-[#28282a] p-2 shadow-[0_20px_42px_rgba(0,0,0,0.38)]">
                          {STORYBOARD_STITCH_RESOLUTIONS.map((resolution) => (
                            <button key={resolution} className="flex h-10 w-full items-center rounded-[10px] px-3 text-left hover:bg-[#343437]" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setGroups((prev) => prev.map((item) => item.id === activeGroup.id ? { ...item, storyboardStitchResolution: resolution } : item)); void stitchStoryboardGroup(activeGroup, resolution); setStoryboardToolbarStitchOpen(false); }}>
                              {resolution}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <button className="flex h-10 items-center gap-2 px-4 hover:text-white" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); updateActiveGroup({ storyboardShowOrder: !activeGroup.storyboardShowOrder }); }}>
                      <NotebookTabs className="h-4 w-4" />
                      <span>序号</span>
                    </button>
                    <button className="flex h-10 items-center gap-2 px-4 hover:text-white" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); clearStoryboardFilledSlots(activeGroup); }}>
                      <Trash2 className="h-4 w-4" />
                      <span>清空</span>
                    </button>
                    <button className="flex h-10 items-center gap-2 px-4 hover:text-white" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); convertStoryboardGroupToRegular(activeGroup); }}>
                      <Workflow className="h-4 w-4" />
                      <span>转普通组</span>
                    </button>
                    <button className="flex h-10 items-center gap-2 px-4 hover:text-white" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); ungroupActive(); }}>
                      <Scissors className="h-4 w-4" />
                      <span>解组</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  data-canvas-toolbar
                  className="absolute rounded-[18px] border border-[#4a4b50] bg-[#28282a] px-4 py-3 text-[15px] text-[#f2f2f3] shadow-[0_20px_42px_rgba(0,0,0,0.38)]"
                  style={{ left: groupToolbarCenterX, top: getCanvasToolbarTop(activeGroupBounds.top, 82), transform: `translateX(-50%) scale(${getCanvasToolbarScale()})`, transformOrigin: "center top" }}
                >
                  <div className="flex items-center whitespace-nowrap leading-none">
                    <div className="relative pr-2">
                      <button className="flex h-10 w-10 items-center justify-center rounded-full text-[#1f1f21]" style={{ backgroundColor: activeGroup.themeColor }} onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setColorPaletteOpen((v) => !v);
                        setLayoutDropdownOpen(false);
                        setSelectionLayoutMenuOpen(false);
                      }}>
                        <Circle className="h-4.5 w-4.5 fill-current" />
                      </button>
                      {colorPaletteOpen ? (
                        <div data-canvas-popover className="absolute bottom-[56px] left-0 z-20 grid w-[176px] grid-cols-4 gap-3 rounded-[16px] border border-[#4a4b50] bg-[#2b2b2d] p-3 shadow-[0_24px_44px_rgba(0,0,0,0.42)]">
                          {GROUP_THEME_COLORS.map((color) => (
                            <button
                              key={color}
                              className="h-8 w-8 rounded-full border-[3px] transition"
                              style={{ backgroundColor: color, borderColor: activeGroup.themeColor === color ? "#f3f3f4" : "rgba(255,255,255,0.08)" }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                updateActiveGroup({ themeColor: color });
                                setColorPaletteOpen(false);
                              }}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="h-8 w-px bg-[#3c3d42]" />
                    <div className="relative px-1">
                      <button className="flex h-10 w-10 items-center justify-center rounded-[10px] hover:bg-[#333336]" onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setLayoutDropdownOpen((v) => !v);
                        setColorPaletteOpen(false);
                        setSelectionLayoutMenuOpen(false);
                      }}>
                        <LayoutGrid className="h-4.5 w-4.5" />
                      </button>
                      {layoutDropdownOpen ? (
                        <div data-canvas-popover className="absolute bottom-[48px] left-0 z-20 w-[140px] rounded-[14px] border border-[#4a4b50] bg-[#28282a] p-2 shadow-[0_20px_42px_rgba(0,0,0,0.38)]">
                          <button className="flex h-10 w-full items-center gap-2 rounded-[10px] px-3 text-left hover:bg-[#343437]" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); applyGroupLayout("grid"); }}>
                            <LayoutGrid className="h-4 w-4" />
                            <span>宫格排列</span>
                          </button>
                          <button className="mt-1 flex h-10 w-full items-center gap-2 rounded-[10px] px-3 text-left hover:bg-[#343437]" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); applyGroupLayout("horizontal"); }}>
                            <Rows3 className="h-4 w-4" />
                            <span>水平排列</span>
                          </button>
                          <button className="mt-1 flex h-10 w-full items-center gap-2 rounded-[10px] px-3 text-left hover:bg-[#343437]" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); applyGroupLayout("vertical"); }}>
                            <Columns3 className="h-4 w-4" />
                            <span>垂直排列</span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <div className="h-8 w-px bg-[#3c3d42]" />
                    <button
                      className="flex h-10 items-center gap-2.5 whitespace-nowrap px-4 hover:text-white"
                      aria-haspopup="dialog"
                      aria-expanded={groupExecutionDialog !== null}
                      aria-controls="canvas-group-execution-dialog"
                      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                      onClick={(event) => openGroupExecutionDialog(activeGroup, event.currentTarget)}
                    >
                      <Play className="h-4.5 w-4.5" />
                      <span>整组执行</span>
                    </button>
                    {workflowTemplatesAvailable ? (
                      <>
                        <div className="h-8 w-px bg-[#3c3d42]" />
                        <button className="flex h-10 items-center gap-2.5 whitespace-nowrap px-4 hover:text-white" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); openCreateWorkflowModal(); }}>
                          <Workflow className="h-4.5 w-4.5" />
                          <span>添加到工具箱</span>
                        </button>
                      </>
                    ) : null}
                    <div className="h-8 w-px bg-[#3c3d42]" />
                    <button className="flex h-10 items-center gap-2.5 whitespace-nowrap px-4 hover:text-white" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); ungroupActive(); }}>
                      <Scissors className="h-4.5 w-4.5" />
                      <span>解组</span>
                    </button>
                    <div className="h-8 w-px bg-[#3c3d42]" />
                    <button className="flex h-10 items-center gap-2.5 whitespace-nowrap px-4 hover:text-white" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); void downloadMediaForNodeIds(getGroupDownloadNodeIds(activeGroup)); }}>
                      <Download className="h-4.5 w-4.5" />
                      <span>批量下载</span>
                    </button>
                  </div>
                </div>
              )
            ) : null}
          </>
        ) : null); }
  return renderCanvasGroupToolbar;
}
