import type { NodeData } from "./canvasDataTypes";
import type { NodeType } from "./canvasMediaTypes";
import { CanvasCreationMenuItems } from "./CanvasCreationMenuItems";
import { CanvasCreationMenuResources } from "./CanvasCreationMenuResources";
import { supportsCanvasVideoDraft } from "./canvasVideoDraft";

type Props = {
  open: boolean;
  screen: { x: number; y: number } | null;
  source: string;
  sourceNodeType?: NodeData["type"];
  sourceNodeId?: string | null;
  nodes: NodeData[];
  x: number;
  y: number;
  availableModels: Parameters<typeof supportsCanvasVideoDraft>[0][];
  onHoverChange: (hovered: boolean) => void;
  onCreateNode: (type: NodeType, x: number, y: number) => void;
  onCreateDraft: (x: number, y: number) => void;
  onCreateVideo: (mode: "edit" | "extend", source: NodeData | null, x: number, y: number) => void;
  onMaterial: () => void;
  onUpload: () => void;
  onHistory: () => void;
  onClose: () => void;
};

export function CanvasCreationMenuOverlay({ open, screen, source, onHoverChange, onClose, onUpload, onHistory, ...props }: Props) {
  if (!open || !screen) return null;
  const isConnectionMenu = source === "connection";
  return <div id="canvas-creation-menu" data-menu-panel className={`absolute z-[80] max-h-[min(72vh,560px)] max-w-[calc(100vw-24px)] overflow-y-auto rounded-[24px] border border-[#3e4045] bg-[#282828] shadow-[0_28px_56px_rgba(0,0,0,0.48)] ${isConnectionMenu ? "w-[326px] px-7 py-7" : "w-[324px] p-5"}`} style={{ left: screen.x, top: screen.y }} onMouseEnter={() => onHoverChange(true)} onMouseLeave={() => onHoverChange(false)}>
    <div className={`${isConnectionMenu ? "mb-4 text-[15px]" : "mb-3 text-[14px]"} text-[#8e8f95]`}>{isConnectionMenu ? "引用该节点生成" : "添加节点"}</div>
    <CanvasCreationMenuItems isConnectionMenu={isConnectionMenu} sourceNodeType={props.sourceNodeType} sourceNodeId={props.sourceNodeId} nodes={props.nodes} x={props.x} y={props.y} availableModels={props.availableModels} onCreateNode={props.onCreateNode} onCreateDraft={props.onCreateDraft} onCreateVideo={props.onCreateVideo} onMaterial={props.onMaterial} onClose={onClose} />
    {!isConnectionMenu ? <CanvasCreationMenuResources onUpload={onUpload} onHistory={onHistory} /> : null}
  </div>;
}
