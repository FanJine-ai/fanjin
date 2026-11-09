import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronRight,
  Check,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Upload,
  X,
} from "lucide-react";
import * as assetsApi from "@/api/assets";
import type { Asset } from "@/api/types";
import { PageMeta } from "@/components/PageMeta";
import { uploadReferenceAttachment } from "@/features/quick-create/attachments/api";
import { api } from "@/lib/api";
import { buildProjectModeHref } from "@/routes/projectModeRoutes";
import { useAuthStore } from "@/stores/authStore";
import { canDeleteProjects } from "@/utils/permissions";
import { useProjectStore } from "@/stores/projectStore";
import { useToast } from "@/ui/console/feedback";

type ThemeMode = "dark" | "light";
type RecentProject = { projectId: string; name: string; intro?: string; type?: string; coverImageUrl?: string; createdAt: string; updatedAt: string; previewUrl?: string; previewType?: "image" | "video"; correlationDigest?: string | null };
type ProjectActionKind = "open" | "rename" | "cover" | "duplicate" | "delete";
const coverAssetTypes = ["role", "tool", "scene", "clip", "image"] as const;

function isImageAsset(asset: Asset) {
  const source = asset.src || asset.filePath || "";
  if (!source) return false;
  return !/\.(mp4|mov|webm|m4v|avi|mkv)(?:\?|#|$)/i.test(source);
}

function isVideoCover(url?: string) {
  return /\.(mp4|webm|mov)(?:$|[?#])/i.test(String(url || ""));
}

function anonymousCorrelationDigest(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function getProjectPreviewImageUrl(url: string | undefined | null, maxSide = 720) {
  const raw = String(url || "").trim();
  if (!raw || !(raw.startsWith("http://") || raw.startsWith("https://"))) return raw;
  if (raw.includes("?") || /\.(gif|svg)(?:$|[?#])/i.test(raw)) return raw;
  if (!/(myqcloud\.com|\.cos\.|cos\.|cloud\.tencent)/i.test(raw)) return raw;
  return raw + "?imageMogr2/thumbnail/" + maxSide + "x/format/webp/quality/82";
}

function ProjectPreviewCard({
  project,
  matchedSearchFields,
  menuOpen,
  onClick,
  onOpenAgent,
  onOpenQuick,
  onMenuToggle,
  onRename,
  onCover,
  onDuplicate,
  onDelete,
  deleteDisabled,
  themeMode = "dark",
}: {
  project?: RecentProject;
  matchedSearchFields?: string;
  menuOpen?: boolean;
  onClick: () => void;
  onOpenAgent?: () => void;
  onOpenQuick?: () => void;
  onMenuToggle?: () => void;
  onRename?: () => void;
  onCover?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  themeMode?: ThemeMode;
}) {
  const isLight = themeMode === "light";
  const title = project?.name || "未命名项目";
  const rawDate = project?.updatedAt || project?.createdAt || "";
  const date = rawDate ? String(rawDate).slice(0, 10) : "";
  const mediaUrl = project?.previewUrl || project?.coverImageUrl;
  const optimizedMediaUrl = getProjectPreviewImageUrl(mediaUrl, 720);
  const mediaIsVideo = project?.previewType === "video" || isVideoCover(mediaUrl);
  return (
    <div
      data-testid="project-card"
      data-correlation-digest={anonymousCorrelationDigest(project?.correlationDigest)}
      data-search-matched-fields={matchedSearchFields || undefined}
      className="group relative min-w-0 text-left"
    >
      <button type="button" onClick={onClick} className="block w-full text-left">
        <div className={`relative aspect-[9/16] overflow-hidden rounded-[15px] transition ${isLight ? "bg-[#f1f2f4] ring-1 ring-[#e4e7ec] group-hover:ring-[#bfc7d4]" : "bg-[#252527] ring-1 ring-white/6 group-hover:ring-white/18"}`}>
          {mediaIsVideo && mediaUrl ? (
            <video src={mediaUrl} className="h-full w-full object-cover transition duration-300 ease-out group-hover:scale-[1.04]" muted preload="metadata" playsInline />
          ) : mediaUrl ? (
            <img src={optimizedMediaUrl} alt={title} loading="lazy" decoding="async" className="h-full w-full object-cover transition duration-300 ease-out group-hover:scale-[1.04]" />
          ) : (
            <div className={`flex h-full items-center justify-center ${isLight ? "text-[#a9adb5]" : "text-white/18"}`}>
              <ImageIcon className="h-16 w-16" />
            </div>
          )}
        </div>
      </button>
      <div className="mt-4 flex items-center justify-between gap-3">
        <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left">
          <div className={`line-clamp-1 text-[22px] font-bold ${isLight ? "text-[#111827]" : "text-white"}`}>{title}</div>
        </button>
        {project ? (
          <button type="button" onClick={(event) => { event.stopPropagation(); onMenuToggle?.(); }} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isLight ? "text-[#8b95a3] hover:bg-[#eef1f5] hover:text-[#111827]" : "text-white/55 hover:bg-white/10 hover:text-white"}`} aria-label="项目操作">
            <MoreHorizontal className="h-5 w-5" />
          </button>
        ) : null}
      </div>
      {date ? <div className={`mt-2 text-[17px] ${isLight ? "text-[#697386]" : "text-white/50"}`}>{date}</div> : null}
      {project ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <button type="button" onClick={onOpenAgent} className={`h-8 rounded-lg text-[12px] font-bold transition ${isLight ? "bg-[#f0f3f7] text-[#4b5563] hover:bg-[#e4e9f0] hover:text-[#111827]" : "bg-white/7 text-white/65 hover:bg-white/12 hover:text-white"}`}>Agent</button>
          <button type="button" onClick={onOpenQuick} className={`h-8 rounded-lg text-[12px] font-bold transition ${isLight ? "bg-[#f0f3f7] text-[#4b5563] hover:bg-[#e4e9f0] hover:text-[#111827]" : "bg-white/7 text-white/65 hover:bg-white/12 hover:text-white"}`}>快速</button>
          <button type="button" onClick={onClick} className={`h-8 rounded-lg text-[12px] font-bold transition ${isLight ? "bg-[#111827] text-white hover:bg-[#273244]" : "bg-white text-[#111827] hover:bg-white/90"}`}>画布</button>
        </div>
      ) : null}
      {project && menuOpen ? (
        <div
          data-繁境-overlay-root="true"
          role="menu"
          aria-label={`${title} 项目操作`}
          className={`absolute right-2 top-[calc(100%-72px)] z-[70] w-[198px] rounded-[16px] border p-3 text-[16px] font-medium shadow-[0_20px_50px_rgba(0,0,0,.18)] ${
            isLight
              ? "border-[#e1e5eb] bg-[#fffefb] text-[#243241]"
              : "border-white/10 bg-[#363636] text-white shadow-[0_20px_50px_rgba(0,0,0,.48)]"
          }`}
        >
          <button type="button" role="menuitem" className={`block h-11 w-full rounded-lg px-3 text-left transition ${isLight ? "hover:bg-[#eef3f7]" : "hover:bg-white/10"}`} onClick={onClick}>打开</button>
          <button type="button" role="menuitem" className={`block h-11 w-full rounded-lg px-3 text-left transition ${isLight ? "hover:bg-[#eef3f7]" : "hover:bg-white/10"}`} onClick={onRename}>重命名</button>
          <button type="button" role="menuitem" className={`block h-11 w-full rounded-lg px-3 text-left transition ${isLight ? "hover:bg-[#eef3f7]" : "hover:bg-white/10"}`} onClick={onCover}>修改封面</button>
          <button type="button" role="menuitem" className={`block h-11 w-full rounded-lg px-3 text-left transition ${isLight ? "hover:bg-[#eef3f7]" : "hover:bg-white/10"}`} onClick={onDuplicate}>创建副本</button>
          <button type="button" role="menuitem" className={`block h-11 w-full rounded-lg px-3 text-left transition ${isLight ? "text-[#c53b3b] hover:bg-[#fff0f0]" : "text-[#ff9c9c] hover:bg-white/10"}`} disabled={deleteDisabled} onClick={onDelete}>删除项目</button>
        </div>
      ) : null}
    </div>
  );
}

export default function ProjectGallery({
  galleryOnly = false,
  themeMode = "light",
}: {
  galleryOnly?: boolean;
  themeMode?: ThemeMode;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const selectProject = useProjectStore((state) => state.selectProject);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const [startingCreate, setStartingCreate] = useState(false);
  const startingCreateRef = useRef(false);
  const createdProjectRef = useRef<{ projectId: string; canvasId: string | null } | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [recentProjectsLoading, setRecentProjectsLoading] = useState(true);
  const [recentProjectsError, setRecentProjectsError] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [projectAction, setProjectAction] = useState<{ projectId: string; kind: ProjectActionKind } | null>(null);
  const [renamingProject, setRenamingProject] = useState<RecentProject | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [coverProjectId, setCoverProjectId] = useState<string | null>(null);
  const [coverAssets, setCoverAssets] = useState<Asset[]>([]);
  const [coverAssetsLoading, setCoverAssetsLoading] = useState(false);
  const [coverAssetsError, setCoverAssetsError] = useState("");
  const [selectedCoverAssetId, setSelectedCoverAssetId] = useState<number | null>(null);
  const [coverSearch, setCoverSearch] = useState("");
  const user = useAuthStore(state => state.user);
  const workspace = useAuthStore(state => state.currentWorkspace);
  const canDelete = canDeleteProjects({ user, workspace });
  const [deleteConfirmProject, setDeleteConfirmProject] = useState<RecentProject | null>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const visibleRecentProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    if (!query) return recentProjects;
    return recentProjects.filter((project) => (
      [project.name, project.intro, project.type]
        .some((value) => String(value || "").toLowerCase().includes(query))
    ));
  }, [projectQuery, recentProjects]);
  const visibleCoverAssets = useMemo(() => {
    const keyword = coverSearch.trim().toLowerCase();
    return coverAssets.filter((asset) => {
      if (!isImageAsset(asset)) return false;
      if (!keyword) return true;
      return `${asset.name || ""} ${asset.describe || ""} ${asset.prompt || ""} ${asset.remark || ""}`.toLowerCase().includes(keyword);
    });
  }, [coverAssets, coverSearch]);

  useEffect(() => {
    if (!coverProjectId) {
      setCoverAssets([]);
      setCoverAssetsLoading(false);
      setCoverAssetsError("");
      setSelectedCoverAssetId(null);
      setCoverSearch("");
      return;
    }
    let disposed = false;
    const numericProjectId = Number(coverProjectId);
    if (!Number.isFinite(numericProjectId)) {
      setCoverAssetsLoading(false);
      setCoverAssetsError("当前项目标识无效，无法读取资产");
      return;
    }
    setCoverAssetsLoading(true);
    setCoverAssetsError("");
    void Promise.all(
      coverAssetTypes.map((type) => assetsApi.listAssets({ projectId: numericProjectId, type, page: 1, limit: 100 })),
    )
      .then((results) => {
        if (disposed) return;
        const uniqueAssets = Array.from(new Map(results.flatMap((result) => result.data || []).map((asset) => [asset.id, asset])).values());
        setCoverAssets(uniqueAssets.filter(isImageAsset));
      })
      .catch((error) => {
        if (!disposed) setCoverAssetsError(error instanceof Error ? error.message : "资产加载失败");
      })
      .finally(() => {
        if (!disposed) setCoverAssetsLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [coverProjectId]);

  useEffect(() => {
    if (!coverProjectId) return;
    function handleCoverPickerKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && projectAction?.kind !== "cover") setCoverProjectId(null);
    }
    document.addEventListener("keydown", handleCoverPickerKeyDown);
    return () => document.removeEventListener("keydown", handleCoverPickerKeyDown);
  }, [coverProjectId, projectAction?.kind]);

  async function buildProjectPreview(project: RecentProject): Promise<RecentProject> {
    if (project.coverImageUrl) return { ...project, previewUrl: project.coverImageUrl, previewType: "image" };
    const canvasesResult = await api.getProjectCanvases(project.projectId).catch(() => ({ canvases: [] }));
    const canvases = Array.isArray((canvasesResult as any)?.canvases) ? (canvasesResult as any).canvases : [];
    const canvasCover = canvases.find((canvas: any) => canvas.coverImageUrl)?.coverImageUrl;
    if (canvasCover) return { ...project, previewUrl: canvasCover, previewType: "image" };
    const firstCanvasId = canvases[0]?.canvasId;
    if (!firstCanvasId) return project;
    const loaded = await api.loadCanvas(firstCanvasId).catch(() => null);
    const nodes = Array.isArray((loaded as any)?.nodes) ? (loaded as any).nodes : [];
    const imageNode = nodes.find((node: any) => node?.imageUrl || node?.primaryImageUrl || node?.localPreviewUrl);
    if (imageNode) return { ...project, previewUrl: imageNode.imageUrl || imageNode.primaryImageUrl || imageNode.localPreviewUrl, previewType: "image" };
    const videoNode = nodes.find((node: any) => node?.videoUrl || node?.localVideoUrl);
    if (videoNode) return { ...project, previewUrl: videoNode.videoUrl || videoNode.localVideoUrl, previewType: "video" };
    return project;
  }

  async function refreshRecentProjects() {
    setRecentProjectsLoading(true);
    setRecentProjectsError("");
    try {
      const result = await api.listProjects();
      const projects = Array.isArray((result as any)?.projects) ? ((result as any).projects as RecentProject[]) : [];
      const sorted = [...projects].sort((a, b) => {
        const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bTime - aTime;
      }).slice(0, 12);
      const visibleProjects: RecentProject[] = [];
      setRecentProjects([]);
      for (const project of sorted) {
        const withPreview = await buildProjectPreview(project);
        visibleProjects.push(withPreview);
        setRecentProjects([...visibleProjects]);
        if (visibleProjects.length >= 5) break;
      }
      return visibleProjects;
    } catch (error) {
      setRecentProjects([]);
      setRecentProjectsError(error instanceof Error ? error.message : "项目列表加载失败");
      return [];
    } finally {
      setRecentProjectsLoading(false);
    }
  }

  useEffect(() => {
    if (galleryOnly) {
      setRecentProjects([]);
      setRecentProjectsLoading(false);
      setRecentProjectsError("");
      return undefined;
    }
    let disposed = false;
    void refreshRecentProjects().then((projects) => {
      if (!disposed) setRecentProjects(projects);
    });
    return () => {
      disposed = true;
    };
  }, [galleryOnly]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-繁境-overlay-root]")) return;
      setProjectMenuId(null);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectMenuId(null);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  async function handleStartCreate() {
    if (startingCreateRef.current) return;
    startingCreateRef.current = true;
    setStartingCreate(true);
    try {
      // Keep a successfully created project for retry if preparing its canvas fails.
      if (!createdProjectRef.current) {
        const created = await api.createProject("未命名项目");
        const projectId = String(created?.projectId || "").trim();
        if (!Number.isSafeInteger(Number(projectId)) || Number(projectId) <= 0) {
          throw new Error("创建项目未返回有效的项目 ID，请重试");
        }
        createdProjectRef.current = {
          projectId,
          canvasId: String(created?.defaultCanvasId || "").trim() || null,
        };
      }
      const project = createdProjectRef.current;
      if (!project.canvasId) {
        const result = await api.getProjectCanvases(project.projectId);
        project.canvasId = String(result.canvases?.[0]?.canvasId || "").trim() || null;
        if (!project.canvasId) {
          const canvas = await api.createCanvas("画布 1", project.projectId);
          const revision = Number(canvas.revision);
          if (!canvas.canvasId || !Number.isSafeInteger(revision) || revision <= 0) {
            throw new Error("画布创建响应不完整，请重试");
          }
          project.canvasId = String(canvas.canvasId);
        }
      }
      const { projectId, canvasId } = project;
      selectProject(projectId);
      void fetchProjects();
      navigate(buildProjectModeHref("canvas", { projectId, canvasId }), {
        state: { fromFrontstage: true },
      });
      createdProjectRef.current = null;
    } catch (error) {
      toast({
        title: createdProjectRef.current ? "画布打开失败" : "项目创建失败",
        message: `${error instanceof Error ? error.message : "请稍后重试"}${createdProjectRef.current ? "；项目已保留，点击开始创作可重试打开。" : ""}`,
        tone: "danger",
      });
    } finally {
      startingCreateRef.current = false;
      setStartingCreate(false);
    }
  }

  async function openRecentProject(projectId: string) {
    if (projectAction) return;
    setProjectMenuId(null);
    setProjectAction({ projectId, kind: "open" });
    try {
      selectProject(projectId);
      void fetchProjects();
      const result = await api.getProjectCanvases(projectId);
      const canvases = Array.isArray((result as any)?.canvases) ? (result as any).canvases : [];
      let canvasId = canvases[0]?.canvasId;
      if (!canvasId) {
        const created = await api.createCanvas("画布 1", projectId);
        canvasId = (created as any)?.canvasId;
      }
      if (!canvasId) throw new Error("项目没有可打开的画布");
      navigate(buildProjectModeHref("canvas", { projectId, canvasId }), {
        state: { fromFrontstage: true },
      });
    } catch (error) {
      toast({ title: "项目打开失败", message: error instanceof Error ? error.message : "请稍后重试", tone: "danger" });
    } finally {
      setProjectAction(null);
    }
  }

  async function openProjectMode(projectId: string, mode: "agent" | "quick") {
    selectProject(projectId);
    void fetchProjects();
    setProjectMenuId(null);
    const result = await api.getProjectCanvases(projectId).catch(() => ({ canvases: [] }));
    const canvases = Array.isArray((result as any)?.canvases) ? (result as any).canvases : [];
    navigate(buildProjectModeHref(mode, {
      projectId,
      canvasId: canvases[0]?.canvasId ?? null,
    }));
  }

  async function duplicateRecentProject(project: RecentProject) {
    if (projectAction) return;
    setProjectMenuId(null);
    setProjectAction({ projectId: project.projectId, kind: "duplicate" });
    let nextProjectId = "";
    try {
      const created = await api.createProject(`${project.name} - 副本`);
      nextProjectId = (created as any)?.projectId || "";
      const defaultCanvasId = (created as any)?.defaultCanvasId;
      if (!nextProjectId || !defaultCanvasId) throw new Error("副本项目创建失败");

      if (project.coverImageUrl) {
        await api.updateProject(nextProjectId, { coverImageUrl: project.coverImageUrl });
      }
      const sourceCanvasesResult = await api.getProjectCanvases(project.projectId);
      const sourceCanvases = Array.isArray((sourceCanvasesResult as any)?.canvases) ? (sourceCanvasesResult as any).canvases : [];
      for (let index = 0; index < sourceCanvases.length; index += 1) {
        const sourceCanvas = sourceCanvases[index];
        const createdCanvas = index === 0 ? null : await api.createCanvas(sourceCanvas.name || `画布 ${index + 1}`, nextProjectId);
        const targetCanvasId = index === 0 ? defaultCanvasId : (createdCanvas as any)?.canvasId;
        if (!targetCanvasId) throw new Error(`第 ${index + 1} 个画布创建失败`);
        const loaded = await api.loadCanvas(sourceCanvas.canvasId);
        const connections = Array.isArray((loaded as any)?.connections)
          ? (loaded as any).connections
          : Array.isArray((loaded as any)?.edges) ? (loaded as any).edges : [];
        await api.saveCanvas({
          canvasId: targetCanvasId,
          name: sourceCanvas.name || `画布 ${index + 1}`,
          nodes: Array.isArray((loaded as any)?.nodes) ? (loaded as any).nodes : [],
          edges: connections,
          connections,
          coverImageUrl: sourceCanvas.coverImageUrl || project.coverImageUrl || "",
        });
      }
      await refreshRecentProjects();
      void fetchProjects();
      toast({ title: "副本已创建", message: `${project.name} - 副本`, tone: "success" });
    } catch (error) {
      if (nextProjectId && canDelete) await api.deleteProject(nextProjectId).catch(() => null);
      toast({ title: "创建副本失败", message: error instanceof Error ? error.message : "请稍后重试", tone: "danger" });
    } finally {
      setProjectAction(null);
    }
  }

  async function commitProjectRename() {
    if (!renamingProject || projectAction) return;
    const nextName = renameDraft.trim();
    if (!nextName) {
      toast({ title: "请输入项目名称", tone: "warning" });
      return;
    }
    if (nextName === renamingProject.name) {
      setRenamingProject(null);
      setRenameDraft("");
      return;
    }
    setProjectAction({ projectId: renamingProject.projectId, kind: "rename" });
    try {
      await api.renameProject(renamingProject.projectId, nextName);
      await refreshRecentProjects();
      void fetchProjects();
      setRenamingProject(null);
      setRenameDraft("");
      setProjectMenuId(null);
      toast({ title: "项目已重命名", message: nextName, tone: "success" });
    } catch (error) {
      toast({ title: "重命名失败", message: error instanceof Error ? error.message : "请稍后重试", tone: "danger" });
    } finally {
      setProjectAction(null);
    }
  }

  async function updateProjectCover(projectId: string, url: string) {
    setProjectAction({ projectId, kind: "cover" });
    try {
      await api.updateProject(projectId, { coverImageUrl: url });
      await refreshRecentProjects();
      void fetchProjects();
      setCoverProjectId(null);
      toast({ title: "项目封面已更新", tone: "success" });
    } catch (error) {
      toast({ title: "修改封面失败", message: error instanceof Error ? error.message : "请稍后重试", tone: "danger" });
    } finally {
      setProjectAction(null);
    }
  }

  async function confirmCoverAssetSelection() {
    if (!coverProjectId || selectedCoverAssetId === null || projectAction) return;
    const asset = coverAssets.find((item) => item.id === selectedCoverAssetId);
    const url = asset?.src || asset?.filePath || "";
    if (!url) {
      toast({ title: "这个资产没有可用的图片地址", tone: "warning" });
      return;
    }
    await updateProjectCover(coverProjectId, url);
  }

  async function handleCoverFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !coverProjectId) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "请选择图片文件", tone: "warning" });
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast({ title: "图片不能超过 20MB", tone: "warning" });
      return;
    }
    if (projectAction) return;
    const projectId = coverProjectId;
    setProjectAction({ projectId, kind: "cover" });
    try {
      const numericProjectId = Number(projectId);
      if (!Number.isFinite(numericProjectId)) throw new Error("当前项目标识无效");
      const uploadedAsset = await uploadReferenceAttachment(numericProjectId, file);
      const url = uploadedAsset.previewUrl || "";
      if (!url) throw new Error("图片已上传，但资产没有返回可用地址");
      await api.updateProject(projectId, { coverImageUrl: url });
      await refreshRecentProjects();
      void fetchProjects();
      toast({ title: "项目封面已更新", message: "图片已同时保存到云存储", tone: "success" });
      setCoverProjectId(null);
    } catch (error) {
      toast({ title: "修改封面失败", message: error instanceof Error ? error.message : "请稍后重试", tone: "danger" });
    } finally {
      setProjectAction(null);
    }
  }

  async function confirmDeleteRecentProject() {
    if (!canDelete) return;
    const project = deleteConfirmProject;
    if (!project || projectAction) return;
    setProjectAction({ projectId: project.projectId, kind: "delete" });
    let deletionOperation: Awaited<ReturnType<typeof api.requestProjectDeletion>>;
    try {
      deletionOperation = await api.requestProjectDeletion(project.projectId);
    } catch (error) {
      toast({ title: "删除项目失败", message: error instanceof Error ? error.message : "请稍后重试", tone: "danger" });
      setProjectAction(null);
      return;
    }

    // The project becomes invisible as soon as deletion is accepted. Do not keep
    // the confirmation dialog blocked while durable cleanup finishes in the background.
    setRecentProjects((current) => current.filter((item) => item.projectId !== project.projectId));
    setDeleteConfirmProject(null);
    setProjectMenuId(null);
    setProjectAction(null);
    void fetchProjects();

    const finalizationPending = deletionOperation.status !== "completed";
    toast({
      title: finalizationPending ? "项目已移除" : "项目已删除",
      message: finalizationPending ? `${project.name}，后台正在完成清理` : project.name,
      tone: "success",
    });

    void refreshRecentProjects();
    if (finalizationPending) {
      void api.waitForProjectDeletion(deletionOperation).catch(() => {
        // The accepted deletion remains effective. A later list refresh reflects
        // server truth even if background finalization temporarily times out.
      });
    }
  }

  function requestDeleteRecentProject(project: RecentProject) {
    if (!canDelete) return;
    setProjectMenuId(null);
    setDeleteConfirmProject(project);
  }

  const isLightMode = themeMode === "light";
  const sectionTitleClass = isLightMode ? "text-[#111827]" : "text-white";
  const mutedLinkClass = isLightMode ? "text-[#697386] hover:text-[#111827]" : "text-white/48 hover:text-white";

  return (
    <>
      <PageMeta title="项目广场 - 繁境" description="管理真实项目与画布；FJTV 作品发布和展示服务暂未开放。" />
      <div className={`min-h-full bg-transparent transition-colors duration-200 ${isLightMode ? "text-[#111827]" : "text-white"}`}>
        <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleCoverFileChange(event)} />
        {coverProjectId ? (
          <div
            data-繁境-overlay-root="true"
            className={`fixed inset-0 z-[140] flex items-center justify-center px-4 py-8 ${isLightMode ? "bg-[#17212f]/34" : "bg-black/72"}`}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && projectAction?.kind !== "cover") setCoverProjectId(null);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="cover-picker-title"
              className={`flex max-h-[82vh] w-full max-w-[980px] flex-col overflow-hidden rounded-[26px] border ${isLightMode ? "border-[#e1e5eb] bg-[#fffefb] text-[#17212f] shadow-[0_30px_90px_rgba(31,45,61,.24)]" : "border-white/12 bg-[#242424] text-white shadow-[0_30px_90px_rgba(0,0,0,.6)]"}`}
            >
              <header className={`flex items-start justify-between border-b px-7 py-6 ${isLightMode ? "border-[#e7e9ec]" : "border-white/10"}`}>
                <div>
                  <h2 id="cover-picker-title" className="text-[26px] font-black">选择项目封面</h2>
                  <p className={`mt-1.5 text-[15px] ${isLightMode ? "text-[#6d7887]" : "text-white/48"}`}>
                    可从项目资产或云存储中选择；本地图片上传后会自动保存到云存储
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="关闭封面选择"
                  onClick={() => setCoverProjectId(null)}
                  disabled={projectAction?.kind === "cover"}
                  className={`flex h-10 w-10 items-center justify-center rounded-xl transition disabled:opacity-40 ${isLightMode ? "text-[#5e6977] hover:bg-[#eef2f5]" : "text-white/60 hover:bg-white/10"}`}
                >
                  <X className="h-5 w-5" />
                </button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
                <label className={`flex h-12 items-center rounded-[13px] border px-4 ${isLightMode ? "border-[#dce1e8] bg-[#f6f7f8] text-[#7a8593]" : "border-white/10 bg-[#181818] text-white/42"}`}>
                  <Search className="mr-3 h-5 w-5 shrink-0" />
                  <input
                    value={coverSearch}
                    onChange={(event) => setCoverSearch(event.target.value)}
                    placeholder="搜索图片资产"
                    className={`min-w-0 flex-1 bg-transparent text-[15px] outline-none ${isLightMode ? "text-[#17212f] placeholder:text-[#929ba7]" : "text-white placeholder:text-white/30"}`}
                  />
                </label>

                {coverAssetsLoading ? (
                  <div className={`flex min-h-[330px] flex-col items-center justify-center ${isLightMode ? "text-[#707c8b]" : "text-white/50"}`}>
                    <Loader2 className="h-8 w-8 animate-spin" />
                    <span className="mt-3 text-sm font-medium">正在读取项目资产...</span>
                  </div>
                ) : coverAssetsError ? (
                  <div className={`mt-5 flex min-h-[300px] flex-col items-center justify-center rounded-[18px] border border-dashed px-6 text-center ${isLightMode ? "border-[#dce1e8] bg-[#f8f8f7] text-[#707c8b]" : "border-white/12 bg-white/[.03] text-white/50"}`}>
                    <ImageIcon className="h-10 w-10 opacity-55" />
                    <div className="mt-4 font-bold">资产暂时无法加载</div>
                    <div className="mt-1 max-w-md text-sm">{coverAssetsError}</div>
                  </div>
                ) : visibleCoverAssets.length ? (
                  <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                    {visibleCoverAssets.map((asset) => {
                      const source = asset.src || asset.filePath || "";
                      const selected = selectedCoverAssetId === asset.id;
                      return (
                        <button
                          key={asset.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setSelectedCoverAssetId(asset.id)}
                          className={`group overflow-hidden rounded-[16px] border-2 text-left transition ${selected ? "border-[#17212f] ring-4 ring-[#17212f]/10" : isLightMode ? "border-transparent bg-[#f1f3f5] hover:border-[#c8d0d9]" : "border-transparent bg-white/[.06] hover:border-white/20"}`}
                        >
                          <div className={`relative aspect-[4/3] overflow-hidden ${isLightMode ? "bg-[#e9ecef]" : "bg-black/30"}`}>
                            <img src={source} alt={asset.name || "图片资产"} className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]" />
                            {selected ? (
                              <span className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-[#17212f] text-white shadow-lg">
                                <Check className="h-4 w-4" />
                              </span>
                            ) : null}
                          </div>
                          <div className="px-3 py-3">
                            <div className="truncate text-[14px] font-bold">{asset.name || `资产 ${asset.id}`}</div>
                            <div className={`mt-1 text-xs ${isLightMode ? "text-[#7a8593]" : "text-white/42"}`}>{asset.type === "image" ? "云存储" : "项目资产"}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className={`mt-5 flex min-h-[300px] flex-col items-center justify-center rounded-[18px] border border-dashed px-6 text-center ${isLightMode ? "border-[#dce1e8] bg-[#f8f8f7] text-[#707c8b]" : "border-white/12 bg-white/[.03] text-white/50"}`}>
                    <span className={`flex h-16 w-16 items-center justify-center rounded-2xl ${isLightMode ? "bg-[#eceff2]" : "bg-white/[.07]"}`}>
                      <ImageIcon className="h-8 w-8 opacity-65" />
                    </span>
                    <div className="mt-4 text-[16px] font-bold">{coverSearch ? "没有匹配的图片资产" : "这个项目还没有图片资产"}</div>
                    <div className="mt-1 text-sm">可以从本地上传一张图片作为封面</div>
                  </div>
                )}
              </div>

              <footer className={`flex flex-col-reverse gap-3 border-t px-7 py-5 sm:flex-row sm:items-center sm:justify-between ${isLightMode ? "border-[#e7e9ec] bg-[#faf9f6]" : "border-white/10 bg-black/10"}`}>
                <button
                  type="button"
                  onClick={() => coverInputRef.current?.click()}
                  disabled={projectAction?.kind === "cover"}
                  className={`inline-flex h-12 items-center justify-center gap-2 rounded-xl border px-5 text-[15px] font-bold transition disabled:cursor-wait disabled:opacity-55 ${isLightMode ? "border-[#d7dde5] bg-white text-[#354252] hover:bg-[#f3f5f7]" : "border-white/15 bg-white/[.06] text-white hover:bg-white/10"}`}
                >
                  <Upload className="h-[18px] w-[18px]" />
                  本地上传
                </button>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setCoverProjectId(null)}
                    disabled={projectAction?.kind === "cover"}
                    className={`h-12 rounded-xl px-5 text-[15px] font-bold transition disabled:opacity-40 ${isLightMode ? "bg-[#eceff2] text-[#53606f] hover:bg-[#e2e6ea]" : "bg-white/10 text-white hover:bg-white/15"}`}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmCoverAssetSelection()}
                    disabled={selectedCoverAssetId === null || projectAction?.kind === "cover"}
                    className={`inline-flex h-12 min-w-[118px] items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-bold transition disabled:cursor-not-allowed disabled:opacity-45 ${isLightMode ? "bg-[#17212f] text-white hover:bg-[#293646]" : "bg-white text-black hover:bg-white/90"}`}
                  >
                    {projectAction?.kind === "cover" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {projectAction?.kind === "cover" ? "处理中..." : "设为封面"}
                  </button>
                </div>
              </footer>
            </div>
          </div>
        ) : null}
        {deleteConfirmProject ? (
          <div data-繁境-overlay-root="true" className={`fixed inset-0 z-[130] flex items-center justify-center px-4 ${isLightMode ? "bg-[#17212f]/34" : "bg-black/72"}`}>
            <div role="dialog" aria-modal="true" aria-labelledby="delete-project-title" className={`w-full max-w-[568px] rounded-[22px] border px-7 py-7 ${isLightMode ? "border-[#e1e5eb] bg-[#fffefb] text-[#17212f] shadow-[0_30px_80px_rgba(31,45,61,.2)]" : "border-white/12 bg-[#262626] text-white shadow-[0_30px_80px_rgba(0,0,0,.58)]"}`}>
              <div id="delete-project-title" className="text-[26px] font-black">删除项目</div>
              <div className={`mt-7 text-[20px] font-medium ${isLightMode ? "text-[#687586]" : "text-white/56"}`}>确定要删除该项目吗?</div>
              <div className="mt-8 flex justify-end gap-4">
                <button type="button" onClick={() => setDeleteConfirmProject(null)} className={`h-[52px] rounded-[12px] px-6 text-[20px] font-bold transition ${isLightMode ? "bg-[#eef2f5] text-[#4c5968] hover:bg-[#e4e9ee]" : "bg-white/12 text-white hover:bg-white/18"}`}>取消</button>
                <button type="button" onClick={() => void confirmDeleteRecentProject()} disabled={!canDelete || projectAction?.kind === "delete"} className={`inline-flex h-[52px] items-center gap-2 rounded-[12px] px-6 text-[20px] font-bold transition disabled:cursor-wait disabled:opacity-70 ${isLightMode ? "bg-[#c53b3b] text-white hover:bg-[#ad3232]" : "bg-white text-black hover:bg-white/90"}`}>
                  {projectAction?.kind === "delete" ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                  {projectAction?.kind === "delete" ? "删除中..." : "确认"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {renamingProject ? (
          <div data-繁境-overlay-root="true" className={`fixed inset-0 z-[130] flex items-center justify-center px-4 ${isLightMode ? "bg-[#17212f]/34" : "bg-black/55"}`}>
            <div role="dialog" aria-modal="true" aria-labelledby="rename-project-title" className={`w-full max-w-[520px] rounded-[24px] border p-6 ${isLightMode ? "border-[#e1e5eb] bg-[#fffefb] text-[#17212f] shadow-[0_30px_80px_rgba(31,45,61,.2)]" : "border-white/12 bg-[#242424] text-white shadow-[0_30px_80px_rgba(0,0,0,.5)]"}`}>
              <div id="rename-project-title" className="text-[24px] font-black">重命名项目</div>
              <input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void commitProjectRename(); if (event.key === "Escape") setRenamingProject(null); }} className={`mt-5 h-12 w-full rounded-xl border px-4 outline-none transition ${isLightMode ? "border-[#d7dde6] bg-[#f5f7f9] text-[#243241] placeholder:text-[#8b95a3] focus:border-[#8eaab8] focus:ring-4 focus:ring-[#dcebf1]" : "border-white/12 bg-[#151515] text-white focus:border-white/35"}`} />
              <div className="mt-6 flex justify-end gap-3">
                <button type="button" onClick={() => setRenamingProject(null)} className={`rounded-xl px-5 py-3 font-medium transition ${isLightMode ? "bg-[#eef2f5] text-[#4c5968] hover:bg-[#e4e9ee]" : "bg-white/10 text-white hover:bg-white/15"}`}>取消</button>
                <button type="button" onClick={() => void commitProjectRename()} disabled={!renameDraft.trim() || projectAction?.kind === "rename"} className={`inline-flex items-center gap-2 rounded-xl px-5 py-3 font-bold transition disabled:cursor-not-allowed disabled:opacity-55 ${isLightMode ? "bg-[#111827] text-white hover:bg-[#273244]" : "bg-white text-black hover:bg-white/90"}`}>
                  {projectAction?.kind === "rename" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {projectAction?.kind === "rename" ? "保存中..." : "确认"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <main className="mx-auto max-w-[1920px] px-8 pb-12 pt-4">
            {!galleryOnly ? <section className="mt-4 frontProjectSection">
              <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
                <h2 className={`text-[28px] font-black ${sectionTitleClass}`}>个人最近项目</h2>
                <div className="flex flex-1 items-center justify-end gap-4 sm:flex-none">
                  <label className={`flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border px-3 sm:w-[280px] ${isLightMode ? "border-[#dce1e8] bg-[#fffefb] text-[#7a8593]" : "border-white/12 bg-white/[.05] text-white/45"}`}>
                    <Search className="h-4 w-4 shrink-0" />
                    <input
                      data-testid="project-search-input"
                      aria-label="搜索项目"
                      value={projectQuery}
                      onChange={(event) => setProjectQuery(event.target.value)}
                      placeholder="搜索项目"
                      className={`min-w-0 flex-1 bg-transparent text-[14px] outline-none ${isLightMode ? "text-[#17212f] placeholder:text-[#929ba7]" : "text-white placeholder:text-white/30"}`}
                    />
                  </label>
                  <button type="button" onClick={() => navigate("/workbench/canvas/editor?browser=projects")} className={`inline-flex shrink-0 items-center gap-1 text-[18px] font-medium ${mutedLinkClass}`}>
                    全部项目
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </div>
              </div>
              <div className="grid gap-6 lg:grid-cols-6">
                <button type="button" disabled={startingCreate} aria-busy={startingCreate} onClick={() => void handleStartCreate()} className="frontProjectCreateCard group grid aspect-[9/16] w-full min-w-0 grid-rows-[minmax(0,1fr)_48px] gap-3 self-start text-left disabled:cursor-wait">
                  <div className={isLightMode ? "flex min-h-0 items-center justify-center rounded-[15px] border border-[#e4e0d8] bg-[#fffefb] text-[#7c8797] transition group-hover:border-[#c8d8df] group-hover:bg-[#f5f4f1]" : "flex min-h-0 items-center justify-center rounded-[15px] border border-white/10 bg-[#282829] text-white/72 transition group-hover:border-white/20 group-hover:bg-[#303033]"}>
                    <div className="text-center">
                      {startingCreate ? <Loader2 className="mx-auto h-10 w-10 animate-spin motion-reduce:animate-none" /> : <Plus className={isLightMode ? "mx-auto h-10 w-10 text-[#9aa3af]" : "mx-auto h-10 w-10 text-white/60"} />}
                      <div className={isLightMode ? "mt-5 text-[20px] font-bold text-[#111827]" : "mt-5 text-[20px] font-bold text-white"}>{startingCreate ? "正在打开画布…" : "开始创作"}</div>
                    </div>
                  </div>
                  <div className={isLightMode ? "flex h-full items-center justify-center rounded-[14px] bg-[#fffefb] text-[14px] font-bold text-[#1d1c1c] ring-1 ring-[#e4e0d8] transition group-hover:bg-[#f5f4f1] group-hover:ring-[#c8d8df]" : "flex h-full items-center justify-center rounded-[14px] bg-[#282829] text-[14px] font-bold text-white"}>
                    <span className="mr-2 inline-flex h-4 w-4 items-end justify-center gap-[2px]">
                      <span className={isLightMode ? "h-2 w-[3px] rounded bg-[#111827]" : "h-2 w-[3px] rounded bg-white"} />
                      <span className={isLightMode ? "h-3 w-[3px] rounded bg-[#111827]" : "h-3 w-[3px] rounded bg-white"} />
                      <span className={isLightMode ? "h-4 w-[3px] rounded bg-[#111827]" : "h-4 w-[3px] rounded bg-white"} />
                    </span>
                    Seedance2.0
                  </div>
                </button>
                {recentProjectsLoading ? (
                  <div data-testid="project-loading-state" className={`frontProjectFeedback col-span-2 flex min-h-[220px] items-center justify-center gap-3 rounded-[16px] border text-[16px] font-semibold lg:col-span-5 ${isLightMode ? "border-[#e1e5eb] bg-[#fffefb] text-[#687586]" : "border-white/10 bg-[#282829] text-white/64"}`}>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    正在加载项目
                  </div>
                ) : recentProjectsError ? (
                  <div data-testid="project-error-state" role="alert" className={`frontProjectFeedback col-span-2 flex min-h-[220px] flex-col items-center justify-center gap-4 rounded-[16px] border px-6 text-center lg:col-span-5 ${isLightMode ? "border-[#edcaca] bg-[#fff8f6] text-[#963d3d]" : "border-red-300/20 bg-red-500/8 text-red-100"}`}>
                    <strong className="text-[18px]">项目列表加载失败</strong>
                    <span className="max-w-[620px] text-[14px] opacity-80">{recentProjectsError}</span>
                    <button data-testid="project-retry-button" type="button" onClick={() => void refreshRecentProjects()} className={`rounded-xl px-5 py-2.5 text-[14px] font-bold ${isLightMode ? "bg-[#17212f] text-white" : "bg-white text-black"}`}>重新加载</button>
                  </div>
                ) : recentProjects.length === 0 ? (
                  <div data-testid="project-empty-state" className={`frontProjectFeedback col-span-2 flex min-h-[220px] items-center justify-center rounded-[16px] border text-[16px] font-semibold lg:col-span-5 ${isLightMode ? "border-[#e1e5eb] bg-[#fffefb] text-[#687586]" : "border-white/10 bg-[#282829] text-white/64"}`}>
                    暂无项目，从左侧「开始创作」创建第一个项目
                  </div>
                ) : visibleRecentProjects.length === 0 ? (
                  <div data-testid="project-search-empty-state" className={`frontProjectFeedback col-span-2 flex min-h-[220px] items-center justify-center rounded-[16px] border text-[16px] font-semibold lg:col-span-5 ${isLightMode ? "border-[#e1e5eb] bg-[#fffefb] text-[#687586]" : "border-white/10 bg-[#282829] text-white/64"}`}>
                    没有匹配项目
                  </div>
                ) : visibleRecentProjects.map((project) => (
                    <ProjectPreviewCard
                      key={project.projectId}
                      project={project}
                      matchedSearchFields={projectQuery.trim()
                        ? ([
                            ["name", project.name],
                            ["intro", project.intro],
                            ["type", project.type],
                          ] as const)
                            .filter(([, value]) => String(value || "")
                              .toLowerCase()
                              .includes(projectQuery.trim().toLowerCase()))
                            .map(([field]) => field)
                            .join(",")
                        : undefined}
                      menuOpen={projectMenuId === project.projectId}
                      onClick={() => void openRecentProject(project.projectId)}
                      onOpenAgent={() => void openProjectMode(project.projectId, "agent")}
                      onOpenQuick={() => void openProjectMode(project.projectId, "quick")}
                      onMenuToggle={() => setProjectMenuId((current) => current === project.projectId ? null : project.projectId)}
                      onRename={() => { setRenamingProject(project); setRenameDraft(project.name); setProjectMenuId(null); }}
                      onCover={() => { setCoverProjectId(project.projectId); setProjectMenuId(null); }}
                      onDuplicate={() => void duplicateRecentProject(project)}
                      deleteDisabled={!canDelete}
                      onDelete={() => requestDeleteRecentProject(project)}
                      themeMode={themeMode}
                    />
                  ))}
              </div>
            </section> : null}

            <section className={galleryOnly ? "mt-4" : "mt-16"}>
              <div className="mb-8 text-[28px] font-black">FJTV 作品广场</div>
              <div
                data-testid="tv-show-unavailable-state"
                role="status"
                className={`flex min-h-[220px] flex-col items-center justify-center rounded-[16px] border px-6 text-center ${isLightMode ? "border-[#e1e5eb] bg-[#fffefb] text-[#687586]" : "border-white/10 bg-[#282829] text-white/64"}`}
              >
                <strong className={`text-[18px] ${isLightMode ? "text-[#111827]" : "text-white"}`}>作品发布与展示暂未开放</strong>
                <span className="mt-2 max-w-2xl text-[14px] leading-6">
                  作品广场即将开放。你可以先在创作台制作作品，完成后保存到自己的项目。
                </span>
              </div>
            </section>
        </main>
      </div>
    </>
  );
}
