import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronDown } from "lucide-react";
import { forwardRef } from "react";
import type { ReactNode } from "react";
import { consoleClassNames, mergeConsoleClassName } from "./class-names";
import "./primitives.css";

export type AccordionProps<Value = string> = AccordionPrimitive.Root.Props<Value>;

export function Accordion<Value = string>({ className, ...props }: AccordionProps<Value>) {
  return (
    <AccordionPrimitive.Root
      {...props}
      className={mergeConsoleClassName<AccordionPrimitive.Root.State<Value>>("cuiAccordion", className)}
    />
  );
}

export const AccordionItem = forwardRef<HTMLDivElement, AccordionPrimitive.Item.Props>(
  function AccordionItem({ className, ...props }, ref) {
    return (
      <AccordionPrimitive.Item
        {...props}
        ref={ref}
        className={mergeConsoleClassName<AccordionPrimitive.Item.State>("cuiAccordionItem", className)}
      />
    );
  },
);

export interface AccordionTriggerProps extends AccordionPrimitive.Trigger.Props {
  children: ReactNode;
  headerClassName?: string;
}

export const AccordionTrigger = forwardRef<HTMLElement, AccordionTriggerProps>(
  function AccordionTrigger({ children, className, headerClassName, ...props }, ref) {
    return (
      <AccordionPrimitive.Header className={consoleClassNames("cuiAccordionHeader", headerClassName)}>
        <AccordionPrimitive.Trigger
          {...props}
          ref={ref}
          className={mergeConsoleClassName<AccordionPrimitive.Trigger.State>("cuiAccordionTrigger", className)}
        >
          <span className="cuiAccordionTriggerLabel">{children}</span>
          <ChevronDown className="cuiAccordionChevron" aria-hidden="true" size={16} strokeWidth={1.8} />
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
    );
  },
);

export interface AccordionContentProps extends AccordionPrimitive.Panel.Props {
  children: ReactNode;
  contentClassName?: string;
}

export const AccordionContent = forwardRef<HTMLDivElement, AccordionContentProps>(
  function AccordionContent({ children, className, contentClassName, ...props }, ref) {
    return (
      <AccordionPrimitive.Panel
        {...props}
        ref={ref}
        className={mergeConsoleClassName<AccordionPrimitive.Panel.State>("cuiAccordionPanel", className)}
      >
        <div className={consoleClassNames("cuiAccordionContent", contentClassName)}>{children}</div>
      </AccordionPrimitive.Panel>
    );
  },
);
