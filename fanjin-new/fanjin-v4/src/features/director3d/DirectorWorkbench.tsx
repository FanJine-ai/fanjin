import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Redo2,
  Save,
  ShieldCheck,
  Upload,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearStoredSubmissionAttempt,
  prepareStoredSubmissionAttempt,
  shouldRetainStoredSubmissionAttempt,
  type StoredSubmissionAttempt,
} from "../quick-create/itemAttemptStorage";
import { useProjectStore } from "../../stores/projectStore";
import { getDirectorScene, listDirectorStoryboards, saveDirectorScene } from "./api";
import {
  createDefaultDirectorScene,
  hasWebGLSupport,
  parseDirectorSceneV1,
  type DirectorSceneV1,
  type DirectorStoryboardOption,
} from "./directorScene";
import { directorSceneFromStudio, studioFromDirectorScene } from "./studioAdapter";
import { DirectorStudioDialog } from "./studio/DirectorStudioDialog";
import { readDirectorStudioState, type DirectorStudioState } from "./studio/types";
import "./DirectorWorkbench.css";

type Props = {
  showPreviousFlowAction?: boolean;
  showNextFlowAction?: boolean;
  onPreviousFlow?: () => void;
  onNextFlow?: () => void;
};

function formatSavedAt(value: number | null): string {
  if (!value) return "尚未保存";
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function DirectorWorkbench({
  showPreviousFlowAction,
  showNextFlowAction,
  onPreviousFlow,
  onNextFlow,
}: Props) {
  const projectId = useProjectStore((state) => state.currentProjectId);
  const initialSceneRef = useRef<DirectorSceneV1 | null>(null);
  if (!initialSceneRef.current) initialSceneRef.current = createDefaultDirectorScene();
  const [scene, setScene] = useState<DirectorSceneV1>(initialSceneRef.current);
  const [studio, setStudio] = useState<DirectorStudioState>(() => studioFromDirectorScene(initialSceneRef.current!));
  const [storyboards, setStoryboards] = useState<DirectorStoryboardOption[]>([]);
  const [bindingStoryboardId, setBindingStoryboardId] = useState("");
  const [bindingCameraId, setBindingCameraId] = useState("");
  const [bindingNotes, setBindingNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("正在准备 3D 预演…");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [webglSupported] = useState(() => hasWebGLSupport());
  const importInputRef = useRef<HTMLInputElement>(null);
  const saveAttemptRef = useRef<StoredSubmissionAttempt | null>(null);
  const activeProjectRef = useRef<number | null>(projectId);

  const renderedScene = useMemo(
    () => directorSceneFromStudio(scene, studio),
    [scene, studio],
  );

  useEffect(() => {
    activeProjectRef.current = projectId;
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    const expectedProjectId = projectId;
    setLoading(true);
    setError("");
    setStatus("正在从项目恢复 3D 预演…");
    void Promise.all([
      getDirectorScene(projectId, controller.signal),
      listDirectorStoryboards(projectId, controller.signal),
    ]).then(([sceneResponse, storyboardOptions]) => {
      if (controller.signal.aborted || activeProjectRef.current !== expectedProjectId) return;
      let nextScene = createDefaultDirectorScene();
      if (sceneResponse.corrupted) {
        setError("云端 3D 预演数据损坏，已阻止覆盖；请先导出证据或联系维护人员");
      } else if (sceneResponse.data) {
        nextScene = parseDirectorSceneV1(sceneResponse.data);
      }
      const nextStudio = studioFromDirectorScene(nextScene);
      const normalizedScene = directorSceneFromStudio(nextScene, nextStudio);
      setScene(normalizedScene);
      setStudio(nextStudio);
      setStoryboards(storyboardOptions);
      setBindingCameraId(normalizedScene.cameras[0]?.id || "");
      setBindingStoryboardId(storyboardOptions[0] ? String(storyboardOptions[0].storyboardId) : "");
      setUpdatedAt(sceneResponse.updatedAt);
      setDirty(false);
      setStatus(sceneResponse.data ? "已恢复云端 3D 预演" : "新场景尚未保存");
    }).catch((cause) => {
      if (controller.signal.aborted || activeProjectRef.current !== expectedProjectId) return;
      setError(cause instanceof Error ? cause.message : "3D 预演加载失败");
      setStatus("加载失败，未写入项目");
    }).finally(() => {
      if (!controller.signal.aborted && activeProjectRef.current === expectedProjectId) setLoading(false);
    });
    return () => controller.abort();
  }, [projectId]);

  const markDirty = useCallback((nextStatus = "有未保存修改") => {
    setDirty(true);
    setStatus(nextStatus);
    setError("");
  }, []);

  const updateStudio = useCallback((next: DirectorStudioState) => {
    setStudio(readDirectorStudioState(next));
    markDirty();
  }, [markDirty]);

  function updateScene(patch: Partial<DirectorSceneV1>, nextStatus?: string) {
    setScene((current) => ({ ...current, ...patch }));
    markDirty(nextStatus);
  }

  async function saveScene() {
    if (!projectId || saving) return;
    let snapshot: DirectorSceneV1;
    try {
      snapshot = parseDirectorSceneV1({
        ...directorSceneFromStudio(scene, studio),
        savedAt: Date.now(),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "3D 预演场景无效");
      return;
    }
    const payload = { projectId, data: snapshot };
    const prepared = prepareStoredSubmissionAttempt({
      current: saveAttemptRef.current,
      flow: "director-scene-save",
      operationKey: String(projectId),
      prefix: `director-scene-${projectId}`,
      payload,
    });
    saveAttemptRef.current = prepared.attempt;
    setSaving(true);
    setStatus("正在保存云端 3D 预演…");
    setError("");
    try {
      const response = await saveDirectorScene(projectId, snapshot, prepared.attempt.idempotencyKey);
      if (activeProjectRef.current !== projectId) return;
      if (!response.accepted) {
        setError("云端已有更新版本，已阻止旧场景覆盖；请刷新页面重新载入");
        setStatus("保存被拒绝：场景版本过期");
        return;
      }
      clearStoredSubmissionAttempt(prepared.storageKey);
      saveAttemptRef.current = null;
      setScene(snapshot);
      setStudio(studioFromDirectorScene(snapshot));
      setDirty(false);
      setUpdatedAt(response.updatedAt);
      setStatus(`已保存并绑定 ${response.boundStoryboardIds?.length || 0} 个分镜`);
    } catch (cause) {
      if (!shouldRetainStoredSubmissionAttempt(cause)) {
        clearStoredSubmissionAttempt(prepared.storageKey);
        saveAttemptRef.current = null;
      }
      if (activeProjectRef.current === projectId) {
        setError(cause instanceof Error ? cause.message : "3D 预演保存失败");
        setStatus("保存失败，修改仍保留在当前页面");
      }
    } finally {
      if (activeProjectRef.current === projectId) setSaving(false);
    }
  }

  function upsertShotBinding() {
    const storyboard = storyboards.find((item) => String(item.storyboardId) === bindingStoryboardId);
    const camera = renderedScene.cameras.find((item) => item.id === bindingCameraId);
    if (!storyboard || !camera) {
      setError("请先选择有效分镜和机位");
      return;
    }
    const binding = {
      storyboardId: storyboard.storyboardId,
      scriptId: storyboard.scriptId,
      trackId: storyboard.trackId,
      cameraId: camera.id,
      characterIds: studio.objects
        .filter((item) => item.kind === "character" && item.visible)
        .map((item) => item.id),
      objectIds: studio.objects
        .filter((item) => ["cube", "sphere", "crowd"].includes(item.kind) && item.visible)
        .map((item) => item.id),
      notes: bindingNotes.trim(),
    };
    const shotBindings = [...scene.shotBindings];
    const index = shotBindings.findIndex((item) => item.storyboardId === storyboard.storyboardId);
    if (index >= 0) shotBindings[index] = binding;
    else shotBindings.push(binding);
    setBindingNotes("");
    updateScene({ shotBindings }, "分镜绑定已更新，保存后才会影响下游生成");
  }

  function exportScene() {
    const snapshot = directorSceneFromStudio(scene, studio);
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${scene.name.replace(/\s+/g, "-") || "director-scene"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importScene(file: File) {
    try {
      const parsed = parseDirectorSceneV1(JSON.parse(await file.text()));
      const nextStudio = studioFromDirectorScene(parsed);
      const normalized = directorSceneFromStudio(parsed, nextStudio);
      setScene(normalized);
      setStudio(nextStudio);
      setBindingCameraId(normalized.cameras[0]?.id || "");
      markDirty("已导入本地场景，尚未保存到项目");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "场景文件无法读取");
    }
  }

  return (
    <section className="directorWorkbench directorIntegratedWorkbench" aria-label="3D 导演预演工作台">
      <header className="directorHeader directorPlatformHeader">
        <div>
          <span className="directorEyebrow">FJN-015-FEAT-03 · PR-015-003B</span>
          <h2>3D 导演预演</h2>
          <p>八类角色、姿势、机位与构图保存到当前项目；绑定分镜后成为后续视频生成的服务端可信约束。</p>
        </div>
        <div className="directorHeaderActions">
          {showPreviousFlowAction ? <button type="button" onClick={onPreviousFlow}><ChevronLeft size={16} />返回分镜</button> : null}
          <button type="button" onClick={() => importInputRef.current?.click()}><Upload size={16} />导入 JSON</button>
          <button type="button" onClick={exportScene}><Download size={16} />导出 JSON</button>
          <button className="directorSaveButton" type="button" onClick={() => void saveScene()} disabled={!dirty || saving || loading}>
            {saving ? <Loader2 className="directorSpin" size={16} /> : <Save size={16} />}
            {saving ? "保存中" : "保存预演"}
          </button>
          {showNextFlowAction ? <button className="directorNextButton" type="button" onClick={onNextFlow}>进入视频生成<ChevronRight size={16} /></button> : null}
          <input ref={importInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importScene(file);
            event.target.value = "";
          }} />
        </div>
      </header>

      <div className="directorStatusBar" role="status">
        <span className={dirty ? "isDirty" : ""}>{status}</span>
        <span>云端更新时间：{formatSavedAt(updatedAt)}</span>
        <span>合同：director-scene.v1 · 右手坐标/Y 轴向上 · 米</span>
      </div>
      {error ? <div className="directorError" role="alert">{error}</div> : null}

      <div className="directorSceneMeta">
        <label className="directorField"><span>场景名称</span><input aria-label="场景名称" value={scene.name} onChange={(event) => updateScene({ name: event.target.value })} /></label>
        <label className="directorField"><span>场景时长（秒）</span><input aria-label="场景时长（秒）" type="number" min={0.1} max={3600} step={0.1} value={scene.durationSeconds} onChange={(event) => updateScene({ durationSeconds: Math.max(0.1, Number(event.target.value) || 0.1) })} /></label>
        <span>项目 {projectId || "未选择"} · 角色 {renderedScene.characters.length} · 物体 {renderedScene.objects.length} · 机位 {renderedScene.cameras.length}</span>
      </div>

      <div className="directorDeliveredStudio" data-testid="director-delivered-studio">
        {loading ? (
          <div className="directorViewportFallback"><Loader2 className="directorSpin" size={28} />正在恢复项目场景</div>
        ) : webglSupported ? (
          <DirectorStudioDialog studio={studio} onStudioChange={updateStudio} />
        ) : (
          <div className="directorViewportFallback">
            <Video size={34} />
            <strong>当前浏览器未提供 WebGL</strong>
            <span>场景数据仍可查看、绑定和保存；请在支持 WebGL 的浏览器中编辑角色姿势与机位。</span>
          </div>
        )}
      </div>

      <section className="directorIntegrationPanel" aria-label="3D 预演分镜绑定">
        <div className="directorIntegrationTitle">
          <div><h3>写回分镜与生产轨道</h3><p>保存后，所选机位、角色、姿势和场景物体会由服务端附加到该分镜的后续视频生成提示。</p></div>
          <span><ShieldCheck size={14} />八类角色均由本地程序化几何生成</span>
        </div>
        <div className="directorBindingGrid">
          <label className="directorField"><span>目标分镜</span><select value={bindingStoryboardId} onChange={(event) => setBindingStoryboardId(event.target.value)}><option value="">选择分镜</option>{storyboards.map((item) => <option key={item.storyboardId} value={item.storyboardId}>{item.scriptName} · 分镜 {item.storyboardId} · {item.prompt.slice(0, 24) || "无描述"}</option>)}</select></label>
          <label className="directorField"><span>使用机位</span><select value={bindingCameraId} onChange={(event) => setBindingCameraId(event.target.value)}><option value="">选择机位</option>{renderedScene.cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}</select></label>
          <label className="directorField directorBindingNotes"><span>导演备注</span><textarea value={bindingNotes} maxLength={1000} placeholder="动作、构图或镜头调度要求" onChange={(event) => setBindingNotes(event.target.value)} /></label>
          <button className="directorBindButton" type="button" onClick={upsertShotBinding}><Redo2 size={15} />绑定当前预演</button>
        </div>
        <div className="directorBindings">
          {renderedScene.shotBindings.map((binding) => {
            const storyboard = storyboards.find((item) => item.storyboardId === binding.storyboardId);
            const camera = renderedScene.cameras.find((item) => item.id === binding.cameraId);
            return <div key={binding.storyboardId}><span>{storyboard?.scriptName || `剧本 ${binding.scriptId}`} · 分镜 {binding.storyboardId}<small>{camera?.name || "机位缺失"}</small></span><button type="button" onClick={() => updateScene({ shotBindings: scene.shotBindings.filter((item) => item.storyboardId !== binding.storyboardId) })}>移除绑定</button></div>;
          })}
        </div>
      </section>
    </section>
  );
}
