import { CANVAS_SHORTCUTS, getCanvasShortcutTokens } from "./canvasKeyboardDefinitions";
import type { CanvasShortcutSection } from "./CanvasShortcutPanel";

export function buildCanvasShortcutSections(isMac: boolean): CanvasShortcutSection[] {
  const primaryKey = isMac ? "⌘" : "Ctrl";
  const optionKey = isMac ? "⌥" : "Alt";
  const deleteKey = isMac ? "⌫ / Delete" : "Delete / Backspace";

  return [
    {
      title: "创作",
      rows: [
        { label: "成组", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.group) },
        { label: "解组", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.ungroup) },
        { label: "合并分镜组", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.mergeStoryboardGroups) },
        { label: "连线", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.connect) },
        { label: "复制节点和连线", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.duplicate) },
        { label: "生成", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.generate) },
        { label: "新建节点", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.createNode) },
        { label: "复制所选节点和连线", keys: [optionKey], suffix: "+拖动" },
      ],
    },
    {
      title: "缩放",
      rows: [
        { label: "放大", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.zoomIn) },
        { label: "缩小", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.zoomOut) },
        { label: "适应画布", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.fitCanvas) },
        { label: "触控板", gesture: "hand", suffix: "双指缩放" },
        { label: "鼠标", keys: [primaryKey], gesture: "mouse", suffix: "+滚轮" },
      ],
    },
    {
      title: "移动画布",
      rows: [
        { label: "键盘", keys: ["Space"], gesture: "mouse", suffix: "+左键拖拽" },
        { label: "触控板", gesture: "hand", suffix: "左键拖拽" },
        { label: "鼠标", gesture: "mouse", suffix: "左键拖拽" },
        { label: "整理画布", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.arrangeCanvas) },
      ],
    },
    {
      title: "其他",
      rows: [
        { label: "撤销", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.undo) },
        { label: "重做", keys: getCanvasShortcutTokens(CANVAS_SHORTCUTS.redo) },
        { label: "删除", keys: [deleteKey] },
      ],
    },
  ];
}
