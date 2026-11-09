export function shouldIgnoreCanvasWheelExternal(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(["[data-fixed-ui]", "[data-menu-panel]", "[data-workflow-panel]", "[data-asset-panel]", "[data-history-panel]", "[data-shortcut-panel]", "[data-asset-manager]", "[data-storyboard-slot-menu]", "input", "textarea", "select", "[contenteditable='true']"].join(",")));
}
