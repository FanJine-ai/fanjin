import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronDown, Clapperboard, Play, RotateCcw, Search } from "lucide-react";
import { Dialog } from "../../ui/console/overlays";
import { buildCreativeBrief, caseKindLabels, showcaseCases, type InspirationCase, type SourceReference } from "./catalog";
import "./InspirationShowcase.css";

const categories = ["全部", ...new Set(showcaseCases.map((item) => item.category))];
const kinds = ["all", "skill", "shot", "watch"] as const;
const workTitles = ["全部", "别小看TA", "追风"];
const PAGE_SIZE = 12;
function durationLabel(seconds: number) {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

type Props = {
  dark: boolean;
  onUseBrief?: (brief: string) => void;
  onUseSource?: (item: InspirationCase, idea: string) => Promise<void>;
  hasDraft?: boolean;
  useDisabled?: boolean;
  guest?: boolean;
};

export default function InspirationShowcase({ dark, onUseBrief, onUseSource, hasDraft = false, useDisabled = false, guest = false }: Props) {
  const [kind, setKind] = useState<(typeof kinds)[number]>("all");
  const [category, setCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<InspirationCase | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [referencePreview, setReferencePreview] = useState<SourceReference | null>(null);
  const [fullFilm, setFullFilm] = useState(false);
  const [idea, setIdea] = useState("");
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const descriptionId = useId();
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 760px)").matches));
  const pendingBriefRef = useRef<string | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
  const [playbackError, setPlaybackError] = useState(false);
  const [retry, setRetry] = useState(0);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const filtered = useMemo(() => showcaseCases.filter(item => (
    (kind === "all" || item.kind === kind)
    && (category === "全部" || (kind === "shot" ? item.workTitle === category : item.category === category))
    && `${item.title} ${item.description} ${item.source} ${item.kind === "shot" ? `${item.workTitle} 火山 Seedance` : ""}`.toLowerCase().includes(query.trim().toLowerCase())
  )), [kind, category, query]);
  const clip = fullFilm && selected?.original ? { ...selected.original.film, poster: selected.original.clip.poster } : selected?.videos[clipIndex];
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 760px)");
    if (!media) return;
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    return () => { video?.pause(); };
  }, [clip?.src, playbackError, retry]);
  useEffect(() => {
    if (selected || !pendingBriefRef.current) return;
    const brief = pendingBriefRef.current;
    // Wait for the dialog to release its focus trap before focusing the composer.
    const frame = requestAnimationFrame(() => {
      pendingBriefRef.current = null;
      onUseBrief?.(brief);
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, onUseBrief]);

  async function useGuide() {
    if (selected?.original && onUseSource) {
      if (sourceBusy || useDisabled) return;
      setSourceBusy(true); setSourceError("");
      try { await onUseSource(selected, idea); setSelected(null); }
      catch (error) { setSourceError(error instanceof Error ? error.message : "素材带入失败，请重试"); }
      finally { setSourceBusy(false); }
      return;
    }
    if (!selected?.template || selected.original || !onUseBrief || useDisabled) return;
    pendingBriefRef.current = buildCreativeBrief(selected, idea);
    setSelected(null);
  }

  const inlineAction = Boolean(selected?.videos.length && selected.template && !selected.original && !compact);
  const guideAction = selected?.template && (selected.original ? onUseSource : onUseBrief) ? <div className="inspirationGuideFooter"><p>{sourceBusy ? "正在准备原始素材…" : selected?.original ? "原始提示词与全部参考素材一起带入；保留已有内容" : useDisabled ? "正在准备创作区，请稍候…" : hasDraft ? "将追加到当前想法，保留已有内容与参考素材" : "带入后可继续编辑，再和 Agent 一起完善"}</p><button type="button" disabled={useDisabled || sourceBusy} onClick={() => void useGuide()}>{sourceBusy ? "正在带入…" : selected?.original ? (guest ? "登录后带入全部素材" : "带入同款素材") : guest ? "带入想法" : "带入创作台"}<ArrowRight size={16} aria-hidden="true" /></button></div> : undefined;

  return (
    <section className="inspirationShowcase" aria-labelledby="inspiration-showcase-title">
      <header className="inspirationShowcaseHeader">
        <div><h2 id="inspiration-showcase-title">创作案例</h2><p>看作品，找方法，把灵感变成自己的创作</p></div>
        <span className="inspirationShowcaseSource">即梦 · 火山方舟</span>
      </header>
      <div className="inspirationShowcaseCollections" role="group" aria-label="案例用途">
        {kinds.map(value => (
          <button type="button" key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setCategory("全部"); setVisibleCount(PAGE_SIZE); }}>
            {value === "all" ? "全部案例" : caseKindLabels[value]} <span>{value === "all" ? showcaseCases.length : showcaseCases.filter(item => item.kind === value).length}</span>
          </button>
        ))}
      </div>
      <div className="inspirationShowcaseToolbar">
        <div className="inspirationShowcaseFilters" role="group" aria-label={kind === "shot" ? "案例影片" : "案例分类"}>
          {(kind === "shot" ? workTitles : categories).map(value => <button key={value} type="button" aria-pressed={category === value} onClick={() => { setCategory(value); setVisibleCount(PAGE_SIZE); }}>{value}</button>)}
        </div>
        <label className="inspirationShowcaseSearch"><Search size={15} aria-hidden="true" /><input aria-label="搜索创作案例" placeholder="搜索题材、案例" value={query} onChange={event => { setQuery(event.target.value); setVisibleCount(PAGE_SIZE); }} /></label>
      </div>
      {kind === "shot" ? <p className="inspirationShowcaseCollectionNote">《别小看TA》10 个片段 ·《追风》7 个片段。原片、参考图片、音频、原始提示词与生成参数，按镜头对应整理。</p> : null}
      <div className="inspirationShowcaseGrid">
        {filtered.slice(0, visibleCount).map(item => (
          <button key={item.id} className="inspirationShowcaseCard" type="button" aria-label={`${item.videos.length ? "播放案例" : "查看镜头模板"}：${item.title}`} onClick={event => {
            returnFocusRef.current = event.currentTarget; setIdea(""); setSourceError(""); setFullFilm(false); setDescriptionExpanded(false); setClipIndex(0); setPlaybackError(false); setSelected(item);
          }}>
            <span className={`inspirationShowcaseCover ${item.kind === "shot" ? "inspirationShotCover" : ""}`}>
              {item.videos.length ? <>
                <img src={item.videos[0].poster} loading="lazy" decoding="async" alt="" width={640} height={400} />
                <span className="inspirationShowcasePlay" aria-hidden="true"><Play size={20} fill="currentColor" /></span>
                <span className="inspirationShowcaseDuration">{item.videos.length > 1 ? `${item.videos.length} 段 · ` : ""}{durationLabel(item.videos[0].duration)}</span>
              </> : <>
                <span className="inspirationShotWork"><Clapperboard size={16} />{item.workTitle}</span>
                <span className="inspirationShotNumber">{String(item.segment).padStart(2, "0")}</span>
                <span className="inspirationShotParams">{item.template?.parameters?.model} · {item.template?.parameters?.resolution} · {item.template?.parameters?.ratio}</span>
              </>}
              <span className="inspirationShowcaseBadge">{caseKindLabels[item.kind]}</span>
            </span>
            <span className="inspirationShowcaseTitle">{item.title}</span>
            <span className="inspirationShowcaseMeta"><span>{item.kind === "shot" ? `成片位置 ${item.timecode}` : `@${item.author}`}</span><span>{item.category}</span></span>
          </button>
        ))}
      </div>
      <div className="inspirationShowcaseBottom">
        {!filtered.length ? <div><p>没有找到对应案例</p><button type="button" className="inspirationShowcaseMore" onClick={() => { setQuery(""); setCategory("全部"); setKind("all"); }}>清除筛选</button></div> : visibleCount < filtered.length ? <button type="button" className="inspirationShowcaseMore" onClick={() => setVisibleCount(count => count + PAGE_SIZE)}>查看更多案例 <ChevronDown size={16} /></button> : <span>已展示全部 {filtered.length} 个案例</span>}
      </div>
      <Dialog open={Boolean(selected)} title={selected?.title || "案例详情"}
        description={selected ? <span className="inspirationCaseHeadingMeta"><span>{caseKindLabels[selected.kind]}</span><span>{selected.category}</span></span> : undefined}
        className={`inspirationShowcasePlayer ${dark ? "themeDark" : "themeLight"}`}
        contentClassName="inspirationShowcasePlayerBody" size="xl" closeLabel="关闭案例"
        returnFocusRef={returnFocusRef} onOpenChange={open => { if (!open && !sourceBusy) setSelected(null); }}
        footer={inlineAction ? undefined : guideAction}
      >
        {selected ? <div className={`inspirationCaseDetail ${selected.videos.length && selected.template ? "hasGuide" : ""}`}>
          <div className="inspirationCaseOverview">
            {clip ? <>
              <div className="inspirationShowcaseVideoStage">
                {playbackError ? <div className="inspirationShowcaseVideoError" role="alert"><p>暂时无法播放这段案例</p><button type="button" onClick={() => { setPlaybackError(false); setRetry(value => value + 1); }}><RotateCcw size={16} />重新播放</button></div> : <video ref={videoRef} key={`${clip.src}-${retry}`} src={clip.src} poster={clip.poster} aria-label={selected.title} controls autoPlay={!referencePreview} playsInline preload="metadata" onError={() => setPlaybackError(true)} />}
              </div>
              {selected.original ? <div className="inspirationShowcaseClips" role="group" aria-label="播放范围"><button type="button" aria-pressed={!fullFilm} onClick={() => { setFullFilm(false); setPlaybackError(false); }}>镜头片段 · {durationLabel(selected.original.clip.duration)}</button><button type="button" aria-pressed={fullFilm} onClick={() => { setFullFilm(true); setPlaybackError(false); }}>完整影片 · {durationLabel(selected.original.film.duration)}</button><span>成片位置 {selected.timecode}</span></div> : null}
              {selected.videos.length > 1 ? <div className="inspirationShowcaseClips" role="group" aria-label="切换案例片段">{selected.videos.map((video, index) => <button key={video.src} type="button" aria-pressed={clipIndex === index} onClick={() => { setClipIndex(index); setPlaybackError(false); }}>片段 {index + 1} · {durationLabel(video.duration)}</button>)}</div> : null}
            </> : <div className="inspirationShotIntro"><Clapperboard size={24} /><span>《{selected.workTitle}》· 开放片段 {String(selected.segment).padStart(2, "0")}</span><small>成片位置 {selected.timecode}</small></div>}
            {selected.original ? <section className="inspirationSourceAssets" aria-label="原始参考素材"><h3>原始参考素材 <small>{selected.original.references.length} 份 · 点击预览</small></h3><div className="inspirationSourceAssetGrid">{selected.original.references.map(ref => <button key={ref.id} type="button" onClick={() => { videoRef.current?.pause(); setReferencePreview(ref); }} aria-label={`预览${ref.label}`}>
              {ref.kind === "image" ? <img src={ref.src} alt="" loading="lazy" /> : <span className="inspirationSourceMediaIcon">{ref.kind === "audio" ? "♫" : <Play size={22} />}</span>}<span>{ref.label}</span></button>)}</div></section> : null}
            <div className="inspirationCaseDescription">
              <small className="inspirationCaseAttribution">{selected.source} <span aria-hidden="true">·</span> {selected.author}</small>
              <p id={descriptionId} className={`inspirationCaseSynopsis ${selected.description.length > 110 && !descriptionExpanded ? "isCollapsed" : ""}`}>{selected.description}</p>
              {selected.description.length > 110 ? <button className="inspirationCaseReadMore" type="button" aria-expanded={descriptionExpanded} aria-controls={descriptionId} onClick={() => setDescriptionExpanded(value => !value)}>{descriptionExpanded ? "收起介绍" : "展开介绍"}<ChevronDown size={13} aria-hidden="true" /></button> : null}
              {selected.kind === "watch" ? <p className="inspirationCaseBoundary">此案例仅有作品说明，未提供技能指令或创作模板。</p> : selected.kind === "skill" ? <p className="inspirationCaseBoundary">依据技能说明与流程整理，不是示例视频的原始提示词。</p> : <p className="inspirationCaseBoundary">已包含原站公开的原片、提示词及全部参考素材。相同素材与参数可以复用，重新生成的画面仍会有差异。</p>}
            </div>
          </div>
          {selected.template ? <div className="inspirationCaseGuide">
            {selected.template.parameters ? <div className="inspirationGuideParameters" aria-label="原站生成参数"><span>{selected.template.parameters.model}</span><span>{selected.template.parameters.resolution}</span><span>{selected.template.parameters.ratio}</span><span>生成 {selected.template.parameters.duration} 秒</span><span>{selected.template.parameters.mode}</span></div> : null}
            {selected.original ? <section className="inspirationOriginalPrompt"><h3>原始提示词 <small>火山方舟公开版本</small></h3><textarea aria-label="原始提示词" readOnly value={selected.original.prompt} /><p>{selected.original.options.durationMode === "auto" ? `原站自动时长，参数值 ${selected.original.options.duration} 秒` : `固定时长 ${selected.original.options.duration} 秒`} · {selected.original.options.generateAudio ? "同步生成音频" : "无生成音频"}</p><a href={`/showcase/ark/${selected.id}.zip`} download>下载完整素材包</a><small className="inspirationSourceDownloadHint">参考素材、原始提示词、参数与镜头片段</small></section> : <><div className="inspirationGuideSection"><h3>创作准备</h3><ul className="inspirationGuideInputs">{selected.template.inputs.map(input => <li key={input}>{input}</li>)}</ul></div>
            <div className="inspirationGuideSection"><h3>创作指引 <small>整理版 · 可调整</small></h3><ol className="inspirationGuideSteps" role="list">{selected.template.steps.map((step, index) => <li key={step} role="listitem"><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><p>{step}</p></li>)}</ol></div>
            {selected.template.notes?.map(note => <p className="inspirationGuideNote" key={note}>{note}</p>)}
            </>}
            {sourceError ? <p className="inspirationSourceError" role="alert">{sourceError}</p> : null}
            {(onUseBrief || onUseSource) ? <label className="inspirationGuideIdea"><span>加入你的想法 <small>选填</small></span><textarea aria-label="模板创作想法" value={idea} onChange={event => setIdea(event.target.value)} placeholder="想用它创作什么？写下人物、产品或故事…" rows={3} maxLength={4000} /></label> : null}
            {inlineAction ? guideAction : null}
          </div> : null}
        </div> : null}
      </Dialog>
      <Dialog open={Boolean(referencePreview)} title={referencePreview?.label || "参考素材"} closeLabel="关闭素材预览" size="lg" className={`inspirationSourcePreview ${dark ? "themeDark" : "themeLight"}`} onOpenChange={open => { if (!open) setReferencePreview(null); }}>
        {referencePreview ? <><div className="inspirationSourcePreviewMedia">{referencePreview.kind === "image" ? <img src={referencePreview.src} alt={referencePreview.label} /> : referencePreview.kind === "audio" ? <audio src={referencePreview.src} aria-label={referencePreview.label} controls autoPlay /> : <video src={referencePreview.src} aria-label={referencePreview.label} controls autoPlay playsInline />}</div><a href={referencePreview.src} download={`${referencePreview.label}.${referencePreview.src.split(".").pop()}`}>下载{referencePreview.label}</a></> : null}
      </Dialog>
    </section>
  );
}
