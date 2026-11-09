import { useCanvasRedraw } from "./CanvasRedrawProvider";
import { Palette } from "lucide-react";
import { OPEN_CREATION_MENU_ITEMS } from "./canvasPageConstants";
import { getCreationMenuItemState } from "./canvasCreationMenuViewModel";
import { supportsCanvasVideoDraft } from "./canvasVideoDraft";
import { CanvasCreationMenuItem } from "./CanvasCreationMenuItem";
import { CanvasVideoEditMenuItem } from "./CanvasVideoEditMenuItem";
import type { NodeData } from "./canvasDataTypes";
import type { NodeType } from "./canvasMediaTypes";

export function CanvasCreationMenuItems({ isConnectionMenu, sourceNodeType, sourceNodeId, nodes, x, y, availableModels, onCreateNode, onCreateDraft, onCreateVideo, onMaterial, onClose }: { isConnectionMenu: boolean; sourceNodeType?: NodeData["type"]; sourceNodeId?: string | null; nodes: NodeData[]; x: number; y: number; availableModels: Parameters<typeof supportsCanvasVideoDraft>[0][]; onCreateNode: (type: NodeType, x: number, y: number) => void; onCreateDraft: (x: number, y: number) => void; onCreateVideo: (mode: "edit" | "extend", source: NodeData | null, x: number, y: number) => void; onMaterial: () => void; onClose: () => void }) {
  const redraw=useCanvasRedraw();
  return <div className={isConnectionMenu ? "space-y-3" : "space-y-1.5"}>
    {redraw ? <CanvasCreationMenuItem label="转绘节点" Icon={Palette} disabled={isConnectionMenu && !["video","image"].includes(sourceNodeType || "")} connection={isConnectionMenu} onClick={()=>redraw.create(x,y,isConnectionMenu && sourceNodeId ? [sourceNodeId] : [])}/> : null}
    {OPEN_CREATION_MENU_ITEMS.map((item) => {
      const { isDisabled, itemLabel, Icon } = getCreationMenuItemState(item, { isConnectionMenu, sourceNodeType, availableVideoDraft: availableModels.some(supportsCanvasVideoDraft) });
      return <CanvasCreationMenuItem key={item.key} label={itemLabel} Icon={Icon} disabled={isDisabled} connection={isConnectionMenu} badge={"badge" in item && item.badge && !(isConnectionMenu && item.key === "material") ? item.badge : undefined} onClick={() => {
        if (isDisabled) return;
        if (item.kind === "node") return onCreateNode(item.nodeType, x, y);
        if (item.key === "video-draft") return onCreateDraft(x, y);
        if (item.key === "video-extend" || item.key === "video-edit") return onCreateVideo(item.key === "video-edit" ? "edit" : "extend", isConnectionMenu ? nodes.find((node) => node.id === sourceNodeId) || null : null, x, y);
        if (item.key === "material") return onMaterial();
        onClose();
      }} />;
    })}
    {isConnectionMenu && sourceNodeType === "video" && sourceNodeId ? <CanvasVideoEditMenuItem onEdit={() => { const source = nodes.find((node) => node.id === sourceNodeId) || null; if (!source) return onClose(); onCreateVideo("edit", source, x, y); }} /> : null}
  </div>;
}
