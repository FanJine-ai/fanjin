import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { apiPost } from "../../../api/http";
import {
  normalizeImageModelOptions,
  type ImageModelOption,
  type ImageQuality,
  type NormalizedImageCapability,
} from "../../../features/quick-create/videoCapabilities";
import { useProjectStore } from "../../../stores/projectStore";
import "./AddProject.css";

interface AddProjectProps {
  open: boolean;
  onClose: () => void;
  editData?: Record<string, any> | null;
}

type ProjectFormState = {
  name: string;
  projectType: string;
  videoRatio: string;
  imageModel: string;
  imageQuality: ImageQuality | "";
  intro: string;
};

type ProjectModelOptionsResponse = {
  imageModels?: ImageModelOption[];
};

type CatalogState = "idle" | "loading" | "ready" | "error";

function initialForm(editData?: Record<string, any> | null): ProjectFormState {
  const quality = String(editData?.imageQuality || "").trim().toUpperCase();
  return {
    name: String(editData?.name || ""),
    projectType: String(editData?.projectType || "novel"),
    videoRatio: String(editData?.videoRatio || ""),
    imageModel: String(editData?.imageModel || ""),
    imageQuality: quality === "1K" || quality === "2K" || quality === "4K" ? quality : "",
    intro: String(editData?.intro || ""),
  };
}

export function reconcileProjectImageConfiguration(
  models: NormalizedImageCapability[],
  current: Pick<ProjectFormState, "imageModel" | "imageQuality" | "videoRatio">,
): Pick<ProjectFormState, "imageModel" | "imageQuality" | "videoRatio"> | null {
  const model = models.find((item) => item.id === current.imageModel) || models[0];
  if (!model?.canSubmit) return null;
  return {
    imageModel: model.id,
    imageQuality: model.qualities.includes(current.imageQuality as ImageQuality)
      ? current.imageQuality
      : model.defaultQuality,
    videoRatio: model.aspectRatios.includes(current.videoRatio)
      ? current.videoRatio
      : model.defaultAspectRatio,
  };
}

export function validateProjectImageConfiguration(
  models: NormalizedImageCapability[],
  current: Pick<ProjectFormState, "imageModel" | "imageQuality" | "videoRatio">,
): string | null {
  const model = models.find((item) => item.id === current.imageModel);
  if (!model?.canSubmit) return "请选择当前工作区可提交的图片模型";
  if (!current.imageQuality || !model.qualities.includes(current.imageQuality)) {
    return "请选择当前图片模型支持的清晰度";
  }
  if (!model.aspectRatios.includes(current.videoRatio)) {
    return "请选择当前图片模型支持的画面比例";
  }
  return null;
}

export default function AddProject({ open, onClose, editData }: AddProjectProps) {
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const [form, setForm] = useState<ProjectFormState>(() => initialForm(editData));
  const [imageModels, setImageModels] = useState<NormalizedImageCapability[]>([]);
  const [catalogState, setCatalogState] = useState<CatalogState>("idle");
  const [catalogError, setCatalogError] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const nextForm = initialForm(editData);
    setForm(nextForm);
    setImageModels([]);
    setCatalogState("loading");
    setCatalogError("");
    setFormError("");

    void apiPost<ProjectModelOptionsResponse, Record<string, never>>(
      "/workbench/create/modelOptions",
      {},
      undefined,
      { signal: controller.signal },
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        const models = normalizeImageModelOptions(response.imageModels)
          .filter((model) => model.canSubmit);
        const selection = reconcileProjectImageConfiguration(models, nextForm);
        if (!selection) {
          setCatalogState("error");
          setCatalogError("当前工作区没有配置完整且可提交的图片模型，暂不能创建项目");
          return;
        }
        setImageModels(models);
        setForm((current) => ({ ...current, ...selection }));
        setCatalogState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCatalogState("error");
        setCatalogError(
          error instanceof Error && error.message
            ? `模型目录读取失败：${error.message}`
            : "模型目录读取失败，暂不能创建项目",
        );
      });

    return () => controller.abort();
  }, [editData, open]);

  const selectedImageModel = useMemo(
    () => imageModels.find((model) => model.id === form.imageModel) || null,
    [form.imageModel, imageModels],
  );
  const configurationError = catalogState === "ready"
    ? validateProjectImageConfiguration(imageModels, form)
    : catalogError || "图片模型能力目录尚未就绪";

  async function handleSubmit() {
    if (!form.name.trim() || submittingRef.current) return;
    if (configurationError) {
      setFormError(configurationError);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFormError("");
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        type: editData?.type || "",
        artStyle: editData?.artStyle || "",
        directorManual: editData?.directorManual || "",
        videoModel: editData?.videoModel || "",
        mode: editData?.mode || "text",
      };
      if (editData?.id) {
        await apiPost("/project/editProject", { id: editData.id, ...payload } as any);
      } else {
        await apiPost("/project/addProject", payload as any);
      }
      await fetchProjects();
      onClose();
    } catch (e: any) {
      alert(e?.message || "操作失败");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="projectDialogBackdrop" onMouseDown={onClose}>
      <form
        className="projectDialog"
        data-testid="project-create-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <header className="projectDialogHeader">
          <h3>{editData?.id ? "编辑项目" : "新建项目"}</h3>
          <button type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="projectDialogFields">
          <label className="projectDialogField projectDialogFieldWide">
            <span>项目名称</span>
            <input
              autoFocus
              required
              data-testid="project-name-input"
              value={form.name}
              onChange={(event) => {
                setForm({ ...form, name: event.target.value });
                setFormError("");
              }}
              placeholder="输入项目名称"
            />
          </label>
          <label className="projectDialogField">
            <span>项目类型</span>
            <select value={form.projectType} onChange={(event) => setForm({ ...form, projectType: event.target.value })}>
              <option value="novel">基于小说原文</option>
              <option value="script">基于剧本</option>
            </select>
          </label>
          <label className="projectDialogField">
            <span>图片模型</span>
            <select
              aria-label="图片模型"
              data-testid="project-image-model-select"
              value={form.imageModel}
              disabled={catalogState !== "ready"}
              onChange={(event) => {
                const model = imageModels.find((item) => item.id === event.target.value);
                if (!model) return;
                setForm({
                  ...form,
                  imageModel: model.id,
                  imageQuality: model.defaultQuality,
                  videoRatio: model.defaultAspectRatio,
                });
                setFormError("");
              }}
            >
              {catalogState !== "ready" ? <option value="">能力目录加载中…</option> : null}
              {imageModels.map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))}
            </select>
          </label>
          <label className="projectDialogField">
            <span>图片清晰度</span>
            <select
              aria-label="图片清晰度"
              data-testid="project-image-quality-select"
              value={form.imageQuality}
              disabled={!selectedImageModel}
              onChange={(event) => {
                setForm({ ...form, imageQuality: event.target.value as ImageQuality });
                setFormError("");
              }}
            >
              {!selectedImageModel ? <option value="">请先选择图片模型</option> : null}
              {(selectedImageModel?.qualities || []).map((quality) => (
                <option key={quality} value={quality}>{quality}</option>
              ))}
            </select>
          </label>
          <label className="projectDialogField">
            <span>影片比例</span>
            <select
              aria-label="影片比例"
              data-testid="project-video-ratio-select"
              value={form.videoRatio}
              disabled={!selectedImageModel}
              onChange={(event) => {
                setForm({ ...form, videoRatio: event.target.value });
                setFormError("");
              }}
            >
              {!selectedImageModel ? <option value="">请先选择图片模型</option> : null}
              {(selectedImageModel?.aspectRatios || []).map((ratio) => (
                <option key={ratio} value={ratio}>{ratio}</option>
              ))}
            </select>
          </label>
          <label className="projectDialogField projectDialogFieldWide">
            <span>简介</span>
            <textarea
              value={form.intro}
              onChange={(event) => setForm({ ...form, intro: event.target.value })}
              rows={4}
              placeholder="用于后续脚本、角色、分镜生成的项目简介"
            />
          </label>
          {catalogState === "loading" ? (
            <p className="projectDialogStatus projectDialogFieldWide" role="status">
              正在读取当前工作区的真实图片能力…
            </p>
          ) : null}
          {catalogError || formError ? (
            <p className="projectDialogError projectDialogFieldWide" role="alert">
              {formError || catalogError}
            </p>
          ) : null}
        </div>

        <footer className="projectDialogFooter">
          <button className="projectDialogCancel" type="button" onClick={onClose}>取消</button>
          <button
            className="projectDialogSubmit"
            type="submit"
            data-testid="project-create-submit-button"
            disabled={submitting || !form.name.trim() || Boolean(configurationError)}
          >
            {submitting ? "提交中…" : editData?.id ? "保存" : "创建"}
          </button>
        </footer>
      </form>
    </div>
  );
}
