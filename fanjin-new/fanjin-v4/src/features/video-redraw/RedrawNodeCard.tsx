import { Film, Link2, Palette } from "lucide-react";
import ReferencePreviewImage from "../quick-create/attachments/ReferencePreviewImage";
import type { RedrawAsset } from "./redrawDraft";
import "./RedrawNodeCard.css";
export function RedrawNodeCard({ sourceTitle, assets, error, dark, onConfigure }: {
  sourceTitle?: string; assets: RedrawAsset[]; error?: string; dark?: boolean; onConfigure: () => void;
}) {
  return <div className="redraw-node-card" data-video-redraw-node data-theme={dark ? "dark" : "light"}>
    <header><Palette size={17}/><strong>转绘节点</strong><span>原片编辑</span></header>
    <div className="redraw-node-source"><Film size={15}/><span>{sourceTitle || "连接一段原片视频"}</span></div>
    <div className="redraw-node-inputs">{assets.length ? <><div>{assets.slice(0,3).map(asset=><ReferencePreviewImage key={asset.id} src={asset.imageUrl} alt={asset.name}/>)}</div><span>{assets.length} 个参考节点已连接<br/><small>人物 · 场景 · 道具，分别指定用途</small></span></> : <p><Link2 size={15}/>可连接多个人物、场景和道具图片节点</p>}</div>
    <p className={`redraw-node-note ${error ? "needs-input" : ""}`}>{error || "编辑结果另存，原片与参考素材保留。"}</p>
    <button type="button" onMouseDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onConfigure();}}>配置替换关系</button>
  </div>;
}
