import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function consoleClassNames(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function mergeConsoleClassName<State>(
  baseClassName: string,
  className?: string | ((state: State) => string | undefined),
) {
  if (typeof className === "function") {
    return (state: State) => consoleClassNames(baseClassName, className(state));
  }

  return consoleClassNames(baseClassName, className);
}
