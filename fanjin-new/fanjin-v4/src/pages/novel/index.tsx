import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpenText, FileSearch, Loader2, RefreshCw, Search, Upload } from "lucide-react";
import { listCompleteNovel, type NovelItem } from "../../api/novelApi";
import { useProjectStore } from "../../stores/projectStore";
import WritingWorkspaceFrame from "../writing/WritingWorkspaceFrame";
import ImportNovel from "./components/ImportNovel";
import EventAnalysis from "./components/EventAnalysis";
import EditNovel from "./components/EditNovel";

export { normalizeNovelListResponse } from "../../api/novelApi";

export default function NovelPage() {
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const projectId = currentProject?.id ?? currentProjectId;
  const [items, setItems] = useState<NovelItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Array<number | string>>([]);
  const [searchText, setSearchText] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showEventAnalysis, setShowEventAnalysis] = useState(false);
  const [editItem, setEditItem] = useState<NovelItem | null>(null);

  const fetchItems = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setLoadError("");
    try {
      const response = await listCompleteNovel({
        projectId: Number(projectId),
        search: searchText,
      });
      setItems(response);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "小说章节加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId, searchText]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    setSelectedIds([]);
  }, [projectId]);

  const totalWords = useMemo(() => items.reduce((sum, item) => sum + Number(item.wordCount || 0), 0), [items]);
  const analyzedCount = useMemo(() => items.filter((item) => item.status === "已分析").length, [items]);

  function toggleSelect(id: number | string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id]);
  }

  function toggleSelectAll() {
    setSelectedIds((current) => current.length === items.length ? [] : items.map((item) => item.id));
  }

  return (
    <WritingWorkspaceFrame
      active="novel"
      eyebrow="故事创作"
      title="小说工作台"
      description="管理章节、原文与事件分析"
      actionLabel="导入小说"
      actionTestId="novel-import-button"
      actionIcon={Upload}
      onAction={() => setShowImport(true)}
    >
      <section className="writingWorkspaceContent">
        <section className="writingWorkspaceOverview" aria-labelledby="novel-workspace-heading">
          <span className="writingWorkspaceOverviewIcon">
            <BookOpenText size={25} aria-hidden="true" />
          </span>
          <div className="writingWorkspaceOverviewCopy">
            <span>原文与章节</span>
            <h2 id="novel-workspace-heading">让长篇故事保持清晰的创作结构</h2>
            <p>集中管理小说原文、章节顺序与事件分析，完成后可继续进入剧本和分镜生产。</p>
          </div>
          <div className="writingWorkspaceMetrics" aria-label="小说数据概览">
            <div className="writingWorkspaceMetric"><strong>{items.length}</strong><span>章节</span></div>
            <div className="writingWorkspaceMetric"><strong>{totalWords.toLocaleString("zh-CN")}</strong><span>字数</span></div>
            <div className="writingWorkspaceMetric"><strong>{analyzedCount}</strong><span>已分析</span></div>
          </div>
        </section>

        <div className="writingWorkspaceToolbar">
          <div className="writingWorkspaceActionGroup">
            <button type="button" onClick={() => setShowEventAnalysis(true)} disabled={!selectedIds.length}>
              <FileSearch size={16} aria-hidden="true" />
              事件分析{selectedIds.length ? `（${selectedIds.length}）` : ""}
            </button>
          </div>
          <div className="writingWorkspaceSearchGroup">
            <label className="writingWorkspaceSearch">
              <Search size={16} aria-hidden="true" />
              <input
                data-testid="novel-search-input"
                aria-label="搜索小说"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="搜索章节名称"
              />
            </label>
            <button className="writingWorkspaceIconAction" type="button" aria-label="刷新小说列表" onClick={() => void fetchItems()}>
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="writingWorkspaceTableShell">
          <table className="writingWorkspaceTable" data-testid="novel-table">
            <thead>
              <tr>
                <th className="centerCell" style={{ width: 48 }}>
                  <input
                    type="checkbox"
                    aria-label="选择全部小说章节"
                    checked={selectedIds.length === items.length && items.length > 0}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>标题</th>
                <th>章节</th>
                <th className="numericCell">字数</th>
                <th className="centerCell">状态</th>
                <th className="centerCell">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6}><div className="writingWorkspaceState"><Loader2 className="jimengSpin" size={24} /><strong>正在载入小说章节</strong></div></td></tr>
              ) : loadError ? (
                <tr><td colSpan={6}><div className="writingWorkspaceState error"><RefreshCw size={24} /><strong>加载失败</strong><p>{loadError}</p><button type="button" onClick={() => void fetchItems()}>重试</button></div></td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={6}><div className="writingWorkspaceState"><BookOpenText size={28} /><strong>{searchText ? "没有匹配的章节" : "还没有小说章节"}</strong><p>{searchText ? "换一个关键词试试。" : "从右上角导入第一段原文，开始搭建故事。"}</p></div></td></tr>
              ) : items.map((item) => (
                <tr key={item.id} className={selectedIds.includes(item.id) ? "selected" : ""} data-testid="novel-row" data-novel-id={String(item.id)}>
                  <td className="centerCell">
                    <input
                      data-testid="novel-select-checkbox"
                      type="checkbox"
                      aria-label={`选择 ${item.title || "未命名章节"}`}
                      checked={selectedIds.includes(item.id)}
                      onChange={() => toggleSelect(item.id)}
                    />
                  </td>
                  <td className="titleCell">{item.title || "未命名"}</td>
                  <td>{item.chapter || "—"}</td>
                  <td className="numericCell">{Number(item.wordCount || 0).toLocaleString("zh-CN")}</td>
                  <td className="centerCell"><span className="writingWorkspaceStatus">{item.status || "正常"}</span></td>
                  <td className="centerCell">
                    <button className="writingWorkspaceTextButton" data-testid="novel-edit-button" type="button" onClick={() => setEditItem(item)}>编辑</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {showImport ? <ImportNovel open onClose={() => { setShowImport(false); void fetchItems(); }} projectId={projectId || undefined} /> : null}
      {showEventAnalysis ? (
        <EventAnalysis
          open
          onClose={() => {
            setShowEventAnalysis(false);
            void fetchItems();
          }}
          selectedIds={selectedIds}
          projectId={projectId || undefined}
        />
      ) : null}
      {editItem ? <EditNovel open item={editItem} onClose={() => { setEditItem(null); void fetchItems(); }} /> : null}
    </WritingWorkspaceFrame>
  );
}
