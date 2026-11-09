import { Link2 } from "lucide-react";
import type { NodeType } from "./canvasMediaTypes";
import { isCanvasNodeConnectionAllowed } from "./canvasGraphPolicy";
import type { OPEN_CREATION_MENU_ITEMS } from "./canvasPageConstants";

export type CanvasCreationMenuItem = typeof OPEN_CREATION_MENU_ITEMS[number];

export function getCreationMenuItemState(item: CanvasCreationMenuItem, options: {
  isConnectionMenu: boolean;
  sourceNodeType?: NodeType;
  availableVideoDraft: boolean;
}) {
  const isDisabled = Boolean(
    (item.key === "video-draft" && !options.availableVideoDraft) || options.isConnectionMenu
    && (
      (item.kind === "action" && (item.key !== "video-extend" || options.sourceNodeType !== "video"))
      || (
        options.sourceNodeType
        && item.kind === "node"
        && !isCanvasNodeConnectionAllowed(options.sourceNodeType, item.nodeType)
      )
    ),
  );
  const itemLabel = options.isConnectionMenu && item.key === "material" ? "参考节点" : item.label;
  const Icon = options.isConnectionMenu && item.key === "material" ? Link2 : item.icon;
  return { isDisabled, itemLabel, Icon };
}
