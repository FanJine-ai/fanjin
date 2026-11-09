import { CanvasAddNodeToolbarButton } from "./CanvasAddNodeToolbarButton";
import { CanvasWorkflowToolbarButton } from "./CanvasWorkflowToolbarButton";
import { CanvasProjectAssetToolbarButton } from "./CanvasProjectAssetToolbarButton";
import { CanvasHistoryToolbarButton } from "./CanvasHistoryToolbarButton";
import { CanvasShortcutToolbarButton } from "./CanvasShortcutToolbarButton";

type Props = {
  creationOpen: boolean;
  workflowAvailable: boolean;
  workflowOpen: boolean;
  assetOpen: boolean;
  historyOpen: boolean;
  shortcutOpen: boolean;
  pendingHistoryCount: number;
  onCreation: () => void;
  onWorkflow: () => void;
  onAsset: () => void;
  onHistory: () => void;
  onShortcut: () => void;
};

export function CanvasMainToolbar({ creationOpen, workflowAvailable, workflowOpen, assetOpen, historyOpen, shortcutOpen, pendingHistoryCount, onCreation, onWorkflow, onAsset, onHistory, onShortcut }: Props) {
  return <div className="canvas-main-toolbar flex items-center"><CanvasAddNodeToolbarButton open={creationOpen} onOpen={onCreation} /><div className="flex items-center gap-1">{workflowAvailable ? <CanvasWorkflowToolbarButton open={workflowOpen} onToggle={onWorkflow} /> : null}<CanvasProjectAssetToolbarButton open={assetOpen} onOpen={onAsset} /><CanvasHistoryToolbarButton open={historyOpen} pendingCount={pendingHistoryCount} onToggle={onHistory} /><CanvasShortcutToolbarButton open={shortcutOpen} onToggle={onShortcut} /></div></div>;
}
