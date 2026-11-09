import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { forwardRef } from "react";
import type { ReactNode } from "react";
import { mergeConsoleClassName } from "./class-names";
import "./primitives.css";

export const Tooltip = TooltipPrimitive.Root;
export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export interface TooltipContentProps extends Omit<TooltipPrimitive.Popup.Props, "children"> {
  children: ReactNode;
  side?: TooltipPrimitive.Positioner.Props["side"];
  align?: TooltipPrimitive.Positioner.Props["align"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: TooltipPrimitive.Positioner.Props["alignOffset"];
  collisionPadding?: TooltipPrimitive.Positioner.Props["collisionPadding"];
  portalContainer?: TooltipPrimitive.Portal.Props["container"];
}

export const TooltipContent = forwardRef<HTMLDivElement, TooltipContentProps>(
  function TooltipContent(
    {
      children,
      className,
      side = "top",
      align = "center",
      sideOffset = 7,
      alignOffset,
      collisionPadding = 8,
      portalContainer,
      ...props
    },
    ref,
  ) {
    return (
      <TooltipPrimitive.Portal container={portalContainer}>
        <TooltipPrimitive.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          collisionPadding={collisionPadding}
          className="cuiTooltipPositioner"
        >
          <TooltipPrimitive.Popup
            {...props}
            ref={ref}
            className={mergeConsoleClassName<TooltipPrimitive.Popup.State>("cuiTooltip", className)}
          >
            {children}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    );
  },
);
