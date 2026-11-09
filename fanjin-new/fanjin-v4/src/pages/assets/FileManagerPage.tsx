import { useEffect, useRef, useState, type ReactNode } from "react";
import { Folder, FolderPlus, FileImage, Film, FileAudio, FileText, Loader2, RefreshCw, X, Search, Upload, MoreHorizontal, ChevronRight, LayoutGrid, UserRound, Mountain, Box, Activity, Volume2, Camera, Palette, Shapes, CircleSlash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useProjectStore } from "../../stores/projectStore";
import { canDeleteProjects, canWriteProjects } from "../../utils/permissions";
import { useAuthStore } from "../../stores/authStore";
import { useV4Theme } from "../../ui/useV4Theme";
import { creativeTaskStatusLabel } from "../../utils/creativeTaskStatus";
import { formatGuMicros } from "../../utils/billingUnits";
import { api } from "../../lib/api";
import { addAssetToProject, createAssetGroup, removeAssetFromProject, updateAssetMetadata, type AssetUsage } from "../../api/assets";
import * as fm from "../../api/fileManager";
import { listCreativeLibrary, type CreativeLibraryItem } from "../../api/creativeLibraryApi";
import { uploadReferenceAttachment, REFERENCE_ATTACHMENT_ACCEPT } from "../../features/quick-create/attachments/api";
import FrontstageNav from "../frontstage/FrontstageNav";
import { ASSET_USAGE_LABELS } from "../../features/assets/assetMetadata";
import { generationPreparationMessage, isPreparingGeneration } from "../../features/quick-create/generationPreparation";
import "./AssetListPage.css";
import "./FileManagerPage.css";

const keyOf = (f: fm.ManagedFile) => `${f.assetId}:${f.versionId}:${f.refId || ""}`;
const dateOf = (value: number) => value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleString("zh-CN") : "时间未知";
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";
const kindNames = { image: "图片", video: "视频", audio: "音频", document: "文档" };
const assetUsageOptions: Array<{ value: AssetUsage | "uncategorized"; label: string }> = [
  { value: "role", label: "角色 / 人物" }, { value: "scene", label: "场景" }, { value: "tool", label: "道具" },
  { value: "action", label: "动作参考" }, { value: "audio", label: "声音" }, { value: "camera", label: "运镜参考" },
  { value: "style", label: "风格参考" }, { value: "composition", label: "分镜" }, { value: "other", label: "其他" },
  { value: "uncategorized", label: "未分类" },
];
const usageTabIcons = { all: LayoutGrid, role: UserRound, scene: Mountain, tool: Box, action: Activity, audio: Volume2, camera: Camera, style: Palette, composition: Shapes, other: Shapes, uncategorized: CircleSlash2 } as const;
const usageTabOptions: Array<{ value: AssetUsage | "" | "uncategorized"; label: string }> = [
  { value: "", label: "全部素材" }, ...assetUsageOptions.map(option => option.value === "role" ? { ...option, label: "角色" } : option),
];
function usageOfFile(file: fm.ManagedFile): AssetUsage | null {
  if (file.assetUsageExplicit) return file.assetUsage ?? null;
  if (file.assetUsage) return file.assetUsage;
  return file.type === "role" || file.type === "scene" || file.type === "tool" || file.type === "audio" ? file.type : null;
}
const historyMediaMeta = (item: CreativeLibraryItem) => [
  item.width && item.height ? `${item.width} × ${item.height}` : "",
  item.durationMs ? `${item.durationMs / 1000} 秒` : "",
].filter(Boolean).join(" · ");
function historyBillingLabel(item: CreativeLibraryItem) {
  const billing = item.generationHistory?.billing;
  if (billing?.state === "captured" && billing.costMicros !== null) return `实际消耗 ${formatGuMicros(billing.costMicros)}`;
  if (billing?.state === "free") return "免费 · 0 GU";
  if (billing?.state === "released") return "未扣费 · 0 GU";
  if (isPreparingGeneration(item)) return "登记中，尚未提交生成";
  return billing ? "费用待确认" : "";
}
function KindIcon({ type }: { type: string }) {
  const Icon = ({ image: FileImage, video: Film, audio: FileAudio, document: FileText })[fm.fileKind(type)];
  return <Icon size={32} aria-hidden="true" />;
}

function Modal({ title, children, close, className = "" }: { title: string; children: ReactNode; close: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className={`fmDialog ${className}`} aria-label={title} onCancel={e => { e.preventDefault(); close(); }}>
    <header><h2>{title}</h2><button type="button" onClick={close} aria-label="关闭"><X size={20} /></button></header>{children}
  </dialog>;
}

export function FileThumbnail({ file, open }: { file: fm.ManagedFile; open: () => void }) {
  const scope = useAuthStore(s => `${s.user?.id}:${s.currentWorkspace?.id}`);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState(""), [error, setError] = useState(false);
  const image = fm.fileKind(file.type) === "image";
  useEffect(() => {
    if (!image) return;
    if (!globalThis.IntersectionObserver) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "150px" });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [image]);
  useEffect(() => {
    if (!visible || !image) return;
    const controller = new AbortController(); let ownedUrl = "";
    setUrl(""); setError(false);
    void fm.filePreviewUrl(file, controller.signal).then(value => {
      ownedUrl = value;
      if (controller.signal.aborted) fm.releasePreviewUrl(value); else setUrl(value);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); fm.releasePreviewUrl(ownedUrl); };
  }, [file.assetId, file.versionId, visible, image, attempt, scope]);
  return <div ref={ref} className="fmThumb">
    <button type="button" aria-label={`预览 ${file.name}`} onClick={open}>
      {url && !error ? <img src={url} alt={file.name} loading="lazy" onError={() => setError(true)} />
        : <><KindIcon type={file.type} /><span>{error ? "预览加载失败" : image && visible ? "正在加载预览…" : kindNames[fm.fileKind(file.type)]}</span></>}
    </button>
    {error ? <button className="fmRetryThumb" type="button" onClick={() => setAttempt(n => n + 1)} aria-label={`重试预览 ${file.name}`}><RefreshCw size={14} />重试</button> : null}
  </div>;
}

type Action = "newProject" | "newFolder" | "renameFolder" | "moveFolder" | "deleteFolder" | "rename" | "tags" | "classify" | "place" | "addProject" | "removeProject" | "trash" | "restore";
type Edit = { action: Action; files: fm.ManagedFile[]; projectId: number | null; folder?: fm.FileFolder };
type ImportRow = { item: CreativeLibraryItem; status: "pending" | "running" | "imported" | "existing" | "failed"; message?: string };
const importable = (item: CreativeLibraryItem) => item.status === "succeeded" && ["image", "video", "audio"].includes(item.assetType);
const importLabels: Record<ImportRow["status"], string> = { pending: "等待导入", running: "正在导入…", imported: "导入成功", existing: "项目中已存在", failed: "导入失败" };
const actionTitles: Record<Action, string> = { newProject: "新建项目", newFolder: "新建文件夹", renameFolder: "重命名文件夹", moveFolder: "移动文件夹", deleteFolder: "删除空文件夹",
  rename: "重命名文件", tags: "编辑标签", classify: "设置资产分类", place: "移动到文件夹", addProject: "加入项目", removeProject: "从项目移除", trash: "移入回收站", restore: "恢复文件" };

export default function FileManagerPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "history" ? "history" : "files";
  const correlation = /^[a-f0-9]{64}$/.test(params.get("correlation") || "") ? params.get("correlation")! : undefined;
  const legacyUploads = params.get("tab") === "cloud";
  const theme = useV4Theme(), project = useProjectStore();
  const scope = useAuthStore(s => `${s.user?.id}:${s.currentWorkspace?.id}`);
  const user = useAuthStore(s => s.user);
  const workspace = useAuthStore(s => s.currentWorkspace);
  const canDelete = canDeleteProjects({ user, workspace });
  const canWrite = canWriteProjects({ user, workspace });
  const actionAllowed = (action: Action) => ["trash", "deleteFolder"].includes(action) ? canDelete : canWrite;
  const projectId = project.currentProjectId;
  const [files, setFiles] = useState<fm.ManagedFile[]>([]), [folders, setFolders] = useState<fm.FileFolder[]>([]);
  const [history, setHistory] = useState<CreativeLibraryItem[]>([]);
  const [historyDetail, setHistoryDetail] = useState<CreativeLibraryItem | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const [folderId, setFolderId] = useState<string | null | undefined>(undefined);
  const [trash, setTrash] = useState(false), [hidden, setHidden] = useState(false);
  const [source, setSource] = useState(legacyUploads ? "uploaded" : ""), [type, setType] = useState(""), [usageFilter, setUsageFilter] = useState<AssetUsage | "uncategorized" | "">("");
  const [query, setQuery] = useState(""), [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1), [total, setTotal] = useState(0), [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedHistory, setSelectedHistory] = useState<string[]>([]);
  const [imports, setImports] = useState<ImportRow[] | null>(null), [importTarget, setImportTarget] = useState("");
  const [importing, setImporting] = useState(false);
  const importController = useRef<AbortController | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null), [draft, setDraft] = useState("");
  const [target, setTarget] = useState(""), [busy, setBusy] = useState(false), [editError, setEditError] = useState("");
  const [groupName, setGroupName] = useState(""), [groupError, setGroupError] = useState(""), [groupSaving, setGroupSaving] = useState(false), [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [preview, setPreview] = useState<{ name: string; type: string; url: string } | null>(null), [previewError, setPreviewError] = useState("");
  const [uploading, setUploading] = useState(false), [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFiles, setUploadFiles] = useState<File[] | null>(null), [uploadUsage, setUploadUsage] = useState<AssetUsage | "uncategorized">("uncategorized");
  const uploadRef = useRef<HTMLInputElement>(null), previewController = useRef<AbortController | null>(null);
  const createdProjectId = useRef<number | null>(null);
  const contextRef = useRef(""); contextRef.current = `${scope}:${projectId}`;
  const pageSize = 36;
  useEffect(() => { void project.fetchProjects(); }, [scope]);
  useEffect(() => { const timer = setTimeout(() => setKeyword(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setPage(1); setSelected([]); setSelectedHistory([]); }, [projectId, folderId, trash, source, type, usageFilter, keyword, tab, hidden, scope, correlation]);
  useEffect(() => { setHistoryDetail(null); setCopyNotice(""); }, [projectId, tab, scope]);
  useEffect(() => {
    setFolderId(undefined); setEdit(null); setSelected([]); closePreview();
    // 切换上下文时丢弃待确认操作；进行中的请求仍由 finally 释放提交状态。
    setUploadFiles(null); setUploadUsage("uncategorized");
    setGroupDialogOpen(false); setGroupName(""); setGroupError("");
  }, [projectId, scope]);
  useEffect(() => {
    setImports(null); setImporting(false);
    return () => { importController.current?.abort(); importController.current = null; };
  }, [projectId, scope]);
  useEffect(() => { setSource(legacyUploads ? "uploaded" : ""); }, [legacyUploads]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000); return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const controller = new AbortController();
    setFolders([]);
    if (projectId) void fm.listFileFolders(projectId, controller.signal).then(result => { if (!controller.signal.aborted) setFolders(result); }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [projectId, scope, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setFiles([]); setHistory([]); setSelected([]); setSelectedHistory([]);
    const timeout = setTimeout(() => {
      controller.abort();
      setError("列表加载超时，请重试");
      setLoading(false);
    }, 15_000);
    const work = tab === "files"
      ? fm.listManagedFiles({ ...(projectId && !trash ? { projectId, folderId } : {}), trash,
        ...(source ? { source: source as "uploaded" | "generated" } : {}), ...(type ? { type } : {}), ...(usageFilter ? { usage: usageFilter } : {}), keyword, page, limit: pageSize }, controller.signal)
        .then(result => { if (!controller.signal.aborted) { setFiles(result.items); setTotal(result.total); } })
      : listCreativeLibrary({ ...(projectId ? { projectId } : {}), page, limit: pageSize, keyword, ...(type ? { type } : {}), hidden, correlation }, controller.signal)
        .then(result => { if (!controller.signal.aborted) { setHistory(result.data); setTotal(result.total); } });
    void work.catch(e => { if (!controller.signal.aborted) setError(errorText(e)); })
      .finally(() => { clearTimeout(timeout); if (!controller.signal.aborted) setLoading(false); });
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [projectId, folderId, scope, trash, source, type, usageFilter, keyword, page, tab, hidden, revision, correlation]);
  useEffect(() => () => { previewController.current?.abort(); }, []);
  useEffect(() => () => { if (preview) fm.releasePreviewUrl(preview.url); }, [preview]);

  function closePreview() { previewController.current?.abort(); setPreview(null); setPreviewError(""); }
  async function copyPrompt(item: CreativeLibraryItem, inDetail = false) {
    const notify = inDetail ? setCopyNotice : setNotice;
    try { await navigator.clipboard.writeText(item.prompt || ""); notify("提示词已复制"); }
    catch { notify("复制失败，请在详情中手动复制"); }
  }
  async function openFile(file: fm.ManagedFile) {
    closePreview(); const controller = new AbortController(); previewController.current = controller;
    setPreview({ name: file.name, type: file.type, url: "" });
    try {
      const url = await fm.filePreviewUrl(file, controller.signal);
      if (controller.signal.aborted) fm.releasePreviewUrl(url); else setPreview({ name: file.name, type: file.type, url });
    } catch (e) { if (!controller.signal.aborted) setPreviewError(errorText(e)); }
  }
  const canClassify = (chosen: fm.ManagedFile[]) => Boolean(canWrite && projectId && chosen.length && chosen.every(file => file.permissions.manage));
  function begin(action: Action, chosen = files.filter(f => selected.includes(keyOf(f))), folder?: fm.FileFolder) {
    if (busy || !actionAllowed(action) || (action === "classify" && !canClassify(chosen))) return;
    createdProjectId.current = null;
    setEdit({ action, files: chosen, projectId, folder }); setEditError("");
    setDraft(action === "tags" ? chosen[0]?.tags.join("，") || "" : action === "classify" ? usageOfFile(chosen[0]) || "" : action === "rename" ? chosen[0]?.name || "" : action === "renameFolder" ? folder?.name || "" : "");
    setTarget(action === "place" ? folderId || "" : action === "moveFolder" ? folder?.parentId || "" : String(projectId || ""));
  }
  async function submitEdit() {
    if (!edit || busy || !actionAllowed(edit.action) || (edit.action === "classify" && !canClassify(edit.files))) return;
    const startContext = contextRef.current; setBusy(true); setEditError("");
    try {
      if (edit.action === "newProject") {
        if (!createdProjectId.current) createdProjectId.current = Number((await api.createProject(draft.trim())).projectId);
        if (startContext === contextRef.current) await project.refreshAndSelectProject(createdProjectId.current!, { shouldCommit: () => startContext === contextRef.current });
      } else if (["newFolder", "renameFolder", "moveFolder", "deleteFolder"].includes(edit.action)) {
        if (!edit.projectId) throw new Error("请先选择项目");
        await fm.writeFileFolder({ projectId: edit.projectId, ...(edit.folder ? { id: edit.folder.id, expectedRevision: Number(edit.folder.revision) } : { parentId: folderId || null }),
          ...(edit.action === "deleteFolder" ? { remove: true } : edit.action === "moveFolder" ? { parentId: target || null } : { name: draft.trim() }) });
      } else {
        const failures: string[] = [];
        const failedFiles: fm.ManagedFile[] = [];
        for (const file of edit.files) {
          if (startContext !== contextRef.current) break;
          try {
            if (edit.action === "addProject") {
              if (!target) throw new Error("请选择目标项目");
              await addAssetToProject({ projectId: Number(target), assetId: file.assetId, assetVersionId: file.versionId ? `image:${file.versionId}` : `asset:${file.assetId}` });
            } else if (edit.action === "removeProject") {
              if (!edit.projectId || !file.refId) throw new Error("请在具体项目内操作");
              await removeAssetFromProject({ projectId: edit.projectId, refId: file.refId, expectedRevision: file.refRevision });
            } else if (edit.action === "place") {
              if (!edit.projectId || !file.refId) throw new Error("请在具体项目内操作");
              await fm.placeProjectFile({ projectId: edit.projectId, refId: file.refId, folderId: target || null, expectedRevision: file.refRevision });
            } else if (edit.action === "classify") {
              await updateAssetMetadata({ projectId: edit.projectId!, id: file.assetId, usage: (draft || null) as AssetUsage | null });
            } else await fm.updateFile({ assetId: file.assetId, expectedRevision: file.fileRevision,
              ...(edit.action === "rename" ? { name: draft.trim() } : edit.action === "tags" ? { tags: draft.split(/[,，]/).map(s => s.trim()).filter(Boolean) } : { action: edit.action as "trash" | "restore" }) });
          } catch (e) { failedFiles.push(file); failures.push(`${file.name}：${errorText(e)}`); }
        }
        if (failures.length) { setEdit({ ...edit, files: failedFiles }); refresh(n => n + 1); throw new Error(failures.join("\n")); }
      }
      if (startContext === contextRef.current || edit.action === "newProject") { setEdit(null); refresh(n => n + 1); setNotice(`${actionTitles[edit.action]}成功`); }
    } catch (e) { if (startContext === contextRef.current) setEditError(errorText(e)); }
    finally { setBusy(false); }
  }

  function beginGroup() {
    if (!canGroup || groupSaving) return;
    setGroupError(""); setGroupName(""); setGroupDialogOpen(true);
  }
  async function submitGroup() {
    if (!canGroup || groupSaving) return;
    const name = groupName.trim();
    if (!name) { setGroupError("请填写分组名称"); return; }
    const startContext = contextRef.current;
    const usage = groupUsage!;
    setGroupSaving(true); setGroupError("");
    try {
      await createAssetGroup({ projectId: projectId!, name, usage, assetIds: checked.map(file => file.assetId) });
      // 旧项目请求允许完成，但不能清理新上下文的选择、弹窗或提示。
      if (startContext !== contextRef.current) return;
      setGroupName(""); setGroupError(""); setSelected([]); setGroupDialogOpen(false); refresh(n => n + 1); setNotice(`已创建${ASSET_USAGE_LABELS[usage]}分组“${name}”`);
    } catch (e) { if (startContext === contextRef.current) setGroupError(errorText(e)); }
    finally { setGroupSaving(false); }
  }
  function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files || []); event.target.value = "";
    if (!canWrite || !projectId || !chosen.length || uploading) return;
    setUploadUsage("uncategorized"); setUploadFiles(chosen);
  }
  async function submitUpload() {
    const chosen = uploadFiles;
    if (!canWrite || !projectId || !chosen?.length || uploading) return;
    const startContext = contextRef.current; setUploading(true); setUploadProgress(0);
    const failures: string[] = [];
    try {
      for (let i = 0; i < chosen.length; i++) {
        if (startContext !== contextRef.current) break;
        try {
          const uploaded = await uploadReferenceAttachment(projectId, chosen[i], { onProgress: value => { if (startContext === contextRef.current) setUploadProgress(Math.round((i * 100 + value) / chosen.length)); } });
          if (!Number.isSafeInteger(uploaded.assetId) || uploaded.assetId <= 0) throw new Error("上传成功但未返回资产编号");
          await updateAssetMetadata({ projectId, id: uploaded.assetId, usage: uploadUsage === "uncategorized" ? null : uploadUsage });
        }
        catch (e) { failures.push(`${chosen[i].name}：${errorText(e)}`); }
      }
      if (startContext === contextRef.current) { setNotice(failures.length ? failures.join("\n") : `上传完成，已归入${uploadUsage === "uncategorized" ? "未分类" : ASSET_USAGE_LABELS[uploadUsage]}`); setUploadFiles(null); refresh(n => n + 1); }
    } finally { setUploading(false); }
  }
  async function hideHistory(item: CreativeLibraryItem) {
    if (hidden ? !canWrite : !canDelete) return;
    try { await fm.setHistoryHidden([item.id], !hidden); refresh(n => n + 1); setNotice(hidden ? "记录已恢复" : "记录已隐藏，作品和账单仍然保留"); }
    catch (e) { setNotice(errorText(e)); }
  }
  function beginImport(items: CreativeLibraryItem[]) {
    if (!canWrite || importController.current) return;
    const chosen = items.filter(importable);
    if (!chosen.length) return;
    setImports(chosen.map(item => ({ item, status: "pending" })));
    const defaultProject = projectId || (chosen.every(item => item.projectId === chosen[0].projectId) ? chosen[0].projectId : null);
    setImportTarget(project.projects.some(p => Number(p.id) === defaultProject) ? String(defaultProject) : "");
  }
  async function submitImport() {
    if (!canWrite || !imports || !importTarget || importController.current) return;
    const controller = new AbortController(); importController.current = controller;
    const startContext = contextRef.current, targetProjectId = Number(importTarget);
    setImporting(true);
    const update = (id: string, status: ImportRow["status"], message?: string) => {
      if (!controller.signal.aborted && startContext === contextRef.current) setImports(rows => rows?.map(row => row.item.id === id ? { ...row, status, message } : row) || null);
    };
    try {
      for (const row of imports.filter(row => row.status === "pending" || row.status === "failed")) {
        if (controller.signal.aborted || startContext !== contextRef.current) break;
        update(row.item.id, "running");
        try { const result = await fm.importHistoryAsset(row.item.id, targetProjectId, controller.signal); update(row.item.id, result.outcome); }
        catch (e) { update(row.item.id, "failed", errorText(e)); }
      }
      if (!controller.signal.aborted && startContext === contextRef.current) refresh(n => n + 1);
    } finally {
      if (importController.current === controller) { importController.current = null; setImporting(false); }
    }
  }
  function folderPath(folder: fm.FileFolder): string {
    const names = [folder.name], seen = new Set([folder.id]); let parent = folder.parentId;
    while (parent && !seen.has(parent)) { seen.add(parent); const row = folders.find(f => f.id === parent); if (!row) break; names.unshift(row.name); parent = row.parentId; }
    return names.join(" / ");
  }
  function exportPage() {
    const data = tab === "files" ? files.map(f => ({ name: f.name, type: f.type, tags: f.tags, source: f.source, createdAt: f.createdAt,
      folder: folders.find(x => x.id === f.folderId)?.name || "" }))
      : history.map(h => ({ prompt: h.prompt, model: h.model, status: h.status, createdAt: h.createdAt, width: h.width, height: h.height, durationMs: h.durationMs, billing: h.generationHistory?.billing }));
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `繁境-${tab === "files" ? "文件清单" : "生成记录"}-第${page}页.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const displayedFiles = usageFilter === ""
    ? files
    : files.filter(file => usageFilter === "uncategorized" ? !usageOfFile(file) : usageOfFile(file) === usageFilter);
  const checked = displayedFiles.filter(f => selected.includes(keyOf(f)));
  const groupableChecked = checked.filter(file => ["role", "scene", "tool"].includes(usageOfFile(file) || ""));
  const groupSelectionComplete = checked.length > 0 && groupableChecked.length === checked.length;
  const groupUsage = groupSelectionComplete && groupableChecked.length && groupableChecked.every(file => usageOfFile(file) === usageOfFile(groupableChecked[0]))
    ? usageOfFile(groupableChecked[0]) as "role" | "scene" | "tool"
    : null;
  const canGroup = Boolean(canWrite && projectId && checked.length >= 2 && groupUsage && checked.every(file => file.permissions.manage));
  const eligibleHistory = history.filter(importable);
  const checkedHistory = eligibleHistory.filter(item => selectedHistory.includes(item.id));
  const importDone = imports?.filter(row => ["imported", "existing", "failed"].includes(row.status)).length || 0;
  const importSucceeded = imports?.filter(row => row.status === "imported").length || 0;
  const importExisting = imports?.filter(row => row.status === "existing").length || 0;
  const importFailed = imports?.filter(row => row.status === "failed").length || 0;
  const currentFolder = folders.find(f => f.id === folderId);
  const shownFolders = folders.filter(f => f.parentId === (folderId || null));
  const textEdit = edit && ["newProject", "newFolder", "renameFolder", "rename", "tags"].includes(edit.action);
  return <main data-testid="asset-library-page" data-tab={tab === "history" ? "history" : "assets"} data-correlation-filter={correlation} className={`assetFrontPage fmPage ${theme.mode === "dark" ? "themeDark" : "themeLight"}`}>
    <section className="assetFrontShell">
      <FrontstageNav active="assets" dark={theme.mode === "dark"} onToggleDark={theme.toggle} onNotice={setNotice} />
      <div className="assetFrontMain">
        <header className="assetFrontTabs"><div>
          <button className={tab === "files" ? "active" : ""} onClick={() => setParams({ tab: "assets" })}>文件管理</button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setParams({ tab: "history" })}>生成记录</button>
        </div><span>管理上传文件与生成作品</span></header>
        {tab === "files" ? <nav className="fmUsageTabs" aria-label="资产用途分类">
          {usageTabOptions.map(option => {
            const Icon = usageTabIcons[option.value || "all"];
            return <button key={option.value || "all"} type="button" className={usageFilter === option.value ? "active" : ""}
              aria-pressed={usageFilter === option.value} onClick={() => setUsageFilter(option.value)}><Icon size={15} aria-hidden="true" />{option.label}</button>;
          })}
        </nav> : null}
        <div className="fmToolbar">
          <label>项目<select aria-label="选择项目" value={projectId || ""} onChange={e => e.target.value ? project.selectProject(e.target.value) : project.clearProject()} disabled={busy || uploading || importing}>
            <option value="">全部可见文件</option>{project.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
          <button disabled={!canWrite} onClick={() => begin("newProject")}><FolderPlus size={16} />新建项目</button>
          {tab === "files" && !trash ? <><button disabled={!canWrite || !projectId} onClick={() => begin("newFolder")}><FolderPlus size={16} />新建文件夹</button>
            <button className="fmPrimary" disabled={!canWrite || uploading || !projectId} onClick={() => uploadRef.current?.click()}><Upload size={16} />{uploading ? `上传中 ${uploadProgress}%` : "上传文件"}</button>
            <input ref={uploadRef} hidden multiple type="file" accept={REFERENCE_ATTACHMENT_ACCEPT} aria-label="选择上传文件" onChange={upload} /></> : null}
        </div>
        {project.error ? <p className="fmError" role="alert">项目加载失败：{project.error.message}<button onClick={() => void project.fetchProjects()}>重新加载</button></p> : null}
        {!projectId && tab === "files" && !trash ? <p className="fmHint">正在浏览全部有权访问的文件。选择或新建项目后，可上传文件、新建文件夹和整理素材。</p> : null}
        <div className="fmFilters">
          <label className="fmSearch"><Search size={16} /><input aria-label="搜索文件或生成记录" value={query} onChange={e => setQuery(e.target.value)} placeholder={tab === "files" ? "搜索文件名或标签" : "搜索生成内容"} /></label>
          <select aria-label="文件类型" value={type} onChange={e => setType(e.target.value)}><option value="">全部类型</option>{Object.entries(kindNames).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>
          {tab === "files" ? <><select aria-label="文件来源" value={source} onChange={e => setSource(e.target.value)}><option value="">全部来源</option><option value="uploaded">上传文件</option><option value="generated">AI 生成</option></select>
            <button aria-pressed={trash} onClick={() => { setTrash(!trash); setFolderId(undefined); }}>{trash ? "返回文件" : "回收站"}</button></>
            : <button aria-pressed={hidden} onClick={() => setHidden(!hidden)}>{hidden ? "返回生成记录" : "已隐藏记录"}</button>}
          <button disabled={loading || !(tab === "files" ? files.length : history.length)} onClick={exportPage}>导出本页</button>
          <button onClick={() => refresh(n => n + 1)} aria-label="刷新列表"><RefreshCw size={16} /></button>
        </div>
        {correlation && tab === "history" ? <p className="fmHint">正在查看本次生成的结果。<button onClick={() => setParams({ tab: "history" })}>查看全部生成记录</button></p> : null}
        {tab === "history" ? <p className="fmHint">选择已完成的作品，可一键导入资产并加入指定项目。已有文件会复用，重复导入不会重复保存或扣费。隐藏记录不会删除作品或账单。</p> : null}
        {trash && tab === "files" ? <p className="fmHint">回收站内文件仍占用云空间，可恢复。正在被项目使用的文件需先从项目移除。</p> : null}
        {projectId && !trash && tab === "files" ? <div className="fmFolders">
          <nav aria-label="文件夹路径"><button onClick={() => setFolderId(undefined)}>项目全部文件</button><span>/</span><button onClick={() => setFolderId(null)}>根目录</button>
            {currentFolder ? <><span>/</span><button onClick={() => setFolderId(currentFolder.parentId)}>上一级</button><span>/ {currentFolder.name}</span></> : null}</nav>
          {shownFolders.map(folder => <div className="fmFolder" key={folder.id}><button onClick={() => setFolderId(folder.id)}><Folder size={20} />{folder.name}</button>
            <details><summary aria-label={`管理文件夹 ${folder.name}`}><MoreHorizontal size={16} /></summary><button disabled={!canWrite} onClick={() => begin("renameFolder", [], folder)}>改名</button><button disabled={!canWrite} onClick={() => begin("moveFolder", [], folder)}>移动</button><button disabled={!canDelete} onClick={() => begin("deleteFolder", [], folder)}>删除空文件夹</button></details></div>)}
        </div> : null}
        {tab === "files" && displayedFiles.length > 0 ? <label className="fmSelectAll"><input type="checkbox" checked={checked.length === displayedFiles.length} onChange={e => setSelected(e.target.checked ? displayedFiles.map(keyOf) : [])} />选择本页全部文件</label> : null}
        {tab === "history" && eligibleHistory.length > 0 ? <div className="fmHistorySelection">
          <label className="fmSelectAll"><input type="checkbox" checked={checkedHistory.length === eligibleHistory.length} onChange={e => setSelectedHistory(e.target.checked ? eligibleHistory.map(item => item.id) : [])} />选择本页已完成作品</label>
          <button className="fmPrimary" disabled={!canWrite || !checkedHistory.length || importing} onClick={() => beginImport(checkedHistory)}>导入所选资产{checkedHistory.length ? `（${checkedHistory.length}）` : ""}</button>
          {checkedHistory.length ? <button onClick={() => setSelectedHistory([])}>取消选择</button> : null}
        </div> : null}
        {checked.length ? <div className="fmBatch" role="region" aria-label="批量操作"><strong>已选 {checked.length} 项</strong>
          <button disabled={busy} onClick={() => { setBusy(true); void (async () => { const failures: string[] = []; for (const file of checked) { try { await fm.downloadManagedFile(file); } catch (e) { failures.push(`${file.name}：${errorText(e)}`); } } setNotice(failures.length ? failures.join("\n") : "已提交文件下载"); })().finally(() => setBusy(false)); }}>下载</button>
          {trash ? <button disabled={!canWrite || !checked.every(f => f.permissions.manage)} onClick={() => begin("restore")}>恢复</button> : <>
            <button disabled={!canWrite || !checked.every(f => f.permissions.use)} onClick={() => begin("addProject")}>加入项目</button>
            {projectId ? <><button disabled={!canWrite} onClick={() => begin("place")}>移动到文件夹</button><button disabled={!canWrite} onClick={() => begin("removeProject")}>从项目移除</button></> : null}
            {projectId && groupableChecked.length >= 2 ? <button disabled={!canGroup || groupSaving} onClick={beginGroup}>创建分组</button> : null}
            <button disabled={!canDelete || !checked.every(f => f.permissions.manage)} onClick={() => begin("trash")}>移入回收站</button></>}
          <button onClick={() => setSelected([])}>取消选择</button></div> : null}
        {notice ? <p className="fmNotice" role="status">{notice}</p> : null}
        {loading ? <p className="fmEmpty" role="status"><Loader2 className="jimengSpin" />正在加载…</p> : error ? <div className="fmEmpty fmError" role="alert"><p>{error}</p><button onClick={() => refresh(n => n + 1)}>重新加载</button></div> : <>
          <div className={`fmGrid${tab === "history" ? " fmHistoryGrid" : ""}`}>
            {tab === "files" ? displayedFiles.map(file => <article className="fmCard" key={keyOf(file)}>
              <FileThumbnail file={file} open={() => void openFile(file)} />
              <div className="fmFileTitle"><input type="checkbox" aria-label={`选择 ${file.name}`} checked={selected.includes(keyOf(file))} onChange={e => setSelected(ids => e.target.checked ? [...ids, keyOf(file)] : ids.filter(id => id !== keyOf(file)))} /><strong title={file.name}>{file.name}</strong></div>
              <p>{file.source === "uploaded" ? "上传文件" : "AI 生成"} · {kindNames[fm.fileKind(file.type)]}</p><p>{dateOf(file.createdAt)}</p>
              <div className="fmAssetBadges"><span className={`fmAssetUsageBadge ${usageOfFile(file) ? "" : "unset"}`}>{usageOfFile(file) ? ASSET_USAGE_LABELS[usageOfFile(file)!] : "未分类"}</span>{file.assetGroup ? <span className="fmAssetGroupBadge">分组 · {file.assetGroup.name}</span> : null}</div>
              {file.tags.length ? <p className="fmTags">{file.tags.join(" · ")}</p> : null}
              <div className="fmCardActions"><button onClick={() => void openFile(file)}>预览</button>
                <button onClick={() => void fm.downloadManagedFile(file).catch(e => setNotice(errorText(e)))}>下载</button>
                <details><summary aria-label={`更多操作 ${file.name}`}><MoreHorizontal size={18} /></summary>
                  {trash ? <button disabled={!canWrite || !file.permissions.manage} onClick={() => begin("restore", [file])}>恢复</button> : <>
                    <button disabled={!canWrite || !file.permissions.manage} onClick={() => begin("rename", [file])}>改名</button><button disabled={!canWrite || !file.permissions.manage} onClick={() => begin("tags", [file])}>标签</button><button disabled={!canClassify([file])} onClick={() => begin("classify", [file])}>分类</button>
                    <button disabled={!canWrite || !file.permissions.use} onClick={() => begin("addProject", [file])}>加入项目</button>
                    {projectId ? <><button disabled={!canWrite} onClick={() => begin("place", [file])}>移动到文件夹</button><button disabled={!canWrite} onClick={() => begin("removeProject", [file])}>从项目移除</button></> : null}
                    <button disabled={!canDelete || !file.permissions.manage} onClick={() => begin("trash", [file])}>移入回收站</button></>}
                </details></div>
            </article>) : history.map(item => <article className="fmCard fmHistoryCard" key={item.id} data-testid="asset-library-card"
              data-generation-correlation-digest={item.correlation?.generationDigest} data-project-correlation-digest={item.correlation?.projectDigest || undefined}
              data-task-correlation-digest={item.correlation?.taskDigest} data-asset-correlation-digest={item.correlation?.assetDigest}>
              <button className="fmHistoryThumb" aria-label={`预览${kindNames[fm.fileKind(item.assetType)]}作品`} disabled={!item.url}
                onClick={() => { closePreview(); setPreview({ name: "生成结果", type: item.assetType, url: item.url }); }}>
                {item.assetType === "image" && item.url ? (
                  <img src={item.url} alt="生成结果" loading="lazy" />
                ) : item.assetType === "video" && item.url ? (
                  <video
                    src={item.url}
                    muted
                    playsInline
                    preload="metadata"
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                ) : (
                  <><KindIcon type={item.assetType} /><span>{kindNames[fm.fileKind(item.assetType)]}</span></>
                )}
              </button>
              <div className="fmHistoryPrompt"><label className="fmHistoryCheckbox"><input type="checkbox" aria-label={`选择生成作品 ${item.prompt || item.id}`} disabled={!importable(item)} checked={selectedHistory.includes(item.id)}
                onChange={e => setSelectedHistory(ids => e.target.checked ? [...new Set([...ids, item.id])] : ids.filter(id => id !== item.id))} />
                </label><p className="fmHistoryExcerpt">{item.prompt || "生成结果"}</p></div>
              <div className="fmHistorySummary"><span className="fmHistoryStatus" data-status={item.status}>{generationPreparationMessage(item) || creativeTaskStatusLabel(item.status)}</span>
                <button type="button" onClick={() => { setCopyNotice(""); setHistoryDetail(item); }}>查看详情<ChevronRight size={14} aria-hidden="true" /></button></div>
              <div className="fmHistoryMetadata">
                <span className="fmHistoryModel" title={item.model}>{item.model || "模型未记录"}</span>
                <span>{dateOf(item.createdAt)}</span>
                <span>{historyMediaMeta(item) || kindNames[fm.fileKind(item.assetType)]}</span>
                {item.generationHistory ? <span>{historyBillingLabel(item)}</span> : null}
              </div>
              <div className="fmCardActions"><button disabled={!canWrite || !importable(item) || importing} onClick={() => beginImport([item])}>导入资产</button>
                <button onClick={() => void copyPrompt(item)}>复制提示词</button>
                <button disabled={hidden ? !canWrite : !canDelete} onClick={() => void hideHistory(item)}>{hidden ? "恢复记录" : "隐藏记录"}</button></div>
            </article>)}
          </div>
          {!(tab === "files" ? files.length : history.length) ? <div className="fmEmpty"><Folder size={36} /><p>{trash ? "回收站为空" : hidden ? "没有已隐藏的记录" : keyword ? "没有找到匹配内容" : tab === "files" ? "这里还没有文件" : "还没有生成记录"}</p>
            {tab === "files" && !projectId && !trash ? <button disabled={!canWrite} onClick={() => begin("newProject")}>新建项目并上传</button> : null}</div> : null}
          <footer className="fmPagination"><span>共 {total} 项</span><button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil(total / pageSize))}</span><button disabled={page * pageSize >= total} onClick={() => setPage(p => p + 1)}>下一页</button></footer>
        </>}
      </div>
    </section>
    {historyDetail ? <Modal title="生成详情" className="fmHistoryDetailDialog" close={() => setHistoryDetail(null)}>
      <div className="fmHistoryDetailBody">
        <dl className="fmHistoryDetailMeta">
          <div><dt>模型</dt><dd>{historyDetail.model || "模型未记录"}</dd></div>
          <div><dt>生成时间</dt><dd>{dateOf(historyDetail.createdAt)}</dd></div>
          <div><dt>状态</dt><dd>{generationPreparationMessage(historyDetail) || creativeTaskStatusLabel(historyDetail.status)}</dd></div>
          {historyMediaMeta(historyDetail) ? <div><dt>作品规格</dt><dd>{historyMediaMeta(historyDetail)}</dd></div> : null}
          {historyDetail.generationHistory ? <div><dt>消耗</dt><dd>{historyBillingLabel(historyDetail)}</dd></div> : null}
        </dl>
        {historyDetail.errorMessage ? <p className="fmError">{historyDetail.errorMessage}</p> : null}
        <h3 className="fmHistoryDetailHeading">完整提示词</h3>
        <p className="fmHistoryFullPrompt">{historyDetail.prompt || "未记录提示词"}</p>
      </div>
      {copyNotice ? <p className="fmHistoryCopyNotice" role="status">{copyNotice}</p> : null}
      <footer><button type="button" onClick={() => setHistoryDetail(null)}>关闭</button><button type="button" className="fmPrimary" disabled={!historyDetail.prompt} onClick={() => void copyPrompt(historyDetail, true)}>复制提示词</button></footer>
    </Modal> : null}
    {imports ? <Modal title="导入资产" close={() => { if (!importing) setImports(null); }}><form onSubmit={e => { e.preventDefault(); void submitImport(); }}>
      <label>导入到项目<select autoFocus required value={importTarget} disabled={importing || imports.some(row => row.status !== "pending")} onChange={e => setImportTarget(e.target.value)}>
        <option value="">请选择项目</option>{project.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      {!project.projects.length ? <p>请先新建一个项目，再导入这些作品。</p> : null}
      <p>将 {imports.length} 项作品加入所选项目。复用已保存的原文件，不重复扣费。</p>
      <div className="fmImportProgress" role="status" aria-live="polite">
        <progress aria-label="导入进度" max={imports.length} value={importDone} />
        <span>{importing ? "正在导入" : importDone ? "已处理" : "准备导入"} {importDone} / {imports.length}</span>
        {importDone > 0 ? <span>成功 {importSucceeded} 项 · 已存在 {importExisting} 项 · 失败 {importFailed} 项</span> : null}
      </div>
      <ul className="fmImportResults">{imports.map(row => <li key={row.item.id}>
        <strong>{row.item.prompt || "生成结果"}</strong><span className={row.status === "failed" ? "fmError" : ""}>{importLabels[row.status]}{row.message ? `：${row.message}` : ""}</span>
      </li>)}</ul>
      <footer><button type="button" disabled={importing} onClick={() => setImports(null)}>{importDone ? "关闭" : "取消"}</button>
        {importSucceeded + importExisting > 0 && !importing ? <button type="button" onClick={() => {
          project.selectProject(importTarget); setParams({ tab: "assets" }); setTrash(false); setSource("generated"); setType(""); setQuery(""); setImports(null);
        }}>查看项目资产</button> : null}
        {importDone < imports.length || importFailed > 0 ? <button className="fmPrimary" disabled={!canWrite || importing || !importTarget}>
          {importing ? "导入中…" : importFailed > 0 ? "重试失败项" : "开始导入"}</button> : null}
      </footer>
    </form></Modal> : null}
    {uploadFiles ? <Modal title="上传并分类资产" close={() => { if (!uploading) setUploadFiles(null); }}><form onSubmit={e => { e.preventDefault(); void submitUpload(); }}>
      <p>上传前先选择用途分类；之后可以在资产卡片中再次调整。选择“未分类”也会保留为明确状态，不会按文件类型自动猜测。</p>
      <p>待上传 {uploadFiles.length} 个文件：{uploadFiles.map(file => file.name).join("、")}</p>
      <label>用途分类<select autoFocus value={uploadUsage} disabled={uploading} onChange={e => setUploadUsage(e.target.value as AssetUsage | "uncategorized")}>
        {assetUsageOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      {uploading ? <div className="fmImportProgress" role="status" aria-live="polite"><progress aria-label="上传进度" max={100} value={uploadProgress} /><span>正在上传 {uploadProgress}%</span></div> : null}
      <footer><button type="button" disabled={uploading} onClick={() => setUploadFiles(null)}>取消</button><button className="fmPrimary" disabled={!canWrite || !projectId || !uploadFiles.length || uploading}>{uploading ? "上传中…" : "开始上传"}</button></footer>
    </form></Modal> : null}
    {edit ? <Modal title={actionTitles[edit.action]} close={() => { if (!busy) setEdit(null); }}><form onSubmit={e => { e.preventDefault(); void submitEdit(); }}>
      {textEdit ? <label>{edit.action === "tags" ? "标签，用逗号分隔" : "名称"}<input autoFocus required={edit.action !== "tags"} maxLength={edit.action === "tags" ? 800 : 200} value={draft} onChange={e => setDraft(e.target.value)} /></label> : null}
      {edit.action === "classify" ? <label>用途分类<select autoFocus value={draft} onChange={e => setDraft(e.target.value)}><option value="">未分类</option>{assetUsageOptions.filter(option => option.value !== "uncategorized").map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null}
      {["place", "moveFolder"].includes(edit.action) ? <label>目标文件夹<select value={target} onChange={e => setTarget(e.target.value)}><option value="">根目录</option>{folders.map(f => <option key={f.id} value={f.id}>{folderPath(f)}</option>)}</select></label> : null}
      {edit.action === "addProject" ? <label>目标项目<select value={target} onChange={e => setTarget(e.target.value)} required><option value="">请选择项目</option>{project.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><small>引用同一份素材，不重复上传，也不改变所有权。</small></label> : null}
      {edit.action === "removeProject" ? <p>仅从当前项目移除 {edit.files.length} 项引用。原件、其他项目及生成记录保留。</p> : null}
      {edit.action === "trash" ? <p>将 {edit.files.length} 个文件移入回收站，之后可以恢复。仍被项目使用的文件会阻止此操作。</p> : null}
      {edit.action === "deleteFolder" ? <p>删除空文件夹“{edit.folder?.name}”。包含文件或子文件夹时不会删除。</p> : null}
      {editError ? <p className="fmError" role="alert">{editError}</p> : null}
      <footer><button type="button" disabled={busy} onClick={() => setEdit(null)}>取消</button><button className="fmPrimary" disabled={busy || !actionAllowed(edit.action) || (edit.action === "classify" && !canClassify(edit.files)) || Boolean(textEdit && edit.action !== "tags" && !draft.trim())}>{busy ? "处理中…" : "确认"}</button></footer>
    </form></Modal> : null}
    {groupDialogOpen ? <Modal title="创建资产分组" close={() => { if (!groupSaving) setGroupDialogOpen(false); }}><form onSubmit={e => { e.preventDefault(); void submitGroup(); }}>
      <p>把同一分类下的不同服装、状态或版本归到一个可复用分组中。</p>
      <label>分组名称<input autoFocus required maxLength={80} placeholder="例如：女主·宴会服" value={groupName} onChange={e => setGroupName(e.target.value)} /></label>
      <p>分类：<strong>{groupUsage ? ASSET_USAGE_LABELS[groupUsage] : "请选择同一分类的角色、场景或道具"}</strong> · 已选 {groupableChecked.length} 个资产</p>
      {groupError ? <p className="fmError" role="alert">{groupError}</p> : null}
      <footer><button type="button" disabled={groupSaving} onClick={() => setGroupDialogOpen(false)}>取消</button><button className="fmPrimary" disabled={groupSaving || !canGroup || !groupName.trim()}>{groupSaving ? "创建中…" : "创建分组"}</button></footer>
    </form></Modal> : null}
    {preview ? <Modal title={preview.name} close={closePreview}><div className="fmPreview">
      {previewError ? <p role="alert">{previewError}</p> : !preview.url ? <p role="status">正在读取文件…</p> : fm.fileKind(preview.type) === "image" ? <img src={preview.url} alt={preview.name} onError={() => setPreviewError("图片加载失败，请关闭后重试")} />
        : fm.fileKind(preview.type) === "video" ? <video src={preview.url} controls onError={() => setPreviewError("视频暂时无法播放，可下载查看")} />
        : fm.fileKind(preview.type) === "audio" ? <audio src={preview.url} controls /> : <p>文档可在新窗口打开或下载查看。</p>}
      {preview.url ? <a href={preview.url} target="_blank" rel="noreferrer">打开原文件 / 下载</a> : null}
    </div></Modal> : null}
  </main>;
}
