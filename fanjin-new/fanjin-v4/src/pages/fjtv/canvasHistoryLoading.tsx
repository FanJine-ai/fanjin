import { api } from "@/lib/api";
import { type HistoryAssetItem } from "./canvasDataTypes";

export interface CanvasHistoryLoadingDependencies {
  ensureApiKeyReady: () => any;
  setHistoryLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setHistoryItems: React.Dispatch<React.SetStateAction<HistoryAssetItem[]>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
}

export function createCanvasHistoryLoading({
  ensureApiKeyReady,
  setHistoryLoading,
  setHistoryItems,
  setStatus,
}: CanvasHistoryLoadingDependencies) {
async function loadHistoryItems() {
    if (!ensureApiKeyReady()) return;
    setHistoryLoading(true);
    try {
      const result = await api.getAiHistory({ type: "all", sort: "desc", limit: 100 });
      const resultAny = result as any;
      const items = Array.isArray(resultAny?.items)
        ? resultAny.items
        : Array.isArray(resultAny?.data?.items)
          ? resultAny.data.items
          : Array.isArray(resultAny?.data)
            ? resultAny.data
            : Array.isArray(resultAny)
              ? resultAny
              : [];
      setHistoryItems(items);
    } catch {
      setHistoryItems([]);
      setStatus("历史记录加载失败");
    } finally {
      setHistoryLoading(false);
    }
  }
  return { loadHistoryItems };
}
