export function isEditableCanvasKeyboardTarget(target: EventTarget | null): boolean {
  const fallback = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const element = target instanceof HTMLElement ? target : fallback;
  if (!element) return false;
  const candidates = [element, fallback].filter((item): item is HTMLElement => Boolean(item));
  return candidates.some((item) => item.isContentEditable || Boolean(item.closest("textarea, input, select, [contenteditable='true'], [data-text-editor='true']")));
}
