import React, { useMemo, useState } from "react";
import { apiPost } from "../api/http";

interface Props {
  src: string;
  position?: "none" | "br" | "bl" | "tr" | "tl";
  margin?: string;
}

export default function ImageTools({ src, position = "none", margin = "4px" }: Props) {
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewSrc, setPreviewSrc] = useState("");

  const posStyle = useMemo(() => {
    const m = margin;
    const map: Record<string, React.CSSProperties> = {
      br: { position: "absolute", bottom: m, right: m },
      bl: { position: "absolute", bottom: m, left: m },
      tr: { position: "absolute", top: m, right: m },
      tl: { position: "absolute", top: m, left: m },
      none: { margin: m },
    };
    return map[position] || map.none;
  }, [position, margin]);

  const btnStyle: React.CSSProperties = {
    width: 28, height: 28, border: "1px solid #e4e4e7", borderRadius: 6,
    background: "#fff", cursor: "pointer", display: "flex", alignItems: "center",
    justifyContent: "center", fontSize: 14, color: "#71717a",
  };

  async function handlePreview() {
    try {
      const data = await apiPost("/common/getBigImage", { url: src }) as any;
      setPreviewSrc(data.data || src);
      setPreviewVisible(true);
    } catch { setPreviewSrc(src); setPreviewVisible(true); }
  }

  async function handleCopy() {
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = src;
      await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("图片加载失败")); });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error("转换失败")), "image/png");
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      (window as any).$message?.success?.("已复制到剪贴板");
    } catch {
      (window as any).$message?.error?.("复制失败");
    }
  }

  async function handleDownload() {
    const a = document.createElement("a");
    a.href = src;
    a.download = src.split("/").pop() || "image";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <>
      <div style={{ gap: 4, display: "flex", ...posStyle }}>
        <button onClick={(e) => { e.stopPropagation(); handleCopy(); }} style={btnStyle} title="复制">📋</button>
        <button onClick={(e) => { e.stopPropagation(); handlePreview(); }} style={btnStyle} title="预览">🔍</button>
        <button onClick={(e) => { e.stopPropagation(); handleDownload(); }} style={btnStyle} title="下载">⬇</button>
      </div>
      {previewVisible && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)" }} onClick={() => setPreviewVisible(false)}>
          <img src={previewSrc || src} alt="" style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }} />
        </div>
      )}
    </>
  );
}
