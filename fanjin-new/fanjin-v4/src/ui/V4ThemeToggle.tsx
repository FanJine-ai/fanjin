import type { ButtonHTMLAttributes } from "react";
import { Circle, Moon } from "lucide-react";
import type { ThemeMode } from "./theme";
import "./V4ThemeToggle.css";

type V4ThemeToggleProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "onClick"> & {
  mode: ThemeMode;
  onToggle: () => void;
};

/** Icon shows the destination theme: light → moon (switch to dark), dark → sun/circle. */
export function V4ThemeToggle({ mode, onToggle, className = "", title, ...buttonProps }: V4ThemeToggleProps) {
  const dark = mode === "dark";
  const label = dark ? "切换浅色模式" : "切换深色模式";

  return (
    <button
      {...buttonProps}
      className={`v4ThemeToggle ${className}`.trim()}
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onToggle}
    >
      {dark ? <Circle size={17} /> : <Moon size={17} />}
    </button>
  );
}
