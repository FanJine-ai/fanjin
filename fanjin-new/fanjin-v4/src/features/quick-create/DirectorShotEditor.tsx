import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import {
  addDirectorShot,
  addDirectorResource,
  moveDirectorShot,
  removeDirectorResource,
  removeDirectorShot,
  updateDirectorResource,
  updateDirectorShot,
  type DirectorShotPatch,
} from "./directorPlanEditing";
import type { QuickCreateDirectorPlan } from "./types";

type DirectorShotEditorProps = {
  value: QuickCreateDirectorPlan;
  onChange: (value: QuickCreateDirectorPlan) => void;
};

const shotSizes = ["特写", "近景", "中景", "全景", "远景"];
const generationMethods = ["文生视频", "图生视频", "视频转绘", "片段重拍"];

export function DirectorShotEditor({ value, onChange }: DirectorShotEditorProps) {
  const patchShot = (index: number, patch: DirectorShotPatch) => {
    onChange(updateDirectorShot(value, index, patch));
  };

  const resourceGroups = [
    { kind: "character" as const, label: "角色", items: value.characters ?? [] },
    { kind: "scene" as const, label: "场景", items: value.scenes ?? [] },
    { kind: "asset" as const, label: "素材", items: value.assets ?? [] },
  ];

  return (
    <section className="directorShotEditor" data-testid="director-shot-editor" aria-label="快速模式分镜策划">
      <header className="directorShotEditorHeading">
        <span>
          <strong>分镜策划参数</strong>
          <small>调整会同步写入生成提示词；保存后可继续生成、重拍或转绘。</small>
        </span>
        <span className="directorShotOrderActions">
          <small>{value.shots.length} 个镜头 · {value.duration.toFixed(1)} 秒</small>
          <button type="button" aria-label="新增分镜" onClick={() => onChange(addDirectorShot(value))}>
            <Plus size={14} /> 新增分镜
          </button>
        </span>
      </header>
      <section className="directorResourceEditor" aria-label="角色场景素材编排">
        <header>
          <span>
            <strong>制作要素</strong>
            <small>先维护角色、场景与参考素材，再分配到镜头提示词。</small>
          </span>
          <small>制作顺序即镜头顺序，可在下方上移或下移镜头。</small>
        </header>
        <div className="directorResourceGroups">
          {resourceGroups.map((group) => (
            <section key={group.kind} aria-label={`${group.label}清单`}>
              <header>
                <strong>{group.label}</strong>
                <button type="button" aria-label={`添加${group.label}`} onClick={() => onChange(addDirectorResource(value, group.kind))}>
                  <Plus size={14} /> 添加
                </button>
              </header>
              {group.items.length ? group.items.map((resource, index) => (
                <div className="directorResourceRow" key={resource.id}>
                  <input
                    aria-label={`${group.label} ${index + 1} 名称`}
                    value={resource.name}
                    placeholder={`${group.label}名称`}
                    onChange={(event) => onChange(updateDirectorResource(value, group.kind, resource.id, { name: event.target.value }))}
                  />
                  <input
                    aria-label={`${group.label} ${index + 1} 说明`}
                    value={resource.description}
                    placeholder={group.kind === "asset" ? "用途 / 来源" : "外观 / 环境说明"}
                    onChange={(event) => onChange(updateDirectorResource(value, group.kind, resource.id, { description: event.target.value }))}
                  />
                  <button type="button" aria-label={`删除${group.label} ${index + 1}`} onClick={() => onChange(removeDirectorResource(value, group.kind, resource.id))}>
                    <Trash2 size={14} />
                  </button>
                </div>
              )) : <small className="directorResourceEmpty">尚未添加</small>}
            </section>
          ))}
        </div>
      </section>
      <div className="directorShotEditorList">
        {value.shots.map((shot, index) => (
          <details className="directorShotRow" key={`${shot.track}-${index}`} open={index === 0}>
            <summary>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{shot.title || `镜头 ${index + 1}`}</strong>
              <small>{shot.duration.toFixed(1)} 秒 · {shot.generationMethod || "文生视频"}</small>
              <span className="directorShotOrderActions" onClick={(event) => event.preventDefault()}>
                <button
                  type="button"
                  aria-label={`镜头 ${index + 1} 上移`}
                  disabled={index === 0}
                  onClick={() => onChange(moveDirectorShot(value, index, -1))}
                ><ArrowUp size={14} /></button>
                <button
                  type="button"
                  aria-label={`镜头 ${index + 1} 下移`}
                  disabled={index === value.shots.length - 1}
                  onClick={() => onChange(moveDirectorShot(value, index, 1))}
                ><ArrowDown size={14} /></button>
                <button
                  type="button"
                  aria-label={`删除镜头 ${index + 1}`}
                  onClick={() => onChange(removeDirectorShot(value, index))}
                ><Trash2 size={14} /></button>
              </span>
            </summary>
            <div className="directorShotFields">
              <label className="wide">
                <span>镜头标题</span>
                <input aria-label={`镜头 ${index + 1} 标题`} value={shot.title} onChange={(event) => patchShot(index, { title: event.target.value })} />
              </label>
              <label>
                <span>时长（秒）</span>
                <input aria-label={`镜头 ${index + 1} 时长`} type="number" min={1} max={60} step={0.5} value={shot.duration} onChange={(event) => patchShot(index, { duration: Number(event.target.value) })} />
              </label>
              <label>
                <span>景别</span>
                <select aria-label={`镜头 ${index + 1} 景别`} value={shot.shotSize || "中景"} onChange={(event) => patchShot(index, { shotSize: event.target.value })}>
                  {shotSizes.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label>
                <span>机位</span>
                <input aria-label={`镜头 ${index + 1} 机位`} value={shot.camera || ""} placeholder="低机位 / 肩扛 / 航拍" onChange={(event) => patchShot(index, { camera: event.target.value })} />
              </label>
              <label>
                <span>运镜</span>
                <input aria-label={`镜头 ${index + 1} 运镜`} value={shot.movement || ""} placeholder="推进 / 跟拍 / 环绕" onChange={(event) => patchShot(index, { movement: event.target.value })} />
              </label>
              <label>
                <span>生成方式</span>
                <select aria-label={`镜头 ${index + 1} 生成方式`} value={shot.generationMethod || "文生视频"} onChange={(event) => patchShot(index, { generationMethod: event.target.value })}>
                  {generationMethods.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label>
                <span>场景</span>
                <select aria-label={`镜头 ${index + 1} 场景`} value={shot.sceneId || ""} onChange={(event) => patchShot(index, { sceneId: event.target.value })}>
                  <option value="">未指定</option>
                  {(value.scenes ?? []).map((item) => <option key={item.id} value={item.id}>{item.name || "未命名场景"}</option>)}
                </select>
              </label>
              <label>
                <span>角色（可多选）</span>
                <select
                  multiple
                  aria-label={`镜头 ${index + 1} 角色`}
                  value={shot.characterIds ?? []}
                  onChange={(event) => patchShot(index, { characterIds: Array.from(event.currentTarget.selectedOptions, (option) => option.value) })}
                >
                  {(value.characters ?? []).map((item) => <option key={item.id} value={item.id}>{item.name || "未命名角色"}</option>)}
                </select>
              </label>
              <label>
                <span>参考素材（可多选）</span>
                <select
                  multiple
                  aria-label={`镜头 ${index + 1} 素材`}
                  value={shot.assetIds ?? []}
                  onChange={(event) => patchShot(index, { assetIds: Array.from(event.currentTarget.selectedOptions, (option) => option.value) })}
                >
                  {(value.assets ?? []).map((item) => <option key={item.id} value={item.id}>{item.name || "未命名素材"}</option>)}
                </select>
              </label>
              <label className="wide">
                <span>台词 / 旁白</span>
                <textarea aria-label={`镜头 ${index + 1} 台词旁白`} rows={2} value={shot.script} onChange={(event) => patchShot(index, { script: event.target.value })} />
              </label>
              <label className="wide">
                <span>动作</span>
                <input aria-label={`镜头 ${index + 1} 动作`} value={shot.action || ""} placeholder="主体在镜头中的可见动作" onChange={(event) => patchShot(index, { action: event.target.value })} />
              </label>
              <label className="wide">
                <span>画面与环境</span>
                <textarea aria-label={`镜头 ${index + 1} 画面`} rows={2} value={shot.visual} onChange={(event) => patchShot(index, { visual: event.target.value })} />
              </label>
              <label className="wide">
                <span>镜头风格</span>
                <input aria-label={`镜头 ${index + 1} 风格`} value={shot.style || ""} placeholder={value.stylePrompt} onChange={(event) => patchShot(index, { style: event.target.value })} />
              </label>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

export default DirectorShotEditor;
