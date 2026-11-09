import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { X } from "lucide-react";
import { forwardRef } from "react";
import type { ReactNode } from "react";
import { mergeConsoleClassName } from "./class-names";
import "./primitives.css";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export interface PopoverContentProps extends Omit<PopoverPrimitive.Popup.Props, "children"> {
  children: ReactNode;
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  collisionPadding?: PopoverPrimitive.Positioner.Props["collisionPadding"];
  portalContainer?: PopoverPrimitive.Portal.Props["container"];
}

export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  function PopoverContent(
    {
      children,
      className,
      side = "bottom",
      align = "center",
      sideOffset = 7,
      alignOffset,
      collisionPadding = 10,
      portalContainer,
      ...props
    },
    ref,
  ) {
    return (
      <PopoverPrimitive.Portal container={portalContainer}>
        <PopoverPrimitive.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          collisionPadding={collisionPadding}
          className="cuiPopoverPositioner"
        >
          <PopoverPrimitive.Popup
            {...props}
            ref={ref}
            className={mergeConsoleClassName<PopoverPrimitive.Popup.State>("cuiPopover", className)}
          >
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    );
  },
);

export const PopoverTitle = forwardRef<HTMLHeadingElement, PopoverPrimitive.Title.Props>(
  function PopoverTitle({ className, ...props }, ref) {
    return (
      <PopoverPrimitive.Title
        {...props}
        ref={ref}
        className={mergeConsoleClassName<PopoverPrimitive.Title.State>("cuiPopoverTitle", className)}
      />
    );
  },
);

export const PopoverDescription = forwardRef<HTMLParagraphElement, PopoverPrimitive.Description.Props>(
  function PopoverDescription({ className, ...props }, ref) {
    return (
      <PopoverPrimitive.Description
        {...props}
        ref={ref}
        className={mergeConsoleClassName<PopoverPrimitive.Description.State>("cuiPopoverDescription", className)}
      />
    );
  },
);

export interface PopoverCloseProps extends PopoverPrimitive.Close.Props {
  label?: string;
}

export const PopoverClose = forwardRef<HTMLButtonElement, PopoverCloseProps>(
  function PopoverClose({ children, className, label = "关闭", "aria-label": ariaLabel, ...props }, ref) {
    const hasVisibleLabel = children !== undefined && children !== null;

    return (
      <PopoverPrimitive.Close
        {...props}
        ref={ref}
        aria-label={ariaLabel ?? (hasVisibleLabel ? undefined : label)}
        className={mergeConsoleClassName<PopoverPrimitive.Close.State>("cuiPopoverClose", className)}
      >
        {hasVisibleLabel ? children : <X aria-hidden="true" size={16} strokeWidth={1.8} />}
      </PopoverPrimitive.Close>
    );
  },
);
