import type { ProductScriptAssetKind } from "./canvasDataTypes";
import { useState } from "react";

export function useCanvasProductState() {
  const [productScriptFullscreenNodeId, setProductScriptFullscreenNodeId] = useState<string | null>(null);
  const [productScriptVideoUploadTargetNodeId, setProductScriptVideoUploadTargetNodeId] = useState<string | null>(null);
  const [productScriptAssetUploadTarget, setProductScriptAssetUploadTarget] = useState<{ nodeId: string; kind: ProductScriptAssetKind } | null>(null);

  return {
    productScriptFullscreenNodeId, setProductScriptFullscreenNodeId,
    productScriptVideoUploadTargetNodeId, setProductScriptVideoUploadTargetNodeId,
    productScriptAssetUploadTarget, setProductScriptAssetUploadTarget,
  };
}
