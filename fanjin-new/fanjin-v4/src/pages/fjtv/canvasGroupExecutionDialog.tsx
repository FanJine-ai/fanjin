import type React from "react";
import type { GroupData, NodeData } from "./canvasDataTypes";

interface GroupExecutionDialogDependencies {
  groupExecutionDialog: { groupId: string } | null;
  groups: GroupData[];
  getGroupExecutionPlan: (group: GroupData) => { orderedNodes: NodeData[]; cycleNodeIds: string[] };
  trapCanvasModalFocus: React.KeyboardEventHandler<HTMLDivElement>;
  groupExecutionCancelRef: React.Ref<HTMLButtonElement>;
  closeGroupExecutionDialog: () => void;
  groupExecutionRunning: boolean;
  startGroupExecution: () => void | Promise<void>;
}

export function renderGroupExecutionDialogExternal(deps: GroupExecutionDialogDependencies) {
    const { groupExecutionDialog, groups, getGroupExecutionPlan, trapCanvasModalFocus, groupExecutionCancelRef, closeGroupExecutionDialog, groupExecutionRunning, startGroupExecution } = deps;
    if (!groupExecutionDialog) return null;
    const group = groups.find((item) => item.id === groupExecutionDialog.groupId);
    if (!group) return null;
    const executionPlan = getGroupExecutionPlan(group);
    const executableNodes = executionPlan.orderedNodes;
    const hasCycle = executionPlan.cycleNodeIds.length > 0;

    return (
      <div
        data-fixed-ui
        className="absolute inset-0 z-[120] bg-black/72 backdrop-blur-[1px]"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div
          data-canvas-dialog
          id="canvas-group-execution-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="canvas-group-execution-title"
          aria-describedby="canvas-group-execution-description"
          tabIndex={-1}
          onKeyDown={trapCanvasModalFocus}
          className="absolute left-1/2 top-1/2 w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border border-[#3f4043] bg-[#2b2b2c] px-7 py-7 text-white shadow-[0_30px_80px_rgba(0,0,0,0.58)]"
        >
          <div id="canvas-group-execution-title" className="text-[22px] font-semibold leading-none">整组执行</div>
          <div id="canvas-group-execution-description" data-canvas-muted className="mt-6 space-y-3 text-[17px] leading-8 text-[#aeb0b5]">
            <p>
              即将对组内 <span className="text-white">{executableNodes.length}</span> 个生成节点依次执行，实际费用以各模型提交前的服务端报价为准，是否继续？
            </p>
            <p>仅生成节点会被执行，特殊节点需手动执行。</p>
            {hasCycle ? <p className="text-[#ff8f8f]">检测到循环依赖，请先断开循环连线后再执行。</p> : null}
          </div>
          <div className="mt-8 flex justify-end gap-4">
            <button
              ref={groupExecutionCancelRef}
              type="button"
              data-canvas-control
              className="h-12 rounded-[12px] border border-[#4a4a4c] bg-[#4a4a4c] px-6 text-[18px] font-semibold text-white hover:bg-[#555558]"
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={() => closeGroupExecutionDialog()}
            >
              取消
            </button>
            <button
              type="button"
              disabled={groupExecutionRunning || executableNodes.length === 0 || hasCycle}
              className="h-12 rounded-[12px] bg-[#12c8ff] px-6 text-[18px] font-semibold text-[#071116] hover:bg-[#28d5ff] disabled:cursor-not-allowed disabled:opacity-50"
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={() => void startGroupExecution()}
            >
              开始执行
            </button>
          </div>
        </div>
      </div>
    );
  }
