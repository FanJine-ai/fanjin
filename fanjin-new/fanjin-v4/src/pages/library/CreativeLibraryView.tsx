import { useV4Theme } from "../../ui/useV4Theme";
import "../frontstage/FrontstagePage.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listCompleteCreativeLibrary, type CreativeLibraryItem } from "../../api/creativeLibraryApi";
import { normalizeProjectId, useProjectStore } from "../../stores/projectStore";

function generationMode(item: CreativeLibraryItem): "image" | "video" | null {
  if (item.assetType === "image") return "image";
  if (item.assetType === "video") return "video";
  return null;
}

const labelledInternalIdentifierPattern = /(?:user|workspace|project|canvas|thread|session|task|asset(?:[-_ ]?version)?|request|usage|ledger|approval|run|node|provider|channel|route|model|用户|工作区|项目|画布|线程|会话|任务|资产|请求|用量|账本|审批|运行|节点|供应商|渠道|路由|模型)\s*(?:(?:[-_ ]?id)|编号)\s*[:#：=]?\s*[^\s,，;；]{1,300}/i;
const uuidIdentifierPattern = /(?:^|[^a-z0-9])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:$|[^a-z0-9])/i;
const longNumericIdentifierPattern = /(?:^|\D)\d{8,}(?:$|\D)/;
const structuredOpaqueIdentifierPattern = /(?:^|[^a-z0-9])(?=[a-z0-9:_-]{8,}(?:$|[^a-z0-9:_-]))(?=[a-z0-9:_-]*\d)(?=[a-z0-9:_-]*[:_-])[a-z0-9]+(?:[:_-][a-z0-9]+)+(?:$|[^a-z0-9:_-])/i;
const compactOpaqueIdentifierPattern = /(?:^|[^a-z0-9])(?=[a-z0-9]{12,}(?:$|[^a-z0-9]))(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]+(?:$|[^a-z0-9])/i;
const unsafeReferencePattern = /\b(?:https?|file|blob|data):|(?:^|\s)\/(?:api|assets|oss|Users|Volumes)\//i;

function containsInternalIdentifier(value: string): boolean {
  return labelledInternalIdentifierPattern.test(value)
    || uuidIdentifierPattern.test(value)
    || longNumericIdentifierPattern.test(value)
    || structuredOpaqueIdentifierPattern.test(value)
    || compactOpaqueIdentifierPattern.test(value)
    || unsafeReferencePattern.test(value)
    || /^\d+$/.test(value);
}

function libraryKindLabel(item: CreativeLibraryItem): string {
  if (item.assetType === "image") return "图片";
  if (item.assetType === "video") return "视频";
  if (item.assetType === "audio") return "音频";
  if (item.assetType === "file") return "文件";
  return "素材";
}

function libraryStatusLabel(status: unknown): string {
  switch (String(status || "").trim().toLowerCase()) {
    case "queued": return "排队中";
    case "running": return "生成中";
    case "enhancing": return "处理中";
    case "succeeded": return "已完成";
    case "failed": return "生成失败";
    case "cancelled": return "已取消";
    default: return "状态未知";
  }
}

function creativeLibraryDisplayTitle(item: CreativeLibraryItem): string {
  const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
  return prompt && !containsInternalIdentifier(prompt)
    ? prompt
    : `${libraryKindLabel(item)}生成结果`;
}

const publicMetadataFields = [
  ["requestedResolution", "目标分辨率"],
  ["resolution", "实际分辨率"],
  ["finalResolution", "最终分辨率"],
  ["width", "宽度"],
  ["height", "高度"],
  ["requestedDurationSeconds", "目标时长（秒）"],
  ["durationMs", "实际时长（毫秒）"],
  ["duration", "实际时长"],
  ["requestedRatio", "目标画面比例"],
  ["aspectRatio", "实际画面比例"],
  ["ratio", "画面比例"],
  ["fps", "帧率"],
  ["quality", "质量档位"],
] as const;

function publicMetadataValue(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const normalized = String(value);
    return containsInternalIdentifier(normalized) ? null : normalized;
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && !containsInternalIdentifier(normalized) ? normalized : null;
}

function creativeLibraryDetailRows(item: CreativeLibraryItem): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["创作描述", creativeLibraryDisplayTitle(item)],
    ["模型", "平台自动路由"],
    ["类型", libraryKindLabel(item)],
    ["状态", libraryStatusLabel(item.status)],
  ];
  for (const [field, label] of publicMetadataFields) {
    const value = publicMetadataValue(item.metadata?.[field]);
    if (value !== null) rows.push([label, value]);
  }
  return rows;
}

export function creativeLibraryReuseState(item: CreativeLibraryItem) {
  const mode = generationMode(item);
  if (!mode) return null;
  return {
    brief: item.prompt || "",
    libraryReuse: {
      assetType: mode,
      model: item.model || "",
      metadata: item.metadata || {},
      sourceTaskId: item.taskId || "",
    },
  };
}

export default function CreativeLibraryView() {
  const theme = useV4Theme();
  const navigate = useNavigate();
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const scopedProjectId = normalizeProjectId(currentProjectId);
  const [items, setItems] = useState<CreativeLibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [keyword, setKeyword] = useState("");
  const [selectedItem, setSelectedItem] = useState<CreativeLibraryItem | null>(null);
  const fetchRequestIdRef = useRef(0);

  const fetchItems = useCallback(async () => {
    const requestId = ++fetchRequestIdRef.current;
    setLoading(true);
    setError("");
    setItems([]);
    try {
      const result = await listCompleteCreativeLibrary({
        ...(scopedProjectId === null ? {} : { projectId: scopedProjectId }),
        type: filter === "all" ? undefined : filter,
        keyword,
      });
      if (requestId === fetchRequestIdRef.current) setItems(result);
    } catch (requestError) {
      if (requestId === fetchRequestIdRef.current) {
        setItems([]);
        setError(requestError instanceof Error ? requestError.message : "创意库加载失败");
      }
    } finally {
      if (requestId === fetchRequestIdRef.current) setLoading(false);
    }
  }, [filter, keyword, scopedProjectId]);

  useEffect(() => {
    void fetchItems();
    return () => {
      fetchRequestIdRef.current += 1;
    };
  }, [fetchItems]);

  function reuseItem(item: CreativeLibraryItem) {
    const state = creativeLibraryReuseState(item);
    const mode = generationMode(item);
    if (!state || !mode) return;
    navigate(`/workbench/generate?mode=${mode}`, { state });
  }

  function selectFilter(nextFilter: string) {
    if (nextFilter === filter) return;
    // The filter label and its rows are one UI contract. Invalidate the
    // previous request and hide its rows in the same render that activates the
    // next filter, rather than briefly advertising stale media as a new type.
    fetchRequestIdRef.current += 1;
    setLoading(true);
    setError("");
    setItems([]);
    setSelectedItem(null);
    setFilter(nextFilter);
  }

  const tabBtn = (key: string, label: string) => (
    <button
      key={key} onClick={() => selectFilter(key)}
      data-testid={`creative-library-filter-${key}`}
      data-active={filter === key ? "true" : "false"}
      aria-pressed={filter === key}
      style={{ padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13,
        background: filter === key ? "var(--front-accent)" : "transparent", color: filter === key ? "#fff" : "var(--front-muted)" }}
    >{label}</button>
  );
  const selectedTitle = selectedItem ? creativeLibraryDisplayTitle(selectedItem) : "";
  const selectedDetails = selectedItem ? creativeLibraryDetailRows(selectedItem) : [];

  return (
    <div
      className="frontPagePalette creativeLibraryPage" data-theme={theme.mode}
      data-testid="creative-library-page"
      data-active-filter={filter}
      data-content-state={loading ? "loading" : error ? "error" : items.length ? "ready" : "empty"}
      data-visible-count={items.length}

    >
      <div className="frontPageHeading">
        <h1 style={{ margin: 0, fontSize: 22, color: "var(--front-text)" }}>创意库</h1>
        <div className="creativeLibrarySearch">
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} aria-label="搜索素材" placeholder="搜索素材…" style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${"var(--front-line)"}`, fontSize: 13, width: 200, outline: "none" }} />
          <button onClick={fetchItems} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${"var(--front-line)"}`, background: "var(--front-surface)", cursor: "pointer", fontSize: 13 }}>搜索</button>
        </div>
      </div>
      <div className="creativeLibraryTabs">
        {tabBtn("all", "全部")}
        {tabBtn("image", "图片")}
        {tabBtn("video", "视频")}
        {tabBtn("audio", "音频")}
      </div>
      {loading ? (
        <div className="frontPageEmpty">加载中…</div>
      ) : error ? (
        <div role="alert" style={{ display: "grid", justifyItems: "center", gap: 12, textAlign: "center", color: "var(--front-danger)", padding: 48 }}>
          <strong>创意库加载失败</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void fetchItems()} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--front-danger-line)", background: "var(--front-surface)", color: "var(--front-danger)", cursor: "pointer" }}>重试</button>
        </div>
      ) : items.length === 0 ? (
        <div className="frontPageEmpty">暂无素材</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
          {items.map((item) => {
            const displayTitle = creativeLibraryDisplayTitle(item);
            const kindLabel = libraryKindLabel(item);
            return (
            <article
              key={item.id}
              data-testid="creative-library-card"
              data-asset-kind={kindLabel}
              data-generation-correlation-digest={item.correlation?.generationDigest}
              data-project-correlation-digest={item.correlation?.projectDigest || undefined}
              data-task-correlation-digest={item.correlation?.taskDigest}
              data-asset-correlation-digest={item.correlation?.assetDigest}
              data-content-sha256={item.contentSha256}
              style={{ borderRadius: 18, overflow: "hidden", border: `1px solid ${"var(--front-line)"}`, background: "var(--front-soft)" }}
            >
              <button
                type="button"
                aria-label={`查看 ${displayTitle} 详情`}
                onClick={() => setSelectedItem(item)}
                style={{ display: "block", width: "100%", padding: 0, border: 0, textAlign: "left", background: "transparent", cursor: "pointer" }}
              >
              <div style={{ aspectRatio: "16/10", background: "var(--front-soft)" }}>
                {item.url ? (
                  item.assetType === "video" ? (
                    <video src={item.url} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : item.assetType === "audio" ? (
                    <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", padding: 12, boxSizing: "border-box" }}>
                      <span style={{ color: "var(--front-muted)", fontSize: 12 }}>音频素材</span>
                    </div>
                  ) : item.assetType === "image" ? (
                    <img src={item.url} alt={displayTitle} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "var(--front-accent)", fontSize: 13, fontWeight: 700 }}>查看文件详情</span>
                  )
                ) : (
                  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--front-muted)", fontSize: 12 }}>无预览</div>
                )}
              </div>
              <div style={{ padding: "12px 14px" }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--front-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{displayTitle}</div>
                <div style={{ fontSize: 11, color: "var(--front-muted)" }}>{kindLabel} · 平台自动路由</div>
              </div>
              </button>
            </article>
            );
          })}
        </div>
      )}
      {selectedItem ? (
        <div
          role="presentation"
          onClick={() => setSelectedItem(null)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 20, background: "rgba(0,0,0,.5)" }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="创意库结果详情"
            data-generation-correlation-digest={selectedItem.correlation?.generationDigest}
            data-project-correlation-digest={selectedItem.correlation?.projectDigest || undefined}
            data-task-correlation-digest={selectedItem.correlation?.taskDigest}
            data-asset-correlation-digest={selectedItem.correlation?.assetDigest}
            data-content-sha256={selectedItem.contentSha256}
            onClick={(event) => event.stopPropagation()}
            style={{ width: 720, maxWidth: "100%", maxHeight: "86vh", overflow: "auto", borderRadius: 24, background: "var(--front-surface)", boxShadow: "0 24px 80px rgba(0,0,0,.25)" }}
          >
            <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--front-line)" }}>
              <strong style={{ color: "var(--front-text)" }}>生成结果详情</strong>
              <button type="button" aria-label="关闭创意库详情" onClick={() => setSelectedItem(null)} style={{ border: 0, background: "transparent", color: "var(--front-muted)", fontSize: 22, cursor: "pointer" }}>×</button>
            </header>
            <div style={{ display: "grid", gap: 16, padding: 20 }}>
              <div style={{ minHeight: 220, maxHeight: 420, display: "grid", placeItems: "center", overflow: "hidden", borderRadius: 10, background: "var(--front-soft)" }}>
                {selectedItem.url && selectedItem.assetType === "video" ? (
                  <video src={selectedItem.url} controls playsInline preload="metadata" style={{ width: "100%", maxHeight: 420 }} />
                ) : selectedItem.url && selectedItem.assetType === "audio" ? (
                  <audio src={selectedItem.url} controls preload="metadata" style={{ width: "calc(100% - 40px)" }} />
                ) : selectedItem.url && selectedItem.assetType === "image" ? (
                  <img src={selectedItem.url} alt={selectedTitle} style={{ width: "100%", maxHeight: 420, objectFit: "contain" }} />
                ) : selectedItem.url ? (
                  <a href={selectedItem.url} target="_blank" rel="noreferrer" style={{ color: "var(--front-accent)", fontWeight: 700 }}>打开原文件</a>
                ) : (
                  <span style={{ color: "var(--front-muted)" }}>该结果没有可公开预览的文件</span>
                )}
              </div>
              <dl style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 1, margin: 0, overflow: "hidden", border: "1px solid var(--front-line)", borderRadius: 8, background: "var(--front-line)" }}>
                {selectedDetails.map(([label, value]) => (
                  <React.Fragment key={String(label)}>
                    <dt style={{ padding: "8px 10px", background: "var(--front-soft)", color: "var(--front-muted)", fontSize: 12 }}>{label}</dt>
                    <dd style={{ margin: 0, padding: "8px 10px", background: "var(--front-surface)", color: "var(--front-text)", fontSize: 13, wordBreak: "break-word" }}>{value}</dd>
                  </React.Fragment>
                ))}
              </dl>
              {generationMode(selectedItem) ? (
                <button type="button" onClick={() => reuseItem(selectedItem)} style={{ padding: "10px 16px", border: 0, borderRadius: 8, background: "var(--front-accent)", color: "#fff", fontWeight: 700, cursor: "pointer" }}>
                  带入新创作
                </button>
              ) : (
                <div role="status" style={{ padding: "10px 12px", borderRadius: 8, background: "var(--front-soft)", color: "var(--front-muted)", fontSize: 13 }}>
                  该类型暂不支持带入创作，你可以预览或下载文件。
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
