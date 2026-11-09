export function canvasTextContent(node: { outputText?: string; prompt?: string }): string {
  return node.outputText ?? node.prompt ?? "";
}

/** Controls and overlays belong to their own interaction surfaces, never to the canvas background. */
export function isCanvasBackgroundTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !target.closest([
    "[data-node-card]", "[data-fixed-ui]", "[data-menu-panel]", "[data-workflow-panel]",
    "[data-asset-panel]", "[data-history-panel]", "[data-shortcut-panel]", "[data-asset-manager]",
    "[data-node-prompt-panel]", "[data-node-settings-panel]", "[data-anchor-btn]",
    "[data-node-resize-handle]", "[role=dialog]", "[role=menu]", "[role=button]",
    "button", "a", "input", "textarea", "select", "[contenteditable=true]", "header", "aside", "nav",
  ].join(","));
}
