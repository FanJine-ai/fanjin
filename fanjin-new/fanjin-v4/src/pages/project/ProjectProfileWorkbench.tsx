import React, { useEffect, useState } from "react";
import { useProjectStore } from "../../stores/projectStore";
import { apiPost } from "../../api/http";
import AgentBudgetSection from "../../features/agent-runtime/AgentBudgetSection";
import { fetchQuickCreateModels } from "../../features/quick-create/modelCatalog";

type ProjectProfileForm = {
  name: string;
  intro: string;
  projectType: string;
  videoRatio: string;
};

type ProjectProfileEditInput = Pick<ProjectProfileForm, "name" | "intro">
  & Partial<Pick<ProjectProfileForm, "projectType" | "videoRatio">>;

const PROJECT_EDIT_STRING_FIELDS = [
  "name",
  "intro",
  "type",
  "artStyle",
  "directorManual",
  "videoRatio",
  "imageModel",
  "videoModel",
  "projectType",
  "imageQuality",
  "mode",
] as const;

function singleProjectRecord(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

/**
 * The legacy edit endpoint replaces every project setting in one update. Read
 * the authoritative record first and refuse to invent absent values, otherwise
 * editing only the name can silently write fake mode/ratio/model defaults.
 */
export function buildProjectProfileEditPayload(
  response: unknown,
  expectedProjectId: string | number,
  form: ProjectProfileEditInput,
) {
  const project = singleProjectRecord(response);
  if (!project) throw new Error("项目详情响应为空，已阻止保存");
  if (String(project.id ?? "") !== String(expectedProjectId)) {
    throw new Error("项目详情响应与当前项目不一致，已阻止保存");
  }

  const missingFields = PROJECT_EDIT_STRING_FIELDS.filter((field) => (
    !Object.prototype.hasOwnProperty.call(project, field) || typeof project[field] !== "string"
  ));
  if (missingFields.length) {
    throw new Error(`项目配置不完整（${missingFields.join("、")}），已阻止用默认值覆盖真实配置`);
  }

  const name = form.name.trim();
  if (!name) throw new Error("项目名称不能为空");
  const projectType = form.projectType || project.projectType as string;
  if (projectType !== "novel" && projectType !== "script") {
    throw new Error("项目类型无效，已阻止保存");
  }
  const videoRatio = String(form.videoRatio || project.videoRatio || "").trim();
  if (!videoRatio) throw new Error("影片比例不能为空，已阻止保存");

  return {
    id: Number(expectedProjectId),
    name,
    intro: form.intro,
    type: project.type as string,
    artStyle: project.artStyle as string,
    directorManual: project.directorManual as string,
    videoRatio,
    imageModel: project.imageModel as string,
    videoModel: project.videoModel as string,
    projectType,
    imageQuality: project.imageQuality as string,
    mode: project.mode as string,
  };
}

export default function ProjectProfileWorkbench() {
  const currentProject = useProjectStore((s) => s.currentProject);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [supportedRatios, setSupportedRatios] = useState<string[]>([]);
  const [ratioCatalogLoading, setRatioCatalogLoading] = useState(false);
  const [form, setForm] = useState<ProjectProfileForm>({
    name: currentProject?.name || "",
    intro: currentProject?.intro || "",
    projectType: currentProject?.projectType || "novel",
    videoRatio: currentProject?.videoRatio || "",
  });

  useEffect(() => {
    setEditing(false);
    setSaving(false);
    setSaveError("");
    setForm({
      name: currentProject?.name || "",
      intro: currentProject?.intro || "",
      projectType: currentProject?.projectType || "novel",
      videoRatio: currentProject?.videoRatio || "",
    });
    setSupportedRatios([]);
    setRatioCatalogLoading(false);
  }, [currentProject?.id]);

  useEffect(() => {
    if (!editing || !currentProject) return;
    let active = true;
    setRatioCatalogLoading(true);
    void fetchQuickCreateModels()
      .then(({ imageModels }) => {
        if (!active) return;
        const model = imageModels.find((item) => item.id === currentProject.imageModel);
        if (!model) {
          setSupportedRatios([form.videoRatio].filter(Boolean));
          setSaveError("当前项目图片模型不在可用目录中，暂不能修改影片比例");
          return;
        }
        setSupportedRatios(model.aspectRatios);
        setForm((current) => ({
          ...current,
          videoRatio: model.aspectRatios.some((ratio) => ratio === current.videoRatio)
            ? current.videoRatio
            : model.defaultAspectRatio,
        }));
      })
      .catch((error) => {
        if (!active) return;
        setSupportedRatios([form.videoRatio].filter(Boolean));
        setSaveError(error instanceof Error ? `影片比例目录读取失败：${error.message}` : "影片比例目录读取失败");
      })
      .finally(() => {
        if (active) setRatioCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentProject?.id, currentProject?.imageModel, editing]);

  async function handleSave() {
    if (!currentProject || saving) return;
    if (ratioCatalogLoading || !supportedRatios.includes(form.videoRatio)) {
      setSaveError("请选择当前图片模型支持的影片比例");
      return;
    }
    const projectId = Number(currentProject.id);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      setSaveError("当前项目 ID 无效，已阻止保存");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const authoritative = await apiPost<unknown>("/general/getSingleProject", { id: projectId });
      const payload = buildProjectProfileEditPayload(authoritative, projectId, form);
      await apiPost("/project/editProject", payload);
      setEditing(false);
      await fetchProjects();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (!currentProject) return <div style={{ padding: 24, color: "#71717a" }}>未选择项目</div>;

  return (
    <div
      data-testid="quick-project-page"
      data-project-type={currentProject.projectType || currentProject.type || undefined}
      data-project-ratio={currentProject.videoRatio || undefined}
      data-project-correlation-digest={currentProject.correlationDigest || undefined}
      style={{ padding: 24, maxWidth: 640 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: "#18181b" }}>项目设定</h2>
        <button
          disabled={saving || (editing && ratioCatalogLoading)}
          onClick={() => editing ? void handleSave() : (setSaveError(""), setEditing(true))}
          style={{ padding: "6px 16px", borderRadius: 6, border: "none", background: "#5d94bd", color: "#fff", cursor: saving ? "wait" : "pointer", fontSize: 13, opacity: saving ? 0.65 : 1 }}
        >
          {saving ? "保存中…" : editing && ratioCatalogLoading ? "读取配置…" : editing ? "保存" : "编辑"}
        </button>
      </div>
      {saveError ? (
        <div role="alert" style={{ marginBottom: 14, padding: "10px 12px", border: "1px solid #fecaca", borderRadius: 8, background: "#fef2f2", color: "#b91c1c", fontSize: 13 }}>
          {saveError}
        </div>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ padding: 12, borderRadius: 8, border: `1px solid ${"#e4e4e7"}`, background: "#fafafa" }}>
          <div style={{ fontSize: 12, color: "#71717a", marginBottom: 4 }}>项目名称</div>
          {editing ? (
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: "100%", padding: 6, border: `1px solid ${"#e4e4e7"}`, borderRadius: 4, fontSize: 14, color: "#18181b", outline: "none" }} />
          ) : (
            <div style={{ fontSize: 15, fontWeight: 600, color: "#18181b" }}>{currentProject.name}</div>
          )}
        </div>
        <div style={{ padding: 12, borderRadius: 8, border: `1px solid ${"#e4e4e7"}`, background: "#fafafa" }}>
          <div style={{ fontSize: 12, color: "#71717a", marginBottom: 4 }}>项目简介</div>
          {editing ? (
            <textarea value={form.intro} onChange={(e) => setForm({ ...form, intro: e.target.value })} rows={3} style={{ width: "100%", padding: 6, border: `1px solid ${"#e4e4e7"}`, borderRadius: 4, fontSize: 14, color: "#18181b", outline: "none", resize: "vertical", fontFamily: "inherit" }} />
          ) : (
            <div style={{ fontSize: 14, color: "#18181b", lineHeight: 1.6 }}>{(currentProject as any).intro || "暂无简介"}</div>
          )}
        </div>
        <div style={{ padding: 12, borderRadius: 8, border: `1px solid ${"#e4e4e7"}`, background: "#fafafa" }}>
          <div style={{ fontSize: 12, color: "#71717a", marginBottom: 4 }}>影片比例</div>
          {editing ? (
            <select aria-label="影片比例" value={form.videoRatio} disabled={ratioCatalogLoading || supportedRatios.length === 0} onChange={(event) => setForm({ ...form, videoRatio: event.target.value })} style={{ width: "100%", padding: 6, border: `1px solid ${"#e4e4e7"}`, borderRadius: 4, fontSize: 14, color: "#18181b" }}>
              {supportedRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
            </select>
          ) : (
            <div style={{ fontSize: 14, color: "#18181b" }}>{currentProject.videoRatio || "未配置"}</div>
          )}
        </div>
        <div style={{ padding: 12, borderRadius: 8, border: `1px solid ${"#e4e4e7"}`, background: "#fafafa" }}>
          <div style={{ fontSize: 12, color: "#71717a", marginBottom: 4 }}>项目类型</div>
          {editing ? (
            <select aria-label="项目类型" value={form.projectType} onChange={(event) => setForm({ ...form, projectType: event.target.value })} style={{ width: "100%", padding: 6, border: `1px solid ${"#e4e4e7"}`, borderRadius: 4, fontSize: 14, color: "#18181b" }}>
              <option value="novel">小说项目</option>
              <option value="script">剧本项目</option>
            </select>
          ) : (
            <div style={{ fontSize: 14, color: "#18181b" }}>
              {currentProject.projectType === "novel" ? "小说项目" : currentProject.projectType === "script" ? "剧本项目" : currentProject.projectType || "未配置"}
            </div>
          )}
        </div>
        {/* 预算自主审批:设置后额度内 R2 审批自动批准,不再弹出确认卡 */}
        <AgentBudgetSection projectId={currentProject.id} />
      </div>
    </div>
  );
}
