import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { mergeConsoleClassName } from "./class-names";
import "./primitives.css";

const selectionControlVariants = cva("cuiSelectionControl", {
  variants: {
    size: {
      default: "cuiSelectionControl--default",
      compact: "cuiSelectionControl--compact",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

export interface CheckboxProps
  extends CheckboxPrimitive.Root.Props,
    VariantProps<typeof selectionControlVariants> {
  indicator?: ReactNode;
}

export function Checkbox({ className, indicator, indeterminate = false, size, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      {...props}
      indeterminate={indeterminate}
      className={mergeConsoleClassName<CheckboxPrimitive.Root.State>(
        selectionControlVariants({ size, className: "cuiCheckbox" }),
        className,
      )}
    >
      <CheckboxPrimitive.Indicator className="cuiSelectionIndicator">
        {indicator ?? (
          indeterminate
            ? <Minus aria-hidden="true" size={14} strokeWidth={2.2} />
            : <Check aria-hidden="true" size={14} strokeWidth={2.2} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export type RadioGroupOrientation = "horizontal" | "vertical";

export interface RadioGroupProps<Value = string> extends RadioGroupPrimitive.Props<Value> {
  orientation?: RadioGroupOrientation;
}

export function RadioGroup<Value = string>({
  className,
  orientation = "vertical",
  ...props
}: RadioGroupProps<Value>) {
  return (
    <RadioGroupPrimitive
      {...props}
      data-orientation={orientation}
      className={mergeConsoleClassName<RadioGroupPrimitive.State>("cuiRadioGroup", className)}
    />
  );
}

export interface RadioGroupItemProps<Value = string>
  extends RadioPrimitive.Root.Props<Value>,
    VariantProps<typeof selectionControlVariants> {}

export function RadioGroupItem<Value = string>({
  className,
  size,
  ...props
}: RadioGroupItemProps<Value>) {
  return (
    <RadioPrimitive.Root
      {...props}
      className={mergeConsoleClassName<RadioPrimitive.Root.State>(
        selectionControlVariants({ size, className: "cuiRadio" }),
        className,
      )}
    >
      <RadioPrimitive.Indicator className="cuiRadioIndicator">
        <span className="cuiRadioDot" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}
