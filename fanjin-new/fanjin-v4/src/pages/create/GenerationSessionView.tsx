import { videoDurationLabel } from "../../features/quick-create/AutoVideoDurationButton";
import { useEffect, useMemo, useState } from "react";
import {
  HiArrowDownTray,
  HiArrowPath,
  HiArrowRight,
  HiCheck,
  HiOutlineAdjustmentsHorizontal,
  HiOutlineFolder,
  HiOutlineHeart,
  HiOutlineLink,
  HiOutlinePhoto,
  HiOutlinePlay,
  HiOutlinePlus,
  HiOutlineSparkles,
  HiOutlineVideoCamera,
  HiPencil,
  HiXMark,
} from "react-icons/hi2";
import type {
  QuickCreateImageAsset,
  QuickCreateVideoTask,
} from "../../features/quick-create/types";
import { shouldPollTask } from "../../features/quick-create/status";
import { PORTRAIT_PREPARATION_PENDING } from "../../features/quick-create/portraitPreparation";
import { generationPreparationMessage, isPreparingGeneration } from "../../features/quick-create/generationPreparation";
import { getTaskStatusText } from "./quickCreatePresentation";
import "./GenerationSessionView.css";

export type InspirationGenerationScreen = {
  kind: "image" | "video";
  phase: "waiting" | "result" | "failed";
  statusText: string;
  error?: string;
  errorCode?: string;
  /** No accepted generation task has been returned by the server yet. */
  submissionPending?: boolean;
  /** Stable identities for the video tasks created by this generation turn. */
  taskIds?: string[];
};

type GenerationSessionViewProps = {
  screen: InspirationGenerationScreen;
  prompt: string;
  imageAssets: QuickCreateImageAsset[];
  videoTasks: QuickCreateVideoTask[];
  modelLabel: string;
  ratio: string;
  resolution: string;
  requestedCount: number;
  onBack: () => void;
  onNewGeneration: () => void;
  onOpenAssets: () => void;
  onAddToProject: () => void;
  onOpenInCanvas?: () => void;
  continuingMode?: "quick" | "canvas" | null;
  onUseImageForVideo: (asset: QuickCreateImageAsset) => void;
  onContinue: (prompt: string) => void;
  onRetry: () => void;
  onConfirmPricing: () => void;
  onRefresh: () => void;
  onNotice: (message: string) => void;
};

function formatElapsed(createdAt?: number) {
  if (!createdAt) return "刚刚";
  const elapsed = Math.max(0, Date.now() - createdAt);
  if (elapsed < 60_000) return "刚刚";
  const minutes = Math.floor(elapsed / 60_000);
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
}

export function publicManagedVideoUrl(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return "";
  if (candidate.startsWith("/oss/")) return candidate;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    // Native <video> cannot attach the bearer token required by asset reference routes.
    // Generated videos must be rendered from a public/object-storage URL instead.
    if (parsed.pathname.startsWith("/api/")) return "";
    return candidate;
  } catch {
    return "";
  }
}

export function completedVideoTasks(tasks: QuickCreateVideoTask[]) {
  return tasks.filter((task) => (
    task.status === "succeeded"
    && Boolean(publicManagedVideoUrl(task.url))
  ));
}

export function videoTaskIdentity(task: QuickCreateVideoTask): string {
  return task.requestId?.trim()
    || task.relayTaskId?.trim()
    || (Number.isSafeInteger(task.trackId) ? String(task.trackId) : "");
}

function videoTaskIdentities(task: QuickCreateVideoTask): string[] {
  return [
    task.requestId?.trim(),
    task.relayTaskId?.trim(),
    Number.isSafeInteger(task.trackId) ? String(task.trackId) : "",
  ].filter((identity): identity is string => Boolean(identity));
}

export function scopeVideoTasks(
  tasks: QuickCreateVideoTask[],
  taskIds: readonly string[] | null | undefined,
): QuickCreateVideoTask[] {
  if (!taskIds?.length) return tasks;
  const accepted = new Set(taskIds.filter(Boolean));
  // The create response can initially expose only relayTaskId, while a later
  // task-list response also contains a requestId. Match every durable identity
  // so a hard refresh cannot hide the exact task that was placed in the URL.
  return tasks.filter((task) => videoTaskIdentities(task).some((identity) => accepted.has(identity)));
}

export function resolveVideoGenerationProjectId(
  explicitProjectId: string | null | undefined,
  taskIds: readonly string[] | null | undefined,
): number | null {
  const explicit = Number(explicitProjectId);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;

  for (const taskId of taskIds || []) {
    const match = /^quick-create:(\d+):/.exec(taskId);
    const projectId = Number(match?.[1]);
    if (Number.isSafeInteger(projectId) && projectId > 0) return projectId;
  }
  return null;
}

export function deriveVideoGenerationScreen(
  tasks: QuickCreateVideoTask[],
): InspirationGenerationScreen | null {
  if (!tasks.length) return null;
  const activeTasks = tasks.filter((task) => shouldPollTask(task.status));
  if (activeTasks.length) {
    const preparingTask = activeTasks.find(isPreparingGeneration);
    const recoveryMessages = activeTasks.filter((task) => !isPreparingGeneration(task)).map((task) => task.errorReason).filter(Boolean);
    return {
      kind: "video",
      phase: "waiting",
      statusText: preparingTask ? generationPreparationMessage(preparingTask) : recoveryMessages.length ? "任务正在自动恢复" : activeTasks.some((task) => task.status === "running")
        ? "正在生成视频画面"
        : "任务已进入生成队列",
      ...(recoveryMessages.length ? { error: [...new Set(recoveryMessages)].join("；") } : {}),
    };
  }

  const successful = completedVideoTasks(tasks);
  if (successful.length) {
    return {
      kind: "video",
      phase: "result",
      statusText: `已生成 ${successful.length} 个视频结果`,
    };
  }

  return {
    kind: "video",
    phase: "failed",
    statusText: "视频生成未完成",
    error: tasks.map((task) => task.errorReason).filter(Boolean).join("；")
      || "视频任务失败，请调整内容后重试",
  };
}

export function reconcileVideoGenerationScreen(
  current: InspirationGenerationScreen | null,
  routedGenerationKind: string | null,
  tasks: QuickCreateVideoTask[],
): InspirationGenerationScreen | null {
  if (
    routedGenerationKind !== "video"
    || current?.kind !== "video"
    || current.phase === "result"
  ) {
    return current;
  }
  const next = deriveVideoGenerationScreen(tasks);
  return next ? { ...next, taskIds: current.taskIds } : current;
}

export default function GenerationSessionView({
  screen,
  prompt,
  imageAssets,
  videoTasks,
  modelLabel,
  ratio,
  resolution,
  requestedCount,
  onBack,
  onNewGeneration,
  onOpenAssets,
  onAddToProject,
  onOpenInCanvas,
  continuingMode = null,
  onUseImageForVideo,
  onContinue,
  onRetry,
  onConfirmPricing,
  onRefresh,
  onNotice,
}: GenerationSessionViewProps) {
  const [selectedAssetId, setSelectedAssetId] = useState(imageAssets[0]?.id || "");
  const [iterationPrompt, setIterationPrompt] = useState("");
  const [actualVideoDurations, setActualVideoDurations] = useState<Record<string, number>>({});
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const successfulVideos = useMemo(() => completedVideoTasks(videoTasks), [videoTasks]);
  const selectedAsset = imageAssets.find((asset) => asset.id === selectedAssetId) || imageAssets[0];
  const isComplete = screen.phase === "result";
  const isSubmitting = screen.phase === "waiting" && screen.submissionPending === true;
  const requiresPriceConfirmation = screen.errorCode === "pricing_confirmation_required";
  const awaitingPortraitPreparation = screen.kind === "video" && screen.errorCode === PORTRAIT_PREPARATION_PENDING;

  useEffect(() => {
    if (!imageAssets.length) return;
    setSelectedAssetId((current) => imageAssets.some((asset) => asset.id === current)
      ? current
      : imageAssets[0].id);
  }, [imageAssets]);

  function downloadAsset(asset: QuickCreateImageAsset) {
    const link = document.createElement("a");
    link.href = asset.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.download = `fanjin-${asset.id}.png`;
    link.click();
    onNotice("已开始下载选中图片");
  }

  async function copyAssetLink(asset: QuickCreateImageAsset) {
    try {
      await navigator.clipboard.writeText(asset.url);
      onNotice("图片链接已复制");
    } catch {
      onNotice("无法访问剪贴板，请打开图片后复制地址");
    }
  }

  function toggleFavorite(assetId: string) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  function submitIteration() {
    if (screen.phase === "waiting") return;
    const nextPrompt = iterationPrompt.trim();
    if (!nextPrompt) {
      onRetry();
      return;
    }
    onContinue(nextPrompt);
  }

  const statusLabel = awaitingPortraitPreparation ? "等待人物素材准备" : requiresPriceConfirmation ? "等待确认费用" : screen.phase === "failed" ? "本轮生成未完成" : screen.statusText;

  return (
    <section
      className={`generationSession generationSession--${screen.phase}`}
      data-testid="inspiration-generation-screen"
      data-generation-session-view="true"
    >
      <header className="generationSessionTopbar">
        <div>
          <button type="button" className="generationSessionBack" onClick={onBack} aria-label="返回灵感">
            <HiArrowRight aria-hidden="true" />
          </button>
          <h1>生成会话</h1>
          <span className="generationSessionSaved"><HiCheck />{isComplete ? "已自动保存到资产" : requiresPriceConfirmation ? "确认后开始生成" : isSubmitting ? "等待服务端确认" : screen.phase === "waiting" ? "任务将在后台继续" : "本轮尚未完成"}</span>
        </div>
        <button type="button" className="generationSessionNew" onClick={onNewGeneration}>
          <HiOutlinePlus />新建生成
        </button>
      </header>

      <div className="generationSessionLayout">
        <div className="generationSessionCanvas">
          <section className="generationSessionBrief" aria-label="本轮生成参数">
            <strong>{prompt || "未命名创意"}</strong>
            <div>
              <span>模型&nbsp; {modelLabel}</span>
              <span>分辨率&nbsp; {resolution}</span>
              <span>{screen.kind === "image" ? `张数  ${requestedCount}` : ratio}</span>
            </div>
          </section>

          {screen.phase === "waiting" ? (
            <section className={`generationSessionWaiting ${screen.kind}`} role="status">
              <div className="generationSessionWaitingHeading">
                <span><HiOutlineSparkles />{screen.statusText}</span>
                <small>{screen.error || (isSubmitting ? "正在校验参数与费用，请等待提交结果" : "可以离开当前页面，完成后会通知你")}</small>
              </div>
              <div className="generationSessionSkeletonGrid" aria-hidden="true">
                {Array.from({ length: screen.kind === "image" ? Math.min(Math.max(requestedCount, 1), 4) : 1 }).map((_, index) => (
                  <span key={index}><i /></span>
                ))}
              </div>
              {screen.kind === "video" && videoTasks.length ? (
                <div className="generationSessionTaskProgress">
                  {videoTasks.map((task) => (
                    <span key={`${task.videoId}-${task.trackId}`}>
                      <i className={task.status} />镜头 {task.trackId} · {generationPreparationMessage(task) || getTaskStatusText(task.status)}
                    </span>
                  ))}
                </div>
              ) : null}
            </section>
          ) : screen.phase === "failed" ? (
            <section className="generationSessionFailure" role="alert">
              <span><HiXMark /></span>
              <h2>{awaitingPortraitPreparation ? "人物素材仍在准备" : requiresPriceConfirmation ? "确认本次生成费用" : screen.statusText}</h2>
              <p>{awaitingPortraitPreparation ? "当前模型的素材登记耗时较长。点击继续生成会检查准备进度，并接续本次请求。" : screen.error || "生成任务未完成，请调整内容后重试。"}</p>
              <div>
                {requiresPriceConfirmation ? <button type="button" onClick={onConfirmPricing}>确认费用并生成</button> : null}
                <button type="button" onClick={onBack}>{awaitingPortraitPreparation ? "返回编辑" : "调整后重试"}</button>
                {screen.kind === "video" ? <button type="button" onClick={onRefresh}><HiArrowPath />{awaitingPortraitPreparation ? "继续生成" : "刷新任务状态"}</button> : null}
              </div>
            </section>
          ) : screen.kind === "image" ? (
            <section className="generationSessionImageGrid" aria-label="生成图片结果">
              {imageAssets.map((asset, index) => {
                const selected = asset.id === selectedAsset?.id;
                const favorited = favorites.has(asset.id);
                return (
                  <article key={asset.id} className={selected ? "selected" : ""}>
                    <button
                      type="button"
                      className="generationSessionImageSelect"
                      aria-label={`选择第 ${index + 1} 张图片`}
                      aria-pressed={selected}
                      onClick={() => setSelectedAssetId(asset.id)}
                    >
                      <img src={asset.url} alt={asset.prompt || prompt || `生成图片 ${index + 1}`} />
                    </button>
                    <div className="generationSessionImageTools" aria-label={`第 ${index + 1} 张图片操作`}>
                      <button type="button" title="下载" aria-label="下载图片" onClick={() => downloadAsset(asset)}><HiArrowDownTray /></button>
                      <button type="button" title="复制链接" aria-label="复制图片链接" onClick={() => void copyAssetLink(asset)}><HiOutlineLink /></button>
                      <button type="button" className={favorited ? "active" : ""} title="收藏" aria-label="收藏图片" onClick={() => toggleFavorite(asset.id)}><HiOutlineHeart /></button>
                      <button type="button" title="选择并继续编辑" aria-label="选择并继续编辑" onClick={() => setSelectedAssetId(asset.id)}><HiPencil /></button>
                    </div>
                  </article>
                );
              })}
            </section>
          ) : (
            <section className="generationSessionVideoGrid" aria-label="生成视频结果">
              {successfulVideos.map((task, index) => (
                <article key={`${task.videoId}-${task.trackId}`}>
                  <video src={publicManagedVideoUrl(task.url)} controls playsInline preload="metadata" onLoadedMetadata={(event) => {
                    const duration = event.currentTarget.duration;
                    if (Number.isFinite(duration) && duration > 0) {
                      setActualVideoDurations((current) => ({ ...current, [task.url || String(task.videoId)]: Number(duration.toFixed(2)) }));
                    }
                  }} />
                  <span><strong>视频结果 {index + 1}</strong><small>{actualVideoDurations[task.url || String(task.videoId)] || task.duration ? `${videoDurationLabel(actualVideoDurations[task.url || String(task.videoId)] ?? task.duration!)} · ` : ""}{resolution}</small></span>
                </article>
              ))}
            </section>
          )}

          {isComplete ? (
            <div className="generationSessionResultActions">
              {screen.kind === "image" && selectedAsset ? (
                <button type="button" className="primary" onClick={() => onUseImageForVideo(selectedAsset)}>
                  <HiOutlinePlay />用这张生成视频
                </button>
              ) : null}
              <button type="button" disabled={continuingMode !== null} onClick={onAddToProject}>
                <HiOutlineFolder />{continuingMode === "quick" ? "正在创建项目…" : "进入快速模式"}
              </button>
              {onOpenInCanvas ? (
                <button type="button" disabled={continuingMode !== null} onClick={onOpenInCanvas}>
                  <HiOutlineSparkles />{continuingMode === "canvas" ? "正在创建画布…" : "进入画布模式"}
                </button>
              ) : null}
              {screen.kind === "image" ? (
                <>
                  <button type="button" onClick={() => onNotice("局部重绘将在图片编辑器中开放")}><HiPencil />局部重绘</button>
                  <button type="button" onClick={() => onNotice("已创建高清放大任务")}><HiOutlineSparkles />高清放大</button>
                </>
              ) : (
                <button type="button" onClick={onOpenAssets}><HiOutlineVideoCamera />在资产中查看</button>
              )}
            </div>
          ) : null}

          <section className="generationSessionComposer" aria-label="继续调整">
            <textarea
              value={iterationPrompt}
              onChange={(event) => setIterationPrompt(event.target.value)}
              placeholder="继续描述你想调整的内容"
              rows={2}
            />
            <div>
              <span>
                <button type="button" aria-label="添加参考图片" title="添加参考图片" onClick={() => onNotice("请返回灵感页添加参考素材")}><HiOutlinePhoto /></button>
                <button type="button" aria-label="调整参数" title="调整参数" onClick={onBack}><HiOutlineAdjustmentsHorizontal /></button>
              </span>
              <span>
                <button type="button" onClick={() => onNotice("已沿用本轮模型、比例和清晰度")}><HiOutlineAdjustmentsHorizontal />沿用当前参数</button>
                <button type="button" className="regenerate" disabled={screen.phase === "waiting"} onClick={submitIteration}><HiOutlineSparkles />重新生成</button>
                <button type="button" className="send" aria-label="发送调整要求" disabled={screen.phase === "waiting"} onClick={submitIteration}><HiArrowRight /></button>
              </span>
            </div>
          </section>
        </div>

        <aside className="generationSessionRail" aria-label="生成记录">
          <section className="generationSessionCurrent">
            <strong><HiCheck />本轮生成</strong>
            <span>{statusLabel}</span>
            <span>{isComplete ? "已保存到资产" : "完成后自动保存"}</span>
          </section>
          <h2>历史生成</h2>
          <section className="generationSessionHistoryItem">
            <strong>{prompt || "未命名创意"}</strong>
            <span>{ratio} · {screen.kind === "image" ? `${Math.max(imageAssets.length, requestedCount)} 张` : `${successfulVideos.length || videoTasks.length} 个视频`}</span>
            <span>{screen.phase === "waiting" ? "生成中" : formatElapsed(imageAssets[0]?.createdAt || videoTasks[0]?.createdAt)}</span>
            {screen.kind === "image" && imageAssets.length ? (
              <div className="generationSessionHistoryThumbs">
                {imageAssets.slice(0, 4).map((asset) => <img key={asset.id} src={asset.url} alt="" />)}
              </div>
            ) : successfulVideos[0]?.url ? (
              <video src={publicManagedVideoUrl(successfulVideos[0].url)} muted preload="metadata" />
            ) : null}
          </section>
          <button type="button" className="generationSessionAssetsLink" onClick={onOpenAssets}>
            <HiOutlineFolder />查看全部资产
          </button>
        </aside>
      </div>
    </section>
  );
}
