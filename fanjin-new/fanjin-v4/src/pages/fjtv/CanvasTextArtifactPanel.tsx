import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { Clapperboard, FileText, MapPin, Package, RotateCcw, Sparkles, UsersRound } from "lucide-react";
import "./CanvasTextArtifactPanel.css";
import {
  ARTIFACT_KINDS, ARTIFACT_LABELS, allArtifactCards,
  type CanvasArtifactBinding, type CanvasArtifactCard, type CanvasArtifactKind,
  type CanvasArtifactReference, type CanvasTextArtifacts,
} from "./canvasTextArtifacts";

const buttonClass = "canvasArtifactAction";
const artifactIcons = { characters: UsersRound, scenes: MapPin, props: Package, shots: Clapperboard };

function ShotDependencySummary(props: {
  card: CanvasArtifactCard;
  entries: ReturnType<typeof allArtifactCards>;
  disabled: boolean;
  onEdit: (patch: Partial<CanvasArtifactCard>) => void;
}) {
  const dependencies = ([
    ["characterIds", "characters"],
    ["sceneIds", "scenes"],
    ["propIds", "props"],
  ] as const).map(([field, kind]) => {
    const selected = props.card[field].map((id) => props.entries.find((entry) => entry.kind === kind && entry.card.id === id));
    return { field, kind, selected };
  });
  const hasDependencies = dependencies.some(({ selected }) => selected.length > 0);

  return <div className="canvasArtifactShotDependencies">
    <div className="canvasArtifactShotDependencyHeader">
      <span>本镜头素材</span>
      <span>{hasDependencies ? "将自动带入生图" : "未关联素材"}</span>
    </div>
    {hasDependencies ? <div className="canvasArtifactShotDependencyGroups">
      {dependencies.map(({ field, kind, selected }) => selected.length ? <div key={field} className="canvasArtifactShotDependencyGroup">
        <span className="canvasArtifactShotDependencyLabel">{ARTIFACT_LABELS[kind]}</span>
        <div className="canvasArtifactShotDependencyTags">
          {selected.map((entry, index) => entry ? <span key={entry.card.id} className="canvasArtifactShotDependencyTag">
            {entry.card.name}<em className={entry.card.reference ? "canvasArtifactShotDependencyReady" : "canvasArtifactShotDependencyTextOnly"}>{entry.card.reference ? "已设定图" : "仅文字"}</em>
          </span> : <span key={`${field}-${index}`} className="canvasArtifactShotDependencyMissing">关联已失效</span>)}
        </div>
      </div> : null)}
    </div> : <p className="canvasArtifactShotDependencyHint">可直接生成，或在下方关联角色、场景和道具，保证画面设定一致。</p>}
    <details className="canvasArtifactShotDependencySettings">
      <summary>编辑关联</summary>
      <div className="canvasArtifactShotDependencyEditor">
        {dependencies.map(({ field, kind }) => {
          const options = props.entries.filter((entry) => entry.kind === kind);
          const missing = props.card[field].filter((id) => !options.some((entry) => entry.card.id === id));
          return <fieldset key={field} disabled={props.disabled}><legend>{ARTIFACT_LABELS[kind]}</legend>
            <div className="canvasArtifactShotDependencyOptions">
              {options.map(({ card: option }) => <label key={option.id}>
                <input type="checkbox" checked={props.card[field].includes(option.id)} onChange={(event) => props.onEdit({
                  [field]: event.target.checked ? [...props.card[field], option.id] : props.card[field].filter((id) => id !== option.id),
                })} />{option.name}
              </label>)}
              {!options.length ? <span>尚未提取{ARTIFACT_LABELS[kind]}</span> : null}
              {missing.map((id) => <button key={id} type="button" onClick={() => props.onEdit({ [field]: props.card[field].filter((entry) => entry !== id) })}>移除失效关联</button>)}
            </div>
          </fieldset>;
        })}
      </div>
    </details>
  </div>;
}

export function CanvasArtifactToolbar(props: {
  disabled: boolean;
  hasText: boolean;
  instruction: string;
  pending?: boolean;
  onInstruction: (value: string) => void;
  onGenerate: (kind: CanvasArtifactKind) => void;
  onRetry: () => void;
  onRestart?: () => void;
}) {
  return <div data-canvas-artifact-toolbar className="canvasArtifactSurface canvasArtifactToolbar">
    <div className="canvasArtifactToolbarHeading">
      <span className="canvasArtifactToolbarTitle"><Sparkles size={16} aria-hidden="true" />从正文提取素材</span>
      <span className="canvasArtifactToolbarBadge">正文保留</span>
    </div>
    <div className="canvasArtifactToolbarActions">
      {ARTIFACT_KINDS.map((kind) => {
        const Icon = artifactIcons[kind];
        return <button key={kind} type="button" className={buttonClass}
          disabled={props.disabled || !props.hasText || props.pending} onClick={() => props.onGenerate(kind)}>
          <Icon size={16} aria-hidden="true" />{kind === "shots" ? "细化分镜" : `提取${ARTIFACT_LABELS[kind]}`}
        </button>;
      })}
    </div>
    {props.pending ? <button type="button" className={`${buttonClass} canvasArtifactRetry`} disabled={props.disabled} onClick={props.onRetry}><RotateCcw size={16} aria-hidden="true" />恢复上次请求</button> : null}
    {props.pending && props.onRestart ? <button type="button" className={`${buttonClass} canvasArtifactRetry`} disabled={props.disabled} onClick={props.onRestart}>重新提取（可能再次计费）</button> : null}
    <label className="canvasArtifactInstructionLabel">补充要求<span>选填</span>
      <input aria-label="提取和分镜要求" maxLength={4000} disabled={props.disabled || props.pending}
      className="canvasArtifactInstruction"
      placeholder="可选要求：例如统一古风设定，或细化为 12 个分镜"
      value={props.instruction} onChange={(event) => props.onInstruction(event.target.value)} />
    </label>
    <p className="canvasArtifactToolbarHint">{props.disabled ? "正在生成，请稍候。正文和已有卡片会保留。" : props.pending ? "恢复只查询原请求，不重复生成。重新提取会发起新请求，旧请求不会取消，仍可能计费。" : !props.hasText ? "先生成或填写本节点正文，即可提取素材和细化分镜。" : "结果显示在本节点的对应标签中；再次提取会更新该类别，按所选文本模型计费。"}</p>
  </div>;
}

export function CanvasArtifactTabs(props: {
  artifacts?: CanvasTextArtifacts;
  tab: "body" | CanvasArtifactKind;
  onTab: (tab: "body" | CanvasArtifactKind) => void;
}) {
  return <div role="tablist" aria-label="文本内容" className="mb-3 flex shrink-0 flex-wrap gap-1 border-b border-[#4c4f57] pb-2"
    onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    {(["body", ...ARTIFACT_KINDS] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={props.tab === tab}
      className={`rounded-md px-2 py-1 text-[12px] ${props.tab === tab ? "bg-[#4568a0] text-white" : "text-[#b8c1d1] hover:bg-[#3f424a]"}`}
      onClick={(event) => { event.stopPropagation(); props.onTab(tab); }}>
      {tab === "body" ? "正文" : `${ARTIFACT_LABELS[tab]} ${props.artifacts?.[tab]?.cards.length || 0}`}
    </button>)}
  </div>;
}

export function CanvasArtifactCards(props: {
  kind: CanvasArtifactKind;
  artifacts?: CanvasTextArtifacts;
  currentText: string;
  disabled: boolean;
  images: Array<CanvasArtifactReference & { title: string }>;
  onEdit: (id: string, patch: Partial<CanvasArtifactCard>) => void;
  onDelete: (id: string) => void;
  onCreateImage: (id: string) => void;
}) {
  const collection = props.artifacts?.[props.kind];
  const cards = collection?.cards || [];
  const entries = allArtifactCards(props.artifacts);
  return <div data-canvas-artifact-cards className="canvasArtifactSurface mh-prompt-scrollbar min-h-0 flex-1 space-y-3 overflow-auto text-[12px]"
    onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    {collection && collection.sourceText !== props.currentText ? <p className="rounded-lg bg-[#64522f] p-2 text-[#ffe6ad]">正文已变化，当前卡片来自之前的正文。可保留或重新提取。</p> : null}
    {!cards.length ? <p className="p-3 leading-6 text-[#b3bdce]">暂无{ARTIFACT_LABELS[props.kind]}卡片。选中节点后，使用下方的{props.kind === "shots" ? "细化分镜" : `提取${ARTIFACT_LABELS[props.kind]}`}按钮。</p> : null}
    {cards.map((card, index) => <section key={card.id} className="rounded-xl border border-[#51555f] bg-[#30333b] p-3 text-[#eef2f8]">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[#94acd1]">{index + 1}</span>
        <input aria-label={`${ARTIFACT_LABELS[props.kind]}名称`} maxLength={200} disabled={props.disabled} value={card.name}
          className="min-w-0 flex-1 rounded bg-[#262931] px-2 py-1 font-semibold outline-none focus:ring-1 focus:ring-[#7fa8ef]"
          onChange={(event) => props.onEdit(card.id, { name: event.target.value })} />
        <button type="button" aria-label={`移除${card.name}`} disabled={props.disabled} className="text-[#a5afbf] hover:text-[#f7a5a5]" onClick={() => props.onDelete(card.id)}>移除</button>
      </div>
      <textarea aria-label={`${card.name}画面描述`} maxLength={10000} disabled={props.disabled} value={card.description}
        className="min-h-[100px] w-full resize-y rounded-lg bg-[#262931] p-2 leading-6 outline-none focus:ring-1 focus:ring-[#7fa8ef]"
        onChange={(event) => props.onEdit(card.id, { description: event.target.value })} />
      {card.evidence || card.assumptions ? <details className="my-2 text-[11px] leading-5 text-[#acb8cd]"><summary className="cursor-pointer">原文依据与补充设定</summary>
        {card.evidence ? <p>依据：{card.evidence}</p> : null}{card.assumptions ? <p>补充：{card.assumptions}</p> : null}
      </details> : null}
      {props.kind === "shots" ? <ShotDependencySummary card={card} entries={entries} disabled={props.disabled}
        onEdit={(patch) => props.onEdit(card.id, patch)} /> : <div className="my-2 space-y-2">
        {card.reference ? <div className="flex items-center gap-2"><ReferencePreviewImage src={card.reference.imageUrl} alt={`${card.name}参考图`} className="h-14 w-14 rounded-lg object-cover" /><span className="text-[#a8c6a9]">已确认参考图</span></div> : null}
        <select aria-label={`${card.name}参考图`} disabled={props.disabled} value="" className="w-full rounded-lg bg-[#262931] px-2 py-2 text-[#c2cde0]"
          onChange={(event) => {
            if (event.target.value === "clear") props.onEdit(card.id, { reference: undefined });
            else {
              const image = props.images.find((image) => image.nodeId === event.target.value);
              if (image) { const { title: _title, ...reference } = image; props.onEdit(card.id, { reference }); }
            }
          }}>
          <option value="">{card.reference ? "更换参考图…" : "选择画布中已入库的图片作为参考…"}</option>
          {props.images.map((image) => <option key={image.nodeId} value={image.nodeId}>{image.title}</option>)}
          {card.reference ? <option value="clear">取消参考图</option> : null}
        </select>
      </div>}
      <button type="button" className={`${buttonClass} canvasArtifactCreate mt-1 w-full`} disabled={props.disabled || !card.name.trim() || !card.description.trim()} onClick={() => props.onCreateImage(card.id)}>创建{props.kind === "shots" ? "分镜图" : "图片"}节点</button>
    </section>)}
  </div>;
}

export function CanvasArtifactSourcePicker(props: {
  sources: Array<{ id: string; title: string; textArtifacts?: CanvasTextArtifacts; disabled?: boolean }>;
  bindings: CanvasArtifactBinding[];
  modes: Record<string, "body" | "cards">;
  disabled: boolean;
  onChange: (bindings: CanvasArtifactBinding[], modes: Record<string, "body" | "cards">) => void;
  onEdit?: (sourceNodeId: string, kind: CanvasArtifactKind, cardId: string, patch: Partial<CanvasArtifactCard>) => void;
}) {
  const disconnected = props.bindings.filter((binding) => !props.sources.some((source) => source.id === binding.sourceNodeId));
  const visible = props.sources.filter((source) => allArtifactCards(source.textArtifacts).length || props.bindings.some((binding) => binding.sourceNodeId === source.id));
  if (!visible.length && !disconnected.length) return null;
  return <div data-canvas-artifact-source-picker className="canvasArtifactSurface canvasArtifactSources"
    onClick={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    {disconnected.length ? <button type="button" className={`${buttonClass} canvasArtifactSourceClear`} disabled={props.disabled}
      onClick={() => props.onChange(props.bindings.filter((binding) => !disconnected.includes(binding)), props.modes)}>卡片来源已断开 · 清除引用</button> : null}
    {visible.map((source) => {
      const mode = props.modes[source.id] || "cards";
      const entries = allArtifactCards(source.textArtifacts);
      const bindings = props.bindings.filter((binding) => binding.sourceNodeId === source.id);
      const selected = entries.filter((entry) => bindings.some((binding) => binding.cardId === entry.card.id));
      const missing = bindings.filter((binding) => !entries.some((entry) => entry.card.id === binding.cardId));
      const hasSelection = mode === "body" || selected.length > 0;
      const selector = <select aria-label={`${source.title}引用内容`} disabled={props.disabled}
        className="canvasArtifactSourceSelect" value={mode === "body" ? "body" : selected.length === 1 && !missing.length ? `card:${selected[0].card.id}` : ""}
        onChange={(event) => {
          const value = event.target.value;
          const others = props.bindings.filter((binding) => binding.sourceNodeId !== source.id);
          props.onChange(value.startsWith("card:") ? [...others, { sourceNodeId: source.id, cardId: value.slice(5) }] : others,
            { ...props.modes, [source.id]: value === "body" ? "body" : "cards" });
        }}>
        <option value="" disabled>{selected.length > 1 ? "更换为一张卡片…" : "选择要引用的卡片…"}</option>
        {ARTIFACT_KINDS.map((kind) => {
          const cards = entries.filter((entry) => entry.kind === kind);
          return cards.length ? <optgroup key={kind} label={ARTIFACT_LABELS[kind]}>
            {cards.map(({ card }) => <option key={card.id} value={`card:${card.id}`}>{card.name}</option>)}
          </optgroup> : null;
        })}
        <option value="body">引用正文</option>
      </select>;
      return <div key={source.id} className="canvasArtifactSource">
        {mode === "body" ? <div className="canvasArtifactSourceSummary"><FileText size={15} aria-hidden="true" /><span>已引用：正文「{source.title}」</span></div>
          : selected.map(({ kind, card }) => {
            const Icon = artifactIcons[kind];
            return <div key={card.id} className="canvasArtifactSourceCard">
              <div className="canvasArtifactSourceSummary"><Icon size={15} aria-hidden="true" /><span>已引用：{ARTIFACT_LABELS[kind]}「{card.name}」</span></div>
              <details className="canvasArtifactSourceDescription"><summary>查看描述</summary><p>{card.description}</p></details>
              {props.onEdit ? <details className="canvasArtifactSourceDescription"><summary>编辑设定</summary>
                <label className="canvasArtifactSourceEditorLabel">名称
                  <input aria-label={`${card.name}引用名称`} maxLength={200} value={card.name} disabled={props.disabled || source.disabled}
                    onChange={(event) => props.onEdit?.(source.id, kind, card.id, { name: event.target.value })} />
                </label>
                <label className="canvasArtifactSourceEditorLabel">画面描述
                  <textarea aria-label={`${card.name}引用画面描述`} maxLength={10000} value={card.description} disabled={props.disabled || source.disabled}
                    onChange={(event) => props.onEdit?.(source.id, kind, card.id, { description: event.target.value })} />
                </label>
                <p>修改同步到原卡片，下次新生成使用新描述。已提交的请求保持原内容。</p>
              </details> : null}
            </div>;
          })}
        {mode === "cards" && missing.length ? <button type="button" disabled={props.disabled} className={`${buttonClass} canvasArtifactSourceClear`}
          onClick={() => props.onChange(props.bindings.filter((binding) => !missing.includes(binding)), props.modes)}>卡片已失效 · 清除引用</button> : null}
        {hasSelection && !(mode === "cards" && missing.length) ? <details className="canvasArtifactSourceSettings"><summary>更换引用</summary>{selector}</details>
          : <label className="canvasArtifactSourceLabel">{source.title}{selector}</label>}
      </div>;
    })}
  </div>;
}
