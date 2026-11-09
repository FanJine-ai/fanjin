import {
  AlertCircle,
  ArrowRight,
  GitBranch,
  Loader2,
  RefreshCw,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  getShortDramaPipelineStatus,
  type PipelineState,
  type ShortDramaPipelineStatus,
} from "../../features/short-drama-pipeline/api";

export type QuickModeOverviewStage = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
};

export type QuickModeOverviewProps = {
  projectId?: number;
  projectName: string;
  stages: readonly QuickModeOverviewStage[];
  updatedAt?: number | string | null;
  onOpenStage: (stageId: string) => void;
  onOpenCanvas: () => void;
};

function formatUpdatedAt(value?: number | string | null) {
  if (!value) return "暂无更新时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无更新时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

const pipelineStateText: Record<PipelineState, string> = {
  not_started: "未开始",
  processing: "处理中",
  ready: "已完成",
  failed: "失败",
};

function ShortDramaPipelineOverview({ projectId, onOpenStage }: {
  projectId?: number;
  onOpenStage: (stageId: string) => void;
}) {
  const [pipeline, setPipeline] = useState<ShortDramaPipelineStatus | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(Boolean(projectId));
  const [pipelineError, setPipelineError] = useState("");

  const loadPipeline = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) return;
    setPipelineLoading(true);
    setPipelineError("");
    try {
      setPipeline(await getShortDramaPipelineStatus(projectId, { signal }));
    } catch (error) {
      if (signal?.aborted) return;
      setPipeline(null);
      setPipelineError(error instanceof Error ? error.message : "短剧流程状态读取失败");
    } finally {
      if (!signal?.aborted) setPipelineLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return undefined;
    const controller = new AbortController();
    void loadPipeline(controller.signal);
    return () => controller.abort();
  }, [loadPipeline, projectId]);

  return (
    <section className="quickPipelineOverview" aria-label="短剧全流程状态">
      <header>
        <span>
          <strong>短剧全流程状态</strong>
          <small>沿用现有剧本作为集、视频轨道作为场、分镜作为镜头；本页只读，不迁移或覆盖跨集版本与素材。</small>
        </span>
        <button type="button" disabled={!projectId || pipelineLoading} onClick={() => void loadPipeline()}>
          <RefreshCw size={14} className={pipelineLoading ? "jimengSpin" : ""} />
          刷新
        </button>
      </header>
      {!projectId ? (
        <div className="quickPipelineState">选择项目后读取短剧流程状态。</div>
      ) : pipelineLoading ? (
        <div className="quickPipelineState"><Loader2 size={18} className="jimengSpin" />正在读取真实流程状态</div>
      ) : pipelineError ? (
        <div className="quickPipelineState failed"><AlertCircle size={18} />{pipelineError}</div>
      ) : !pipeline?.episodes.length ? (
        <div className="quickPipelineState">当前项目还没有剧本；从“剧本”开始后，这里会按集展示场和镜头。</div>
      ) : (
        <div className="quickPipelineEpisodes">
          {pipeline.episodes.map((episode) => (
            <article key={episode.id}>
              <header>
                <span><small>集 #{episode.id}</small><strong>{episode.name}</strong></span>
                <em data-state={episode.state}>{pipelineStateText[episode.state]}</em>
              </header>
              {episode.failureReason ? <p className="quickPipelineFailure"><AlertCircle size={13} />{episode.failureReason}</p> : null}
              <div className="quickPipelineEpisodeMeta">
                <span>{episode.scenes.length} 场</span>
                <span>{episode.scenes.reduce((sum, scene) => sum + scene.shots.length, episode.ungroupedShots.length)} 镜头</span>
                <span>{episode.scriptAssetIds.length} 个剧本素材引用</span>
              </div>
              <div className="quickPipelineScenes">
                {episode.scenes.map((scene) => (
                  <details key={scene.id} open={scene.state === "failed"}>
                    <summary>
                      <span>场 #{scene.id} · {scene.shots.length} 镜头 · 视频版本 {scene.videoVersionIds.length}</span>
                      <em data-state={scene.state}>{pipelineStateText[scene.state]}</em>
                    </summary>
                    {scene.failureReason ? <p className="quickPipelineFailure"><AlertCircle size={13} />{scene.failureReason}</p> : null}
                    {scene.shots.map((shot) => (
                      <div className="quickPipelineShot" key={shot.id}>
                        <span>镜头 {shot.index || shot.id} · {shot.title}</span>
                        <em data-state={shot.state}>{pipelineStateText[shot.state]}</em>
                        {shot.failureReason ? <small>{shot.failureReason}</small> : null}
                      </div>
                    ))}
                  </details>
                ))}
                {episode.ungroupedShots.length ? (
                  <details open>
                    <summary><span>尚未编排到场 · {episode.ungroupedShots.length} 镜头</span><em data-state="not_started">待编排</em></summary>
                    {episode.ungroupedShots.map((shot) => (
                      <div className="quickPipelineShot" key={shot.id}>
                        <span>镜头 {shot.index || shot.id} · {shot.title}</span>
                        <em data-state={shot.state}>{pipelineStateText[shot.state]}</em>
                        {shot.failureReason ? <small>{shot.failureReason}</small> : null}
                      </div>
                    ))}
                  </details>
                ) : null}
              </div>
              <footer>
                <button type="button" onClick={() => onOpenStage("storyboard")}>打开分镜</button>
                <button type="button" onClick={() => onOpenStage("production")}>打开视频生成</button>
                <button type="button" onClick={() => onOpenStage("clip")}>打开剪辑</button>
              </footer>
            </article>
          ))}
        </div>
      )}
      {pipeline ? <footer>已保留并追踪 {pipeline.versionRefs.length} 条当前项目明确 AssetVersion 引用 · 只读刷新于 {formatUpdatedAt(pipeline.refreshedAt)}</footer> : null}
    </section>
  );
}

/**
 * Quick mode's project-level preview. Each module opens the existing mature
 * workbench instead of replacing it with a second implementation.
 */
export function QuickModeOverview({
  projectId,
  projectName,
  stages,
  updatedAt,
  onOpenStage,
  onOpenCanvas,
}: QuickModeOverviewProps) {
  return (
    <section className="quickModeOverview" aria-label="项目流程预览">
      <header className="quickModeOverviewHeader">
        <div>
          <span>项目流程</span>
          <h2>{projectName}</h2>
          <p>从任意模块继续创作；所有结果都写回当前项目，并可随时进入画布继续连接和调整。</p>
        </div>
        <div className="quickModeOverviewActions">
          <button type="button" onClick={onOpenCanvas}>
            <Workflow size={16} />
            画布模式
          </button>
        </div>
      </header>

      <div className="quickModeOverviewRail" role="group" aria-label="当前项目主线">
        <aside>
          <span className="quickModeOverviewBranchIcon"><GitBranch size={17} /></span>
          <strong>主线</strong>
          <small>{formatUpdatedAt(updatedAt)}</small>
        </aside>
        <div className="quickModeOverviewStages">
          {stages.map((stage, index) => {
            const Icon = stage.icon;
            return (
              <button key={stage.id} type="button" onClick={() => onOpenStage(stage.id)}>
                <span className="quickModeOverviewStageIcon"><Icon size={18} /></span>
                <span>
                  <small>{String(index + 1).padStart(2, "0")}</small>
                  <strong>{stage.label}</strong>
                  <em>打开编辑</em>
                </span>
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      <ShortDramaPipelineOverview projectId={projectId} onOpenStage={onOpenStage} />

      <footer className="quickModeOverviewFooter">
        <GitBranch size={15} />
        <span>具体模块保留原来的完整界面；返回预览后可从其他步骤继续，不强制按顺序。</span>
      </footer>
    </section>
  );
}

export default QuickModeOverview;
