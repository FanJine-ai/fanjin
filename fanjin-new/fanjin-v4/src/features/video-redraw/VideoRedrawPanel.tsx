import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Clapperboard, Film, Image as ImageIcon, Layers3, Link2, Palette, Pause, Play, Plus, Save, SlidersHorizontal, Trash2, Volume2, X } from "lucide-react";
import ReferencePreviewImage from "../quick-create/attachments/ReferencePreviewImage";
import { ReferencePreviewVideo } from "../quick-create/attachments/AuthenticatedReferenceMedia";
import { buildRedrawPlan, createRedrawDraft, REDRAW_STYLES, redrawTime, type RedrawAsset, type RedrawDraft, type RedrawSource } from "./redrawDraft";
import "./VideoRedrawPanel.css";

export type VideoRedrawPanelProps = {
  source: RedrawSource;
  assets: RedrawAsset[];
  models: { id: string; name: string }[];
  initialDraft?: RedrawDraft;
  dark?: boolean;
  demo?: boolean;
  editing?: boolean;
  assetsScope?: "connected" | "canvas";
  resultUrl?: string;
  onClose: () => void;
  onSave: (draft: RedrawDraft) => Promise<void>;
  onCreate: (draft: RedrawDraft) => Promise<void>;
};
export function VideoRedrawPanel({ source, assets, models, initialDraft, dark = false, demo = false, editing = false, assetsScope = "canvas", resultUrl, onClose, onSave, onCreate }: VideoRedrawPanelProps) {
  const [draft, setDraft] = useState<RedrawDraft>(() => initialDraft || createRedrawDraft(models[0]?.id));
  const [selectedShot, setSelectedShot] = useState(0);
  const [activeTab, setActiveTab] = useState("mapping");
  const [picker, setPicker] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(source.duration);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const result = useRef<HTMLVideoElement>(null);
  const shots = useMemo(() => source.shots.length ? source.shots : [{ id: "whole", title: "完整原片", start: 0, end: duration, description: "沿用整段原片；可先在画布完成逐帧拉片，带入真实镜头时间线。", poster: source.poster }], [source, duration]);
  const current = shots[selectedShot] || shots[0];
  const mapped = draft.mappings.filter(item => item.assetId).length;
  const selectedAssets = new Map(assets.map(asset => [asset.id, asset]));
  useEffect(() => { const el = dialog.current; if (el && !el.open) el.showModal(); return () => { el?.close(); }; }, []);
  function change(patch: Partial<RedrawDraft>) { setDraft(prev => ({ ...prev, ...patch })); setMessage(""); setError(""); }
  function seek(at: number) {
    const next = Math.max(0, Math.min(duration, at)); setTime(next);
    if (video.current) video.current.currentTime = next;
    if (result.current) result.current.currentTime = next;
  }
  async function togglePlayback() {
    try {
      if (!video.current) return;
      if (playing) { video.current.pause(); result.current?.pause(); }
      else { await video.current.play(); if (result.current) await result.current.play(); }
    } catch { setError("视频暂时无法播放，请检查原片是否可用。"); }
  }
  async function commit(create: boolean) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      if (create) {
        if (!models.some(model => model.id === draft.modelId)) throw new Error("当前没有可用的原片编辑模型；配置仍可保存，不会自动改用重生成。");
        buildRedrawPlan(draft, assets);
        await onCreate(draft); setMessage(editing ? "转绘节点已更新，尚未提交生成。" : demo ? "示例转绘节点已添加到画布，未提交生成。" : "转绘节点已创建。回到画布查看报价后，再开始生成。");
      } else { await onSave(draft); setMessage("配置已保存，下次打开可继续编辑。"); }
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="redraw-dialog" data-theme={dark ? "dark" : "light"} aria-labelledby="redraw-title" onCancel={event => { event.preventDefault(); if (picker) setPicker(null); else onClose(); }} onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <header className="redraw-header">
      <button className="redraw-icon-button" aria-label="返回画布" onClick={onClose}><ArrowLeft size={19} /></button>
      <div className="redraw-heading"><span className="redraw-eyebrow">视频工作流 <span>/</span> 一键转绘 {demo && <em>交互示例</em>}</span><h1 id="redraw-title">把原片，变成你的故事</h1></div>
      <div className="redraw-source-pill"><Film size={15} /><span>{source.title}</span></div>
      <button className="redraw-icon-button" aria-label="关闭转绘面板" onClick={onClose}><X size={19} /></button>
    </header>
    <div className="redraw-steps"><span className="is-done"><Check size={13} /> 导入原片</span><i /><span className="is-current"><b>2</b> 配置转绘</span><i /><span><b>3</b> 生成与审片</span><div className="redraw-mode"><Link2 size={13} /> 原片编辑 · 保留原视频输入</div></div>
    <div className="redraw-body">
      <aside className="redraw-assets">
        <div className="redraw-tabbar" role="tablist" aria-label="转绘设置">
          <button role="tab" aria-selected={activeTab === "mapping"} onClick={() => setActiveTab("mapping")}><Layers3 size={15} />替换资产</button>
          <button role="tab" aria-selected={activeTab === "style"} onClick={() => setActiveTab("style")}><Palette size={15} />整体画风</button>
        </div>
        {activeTab === "mapping" ? <div className="redraw-asset-body" role="tabpanel" aria-label="替换资产">
          <div className="redraw-section-heading"><h2>谁，换成谁</h2><span>{mapped} 项已配置</span></div><p className="redraw-muted">{assetsScope === "connected" ? `${assets.length} 个图片节点已连接；为每份参考指定原片对象。` : "绑定一次，应用到整段原片。"}</p>
          {draft.mappings.map(mapping => { const asset = selectedAssets.get(mapping.assetId); return <section className="redraw-mapping" key={mapping.id}>
            <div className="redraw-mapping-top"><select className="redraw-kind" aria-label={`替换类型 ${mapping.id}`} value={mapping.kind} onChange={event => change({ mappings: draft.mappings.map(item => item.id === mapping.id ? { ...item, kind: event.target.value as typeof mapping.kind } : item) })}><option value="character">角色</option><option value="scene">场景</option><option value="prop">道具</option></select><button className="redraw-small-icon" aria-label={`删除${mapping.source}替换`} onClick={() => change({ mappings: draft.mappings.filter(item => item.id !== mapping.id) })}><Trash2 size={13} /></button></div>
            <label className="redraw-source-label"><span className="sr-only">原片对象 {mapping.id}</span><input placeholder="原片中的哪个对象？" value={mapping.source} aria-label={`原片对象 ${mapping.id}`} onChange={event => change({ mappings: draft.mappings.map(item => item.id === mapping.id ? { ...item, source: event.target.value } : item) })} /></label>
            <div className="redraw-mapping-arrow"><ArrowRight size={13} /><span>替换为</span></div>
            <button className={`redraw-asset-choice ${asset ? "has-asset" : ""}`} onClick={() => { setPicker(mapping.id); setSearch(""); }} aria-label={`选择${mapping.source}的替换资产`}>
              {asset ? <ReferencePreviewImage src={asset.imageUrl} alt="" /> : <span className="redraw-asset-placeholder"><Plus size={19} /></span>}
              <span><strong>{asset?.name || (assetsScope === "connected" ? "选择已连接资产" : "选择画布资产")}</strong><small>{asset ? "已引用 · 保留原资产" : "人物、服装、场景或道具"}</small></span><ChevronDown size={13} />
            </button>
          </section>; })}
          <button className="redraw-add-mapping" onClick={() => change({ mappings: [...draft.mappings, { id: crypto.randomUUID(), kind: "prop", source: "原片道具", assetId: "" }] })}><Plus size={15} />添加替换对象</button>
          <div className="redraw-tip"><Link2 size={15} /><p>引用画布里的同一份资产。服装或状态不同，可以选择对应的资产版本。</p></div>
        </div> : <div className="redraw-asset-body" role="tabpanel" aria-label="整体画风"><div className="redraw-section-heading"><h2>统一全片质感</h2></div><p className="redraw-muted">不改变故事，只调整画面表达。</p>{REDRAW_STYLES.map(style => <button className={`redraw-style ${draft.style === style.id ? "selected" : ""}`} key={style.id} onClick={() => change({ style: style.id })}><span className={`redraw-style-swatch ${style.id}`}><Palette size={20} /></span><span><strong>{style.name}</strong><small>{style.description}</small></span>{draft.style === style.id && <Check size={16} />}</button>)}</div>}
      </aside>
      <main className="redraw-viewer">
        <div className="redraw-viewer-heading"><span><Clapperboard size={16} /><strong>{current.title}</strong><small>{redrawTime(current.start)} — {redrawTime(current.end)}</small></span><button aria-pressed={compare} onClick={() => setCompare(!compare)}><Layers3 size={14} />{compare ? "双屏对照" : "只看原片"}</button></div>
        <div className={`redraw-previews ${compare ? "" : "single"}`}>
          <section className="redraw-preview"><div className="redraw-preview-label"><span>原片</span><small>动作与镜头参考</small></div><ReferencePreviewVideo ref={video} src={source.url} poster={source.poster} playsInline preload="metadata" onLoadedMetadata={event => { const v = event.currentTarget; if (Number.isFinite(v.duration)) setDuration(v.duration); }} onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); result.current?.pause(); }} onEnded={() => { setPlaying(false); result.current?.pause(); }} onTimeUpdate={event => { const t = event.currentTarget.currentTime; setTime(t); if (result.current && Math.abs(result.current.currentTime - t) > .25) result.current.currentTime = t; }} /><button className="redraw-video-play" aria-label={playing ? "暂停原片" : "播放原片"} onClick={() => void togglePlayback()}>{playing ? <Pause /> : <Play />}</button></section>
          {compare && <section className="redraw-preview redraw-result"><div className="redraw-preview-label"><span>转绘结果</span><small>{resultUrl ? "实际生成版本" : "等待生成"}</small></div>{resultUrl ? <ReferencePreviewVideo ref={result} src={resultUrl} muted preload="metadata" playsInline /> : <div className="redraw-result-empty"><span className="redraw-empty-icon"><Clapperboard size={29} /></span><h3>你的新故事，从这里开始</h3><p>配置好替换对象与保留项，<br />再创建转绘节点。</p><div className="redraw-result-tags">{draft.mappings.filter(item => item.assetId).map(item => <span key={item.id}>{selectedAssets.get(item.assetId)?.name}</span>)}{draft.style !== "original" && <span>{REDRAW_STYLES.find(item => item.id === draft.style)?.name}</span>}</div></div>}</section>}
        </div>
        <div className="redraw-playbar"><button className="redraw-icon-button" aria-label={playing ? "暂停对照播放" : "开始对照播放"} onClick={() => void togglePlayback()}>{playing ? <Pause size={16} /> : <Play size={16} />}</button><span>{redrawTime(time)} <i>/ {redrawTime(duration)}</i></span><input type="range" aria-label="播放进度" min={0} max={duration || 1} step={.04} value={Math.min(time, duration)} onChange={event => seek(Number(event.target.value))} /><Volume2 size={15} /><span className="redraw-sync">原片原速</span></div>
        <div className="redraw-shot-note"><span className="redraw-note-index">{String(selectedShot + 1).padStart(2, "0")}</span><p>{current.description || "原片镜头。可在右侧补充希望修改的内容。"}</p></div>
        <div className="redraw-timeline"><div className="redraw-timeline-heading"><h2><Film size={14} />原片镜头</h2><span>{source.shots.length ? `${shots.length} 个镜头 · 点击定位` : "整段编辑 · 未拆镜"}</span></div><div className="redraw-filmstrip">{shots.map((shot, index) => <button className={index === selectedShot ? "selected" : ""} key={shot.id} aria-label={`定位${shot.title}`} aria-pressed={index === selectedShot} onClick={() => { setSelectedShot(index); seek(shot.start); }}><div>{(shot.poster || source.poster) ? <ReferencePreviewImage src={shot.poster || source.poster!} alt="" /> : <Film size={23} />}<b>{String(index + 1).padStart(2, "0")}</b><small>{Math.max(0, shot.end - shot.start).toFixed(1)}s</small></div><span>{shot.title}</span><em>{redrawTime(shot.start)}</em></button>)}</div></div>
      </main>
      <aside className="redraw-controls"><h2><SlidersHorizontal size={15} />转绘要求</h2><section><div className="redraw-section-heading"><h3>原片保留项</h3><span>全片生效</span></div>{([ ["action", "动作与表演", "动作起落、肢体轨迹与姿态"], ["camera", "机位与运镜", "景别、角度、镜头运动"], ["cuts", "切点与节奏", "镜头顺序与原片时长"], ["audio", "原声音轨", "对白、音乐与环境音"] ] as const).map(([key, label, help]) => <label className="redraw-preserve" key={key}><span><strong>{label}</strong><small>{help}</small></span><input type="checkbox" checked={draft.preserve[key]} onChange={event => change({ preserve: { ...draft.preserve, [key]: event.target.checked } })} /></label>)}<p className="redraw-muted redraw-preserve-note">保留项作为编辑要求提交，实际效果以生成结果为准。</p></section>
        <section><label className="redraw-field-label" htmlFor="redraw-instruction">补充修改要求</label><textarea id="redraw-instruction" placeholder="例如：反击者换成女主，受击者换成小黑。保留全部动作和倒下过程。" value={draft.instruction} onChange={event => change({ instruction: event.target.value })} /><small className="redraw-muted">仅描述需要修改的内容，原片保持不变。</small></section>
        <section><label className="redraw-field-label" htmlFor="redraw-model">原片编辑模型</label><select id="redraw-model" value={draft.modelId} onChange={event => change({ modelId: event.target.value })}><option value="">选择编辑模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select><p className="redraw-muted">仅列出支持原片编辑的模型，不自动切换为提示词重生成。</p></section>
        <div className="redraw-summary"><span><Film size={15} />本次编辑范围</span><strong>完整原片 · {redrawTime(duration)}</strong><small>生成后另存为新节点，原片保留。</small></div>
      </aside>
    </div>
    <footer className="redraw-footer"><div aria-live="polite" className={error ? "redraw-feedback is-error" : "redraw-feedback"}>{error || message || <><span className="redraw-status-dot" />配置阶段 · 尚未提交生成</>}</div><div><button className="redraw-secondary" disabled={busy} onClick={() => void commit(false)}><Save size={15} />保存配置</button><button className="redraw-primary" disabled={busy} onClick={() => void commit(true)}>{busy ? "正在保存…" : editing ? "更新转绘节点" : "创建转绘节点"}<ArrowRight size={16} /></button></div></footer>
    {picker && <div className="redraw-picker"><header><h2>选择替换资产</h2><button className="redraw-icon-button" aria-label="关闭资产选择" onClick={() => setPicker(null)}><X size={18} /></button></header><input aria-label="搜索画布资产" placeholder="搜索名称、服装或状态" value={search} onChange={event => setSearch(event.target.value)} autoFocus /><p className="redraw-muted">{assetsScope === "connected" ? "仅显示连入此转绘节点的图片；需要其他参考时先在画布连线。" : "引用当前画布的图片资产，不重复上传。"}</p><div className="redraw-picker-grid">{assets.filter(asset => asset.name.toLowerCase().includes(search.toLowerCase())).map(asset => <button key={asset.id} onClick={() => { change({ mappings: draft.mappings.map(item => item.id === picker ? { ...item, assetId: asset.id } : item) }); setPicker(null); }}><ReferencePreviewImage src={asset.imageUrl} alt="" /><strong>{asset.name}</strong></button>)}</div>{!assets.length && <div className="redraw-picker-empty"><ImageIcon size={30} /><p>{assetsScope === "connected" ? "转绘节点尚未连接图片参考。" : "画布中还没有图片资产。"}</p><p>先把人物、场景或道具图片连入转绘节点，再回来选择。</p></div>}<button className="redraw-clear-choice" onClick={() => { change({ mappings: draft.mappings.map(item => item.id === picker ? { ...item, assetId: "" } : item) }); setPicker(null); }}>保留原片对象，不替换</button></div>}
  </dialog>, document.body);
}
