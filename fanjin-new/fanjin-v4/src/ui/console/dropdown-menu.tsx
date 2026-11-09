import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, ChevronRight } from "lucide-react";
import { forwardRef } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { consoleClassNames, mergeConsoleClassName } from "./class-names";
import "./primitives.css";

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuSub = MenuPrimitive.SubmenuRoot;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

const dropdownMenuItemVariants = cva("cuiDropdownMenuItem", {
  variants: {
    tone: {
      default: "cuiDropdownMenuItem--default",
      danger: "cuiDropdownMenuItem--danger",
    },
    inset: {
      true: "cuiDropdownMenuItem--inset",
      false: "",
    },
  },
  defaultVariants: {
    tone: "default",
    inset: false,
  },
});

export interface DropdownMenuContentProps extends Omit<MenuPrimitive.Popup.Props, "children"> {
  children: ReactNode;
  side?: MenuPrimitive.Positioner.Props["side"];
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  collisionPadding?: MenuPrimitive.Positioner.Props["collisionPadding"];
  portalContainer?: MenuPrimitive.Portal.Props["container"];
}

export const DropdownMenuContent = forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  function DropdownMenuContent(
    {
      children,
      className,
      side = "bottom",
      align = "start",
      sideOffset = 6,
      alignOffset,
      collisionPadding = 10,
      portalContainer,
      ...props
    },
    ref,
  ) {
    return (
      <MenuPrimitive.Portal container={portalContainer}>
        <MenuPrimitive.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          collisionPadding={collisionPadding}
          className="cuiDropdownMenuPositioner"
        >
          <MenuPrimitive.Popup
            {...props}
            ref={ref}
            className={mergeConsoleClassName<MenuPrimitive.Popup.State>("cuiDropdownMenu", className)}
          >
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    );
  },
);

export const DropdownMenuSubContent = DropdownMenuContent;

export interface DropdownMenuItemProps
  extends MenuPrimitive.Item.Props,
    VariantProps<typeof dropdownMenuItemVariants> {}

export const DropdownMenuItem = forwardRef<HTMLElement, DropdownMenuItemProps>(
  function DropdownMenuItem({ className, tone, inset, ...props }, ref) {
    return (
      <MenuPrimitive.Item
        {...props}
        ref={ref}
        className={mergeConsoleClassName<MenuPrimitive.Item.State>(
          dropdownMenuItemVariants({ tone, inset }),
          className,
        )}
      />
    );
  },
);

export interface DropdownMenuLinkItemProps
  extends MenuPrimitive.LinkItem.Props,
    VariantProps<typeof dropdownMenuItemVariants> {}

export const DropdownMenuLinkItem = forwardRef<Element, DropdownMenuLinkItemProps>(
  function DropdownMenuLinkItem({ className, tone, inset, ...props }, ref) {
    return (
      <MenuPrimitive.LinkItem
        {...props}
        ref={ref}
        className={mergeConsoleClassName<MenuPrimitive.LinkItem.State>(
          dropdownMenuItemVariants({ tone, inset }),
          className,
        )}
      />
    );
  },
);

export interface DropdownMenuCheckboxItemProps extends MenuPrimitive.CheckboxItem.Props {
  children: ReactNode;
}

export const DropdownMenuCheckboxItem = forwardRef<HTMLElement, DropdownMenuCheckboxItemProps>(
  function DropdownMenuCheckboxItem({ children, className, ...props }, ref) {
    return (
      <MenuPrimitive.CheckboxItem
        {...props}
        ref={ref}
        className={mergeConsoleClassName<MenuPrimitive.CheckboxItem.State>(
          "cuiDropdownMenuItem cuiDropdownMenuSelectionItem",
          className,
        )}
      >
        <MenuPrimitive.CheckboxItemIndicator className="cuiDropdownMenuIndicator">
          <Check aria-hidden="true" size={14} strokeWidth={2} />
        </MenuPrimitive.CheckboxItemIndicator>
        <span className="cuiDropdownMenuItemLabel">{children}</span>
      </MenuPrimitive.CheckboxItem>
    );
  },
);

export interface DropdownMenuRadioItemProps extends MenuPrimitive.RadioItem.Props {
  children: ReactNode;
}

export const DropdownMenuRadioItem = forwardRef<HTMLElement, DropdownMenuRadioItemProps>(
  function DropdownMenuRadioItem({ children, className, ...props }, ref) {
    return (
      <MenuPrimitive.RadioItem
        {...props}
        ref={ref}
        className={mergeConsoleClassName<MenuPrimitive.RadioItem.State>(
          "cuiDropdownMenuItem cuiDropdownMenuSelectionItem",
          className,
        )}
      >
        <MenuPrimitive.RadioItemIndicator className="cuiDropdownMenuIndicator">
          <span className="cuiDropdownMenuRadioDot" />
        </MenuPrimitive.RadioItemIndicator>
        <span className="cuiDropdownMenuItemLabel">{children}</span>
      </MenuPrimitive.RadioItem>
    );
  },
);

export interface DropdownMenuSubTriggerProps extends MenuPrimitive.SubmenuTrigger.Props {
  children: ReactNode;
  inset?: boolean;
}

export const DropdownMenuSubTrigger = forwardRef<HTMLElement, DropdownMenuSubTriggerProps>(
  function DropdownMenuSubTrigger({ children, className, inset = false, ...props }, ref) {
    return (
      <MenuPrimitive.SubmenuTrigger
        {...props}
        ref={ref}
        className={mergeConsoleClassName<MenuPrimitive.SubmenuTrigger.State>(
          consoleClassNames("cuiDropdownMenuItem cuiDropdownMenuSubTrigger", inset && "cuiDropdownMenuItem--inset"),
          className,
        )}
      >
        <span className="cuiDropdownMenuItemLabel">{children}</span>
        <ChevronRight className="cuiDropdownMenuSubIcon" aria-hidden="true" size={14} strokeWidth={1.8} />
      </MenuPrimitive.SubmenuTrigger>
    );
  },
);

export const DropdownMenuLabel = forwardRef<HTMLDivElement, MenuPrimitive.GroupLabel.Props>(
  function DropdownMenuLabel({ className, ...props }, ref) {
    return (
      <MenuPrimitive.GroupLabel
        {...props}
        ref={ref}
        className={mergeConsoleClassName<MenuPrimitive.GroupLabel.State>("cuiDropdownMenuLabel", className)}
      />
    );
  },
);

export const DropdownMenuSeparator = forwardRef<HTMLDivElement, MenuPrimitive.Separator.Props>(
  function DropdownMenuSeparator({ className, ...props }, ref) {
    return (
      <MenuPrimitive.Separator
        {...props}
        ref={ref}
        className={mergeConsoleClassName<MenuPrimitive.Separator.State>("cuiDropdownMenuSeparator", className)}
      />
    );
  },
);

export function DropdownMenuShortcut({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={consoleClassNames("cuiDropdownMenuShortcut", className)} />;
}
