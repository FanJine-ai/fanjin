import React, { useCallback, useEffect, useState } from "react";
import { apiPost } from "../api/http";

interface StoryboardRow {
  id: number;
  src?: string;
  name?: string;
  startTime?: string;
  prompt?: string;
  [key: string]: any;
}

interface Props {
  open: boolean;
  scriptId: number;
  onConfirm: (rows: StoryboardRow[]) => void;
  onCancel: () => void;
}

export default function StoryboardImageCheck({ open, scriptId, onConfirm, onCancel }: Props) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<StoryboardRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [searchText, setSearchText] = useState("");

  useEffect(() => {
    if (open && scriptId) loadData();
  }, [open, scriptId]);

  async function loadData() {
    setLoading(true);
    try {
      const res = await apiPost("/production/getStoryboardData", { scriptId }) as any;
      setData(Array.isArray(res.data) ? res.data : []);
    } catch { setData([]); }
    setLoading(false);
  }

  function toggleSelect(id: number) {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  function handleConfirm() {
    const selected = data.filter((row) => selectedIds.includes(row.id));
    onConfirm(selected);
  }

  if (!open) return null;

  const filtered = searchText ? data.filter((row) => (row.name || row.prompt || "").includes(searchText)) : data;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }}>
      <div style={{ width: "80vw", maxHeight: "80vh", background: "#fff", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderBottom: "1px solid #e4e4e7" }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>选择分镜图片</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onCancel} style={{ padding: "6px 16px", border: "1px solid #e4e4e7", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 13 }}>取消</button>
            <button onClick={handleConfirm} disabled={!selectedIds.length} style={{ padding: "6px 16px", border: "none", borderRadius: 8, background: "#5d94bd", color: "#fff", cursor: "pointer", fontSize: 13, opacity: selectedIds.length ? 1 : 0.5 }}>确认选择</button>
          </div>
        </div>
        <div style={{ padding: "12px 20px", borderBottom: "1px solid #e4e4e7", display: "flex", gap: 8 }}>
          <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="搜索分镜…" style={{ width: 260, padding: "6px 12px", border: "1px solid #e4e4e7", borderRadius: 6, fontSize: 13, outline: "none" }} />
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: 40, color: "#71717a" }}>加载中…</div>
          ) : !filtered.length ? (
            <div style={{ textAlign: "center", padding: 40, color: "#a1a1aa" }}>暂无分镜数据</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
              {filtered.map((row) => (
                <div
                  key={row.id}
                  onClick={() => toggleSelect(row.id)}
                  style={{ border: selectedIds.includes(row.id) ? "2px solid #5d94bd" : "2px solid #e4e4e7", borderRadius: 10, overflow: "hidden", cursor: "pointer", transition: "border-color 0.15s" }}
                >
                  <div style={{ aspectRatio: "16/9", background: "#f4f4f5", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                    {row.src ? <img src={row.src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "#a1a1aa", fontSize: 12 }}>无图片</span>}
                  </div>
                  <div style={{ padding: "6px 8px", fontSize: 12, color: "#71717a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.name || row.prompt || `分镜 #${row.id}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
