import type { HistoryAssetItem } from "./canvasDataTypes";
import { useState } from "react";

export function useCanvasHistoryPanelState() {
  const [historyItems, setHistoryItems] = useState<HistoryAssetItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTab, setHistoryTab] = useState<"image" | "video" | "audio">("image");
  const [historyPreviewItem, setHistoryPreviewItem] = useState<HistoryAssetItem | null>(null);
  return {
    historyItems, setHistoryItems,
    historyLoading, setHistoryLoading,
    historyTab, setHistoryTab,
    historyPreviewItem, setHistoryPreviewItem,
  };
}
