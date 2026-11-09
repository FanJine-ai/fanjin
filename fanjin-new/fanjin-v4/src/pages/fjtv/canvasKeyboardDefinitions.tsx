import type { CanvasShortcut } from "./canvasDataTypes";
import { createNode } from "./canvasNodeDefaults";

export const CANVAS_SHORTCUTS = {
  undo: { keys: ["z"], primary: true, alt: false, shift: false },
  redo: { keys: ["z"], primary: true, alt: false, shift: true },
  group: { keys: ["g"], primary: true, alt: true, shift: false },
  ungroup: { keys: ["g"], primary: true, alt: true, shift: true },
  mergeStoryboardGroups: { keys: ["m"], primary: true, alt: true, shift: false },
  duplicate: { keys: ["c"], primary: true, alt: false, shift: true },
  connect: { keys: ["l"], primary: true, alt: false, shift: false },
  generate: { keys: ["Enter"], primary: true, alt: false, shift: false },
  createNode: { keys: ["Tab"], primary: false, alt: false, shift: false },
  zoomIn: { keys: ["+", "="], primary: true, alt: false, labelKey: "+" },
  zoomOut: { keys: ["-"], primary: true, alt: false, shift: false },
  fitCanvas: { keys: ["0"], primary: true, alt: false, shift: false },
  arrangeCanvas: { keys: ["f"], primary: false, alt: true, shift: true },
  deleteSelection: { keys: ["Delete", "Backspace"], primary: false, alt: false, shift: false },
} satisfies Record<string, CanvasShortcut>;

export function matchesCanvasShortcut(event: KeyboardEvent, shortcut: CanvasShortcut) {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!shortcut.keys.includes(key)) return false;
  if (shortcut.primary !== undefined && shortcut.primary !== (event.ctrlKey || event.metaKey)) return false;
  if (shortcut.alt !== undefined && shortcut.alt !== event.altKey) return false;
  if (shortcut.shift !== undefined && shortcut.shift !== event.shiftKey) return false;
  return true;
}

export function getCanvasShortcutTokens(shortcut: CanvasShortcut) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/i.test(navigator.platform);
  const tokens: string[] = [];
  if (shortcut.primary) tokens.push(isMac ? "⌘" : "Ctrl");
  if (shortcut.alt) tokens.push(isMac ? "⌥" : "Alt");
  if (shortcut.shift) tokens.push(isMac ? "⇧" : "Shift");
  const key = shortcut.labelKey || shortcut.keys[0];
  tokens.push(key.length === 1 ? key.toUpperCase() : key);
  return tokens;
}
