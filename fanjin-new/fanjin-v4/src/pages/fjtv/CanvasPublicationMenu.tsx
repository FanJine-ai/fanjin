import type { RefObject } from "react";
import { ExternalLink, Link2 } from "lucide-react";

type Publication = { id: string; status: string; snapshotRevision: number; slug: string };
type Share = { id: string; snapshotRevision: number; slug: string };

export function CanvasPublicationMenu({ popoverRef, publicationError, publicationBusy, canPublish, canShare, submitPublication, createShare, publications, statusLabel, publicUrl, loading, shares, copyShare, revokeShare }: {
  popoverRef: RefObject<HTMLDivElement | null>;
  publicationError?: string | null;
  publicationBusy: string | null;
  canPublish: boolean;
  canShare: boolean;
  submitPublication: () => void;
  createShare: () => void;
  publications: Publication[];
  statusLabel: (status: string) => string;
  publicUrl: (slug: string) => string;
  loading: boolean;
  shares: Share[];
  copyShare: (share: Share) => void;
  revokeShare: (share: Share) => void;
}) {
  return <div ref={popoverRef} id="canvas-share-popover" data-canvas-popover role="dialog" aria-labelledby="canvas-share-popover-title" tabIndex={-1} className="absolute right-[188px] top-[104px] z-[95] w-[592px] rounded-[22px] border border-white/10 bg-[#282828] p-6 text-white shadow-[0_26px_70px_rgba(0,0,0,0.52)]" onMouseDown={(event) => event.stopPropagation()}>
    <div id="canvas-share-popover-title" data-canvas-muted className="mb-6 text-[24px] font-semibold text-white/62">发布与分享</div>
    {publicationError ? <div data-canvas-alert role="alert" className="mb-4 rounded-[12px] border border-[#7f3c3c] bg-[#3b2424] px-4 py-3 text-[14px] text-[#ffb4b4]">{publicationError}</div> : null}
    <button type="button" data-testid="fjtv-publish-action" disabled={!canPublish || publicationBusy !== null} onClick={submitPublication} className="flex w-full items-center gap-5 rounded-[18px] p-3 text-left hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-45"><span data-canvas-surface className="flex h-[66px] w-[66px] shrink-0 items-center justify-center rounded-[12px] bg-[#555] text-white"><ExternalLink className="h-7 w-7" /></span><span><span className="block text-[24px] font-semibold">{publicationBusy === "fjtv" ? "正在提交…" : "投稿到 FJTV"}</span><span data-canvas-muted className="mt-1 block text-[18px] text-[#c9c9c9]">生成不可变画布快照，平台审核通过后才会公开。</span></span></button>
    {publications.length ? <div data-canvas-muted className="ml-[86px] mt-1 space-y-2 text-[13px] text-[#bdbdbd]">{publications.slice(0, 3).map((publication) => <div key={publication.id} className="flex items-center justify-between gap-3"><span>{statusLabel(publication.status)} · 画布 v{publication.snapshotRevision}</span>{publication.status === "published" ? <a data-canvas-link className="text-[#74dbff] hover:underline" href={publicUrl(publication.slug)} target="_blank" rel="noreferrer">查看</a> : null}</div>)}</div> : null}
    <button type="button" data-testid="fjtv-share-action" disabled={!canShare || publicationBusy !== null} onClick={createShare} className="mt-5 flex w-full items-center gap-5 rounded-[18px] p-3 text-left hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-45"><span data-canvas-surface className="flex h-[66px] w-[66px] shrink-0 items-center justify-center rounded-[12px] bg-[#555] text-white"><Link2 className="h-7 w-7" /></span><span><span className="block text-[24px] font-semibold">{publicationBusy === "share" ? "正在创建…" : "创建只读分享链接"}</span><span data-canvas-muted className="mt-1 block text-[18px] text-[#c9c9c9]">分享当前服务器版本；后续编辑不会悄悄改变已分享内容。</span></span></button>
    <div data-canvas-muted className="ml-[86px] mt-1 max-h-[132px] space-y-2 overflow-y-auto text-[13px] text-[#bdbdbd]">{loading ? <div>正在加载分享状态…</div> : null}{shares.map((share) => <div key={share.id} className="flex items-center justify-between gap-3"><button type="button" data-canvas-link className="min-w-0 truncate text-left text-[#74dbff] hover:underline" onClick={() => copyShare(share)}>复制 v{share.snapshotRevision} 分享链接</button><button type="button" disabled={publicationBusy !== null} data-canvas-danger className="shrink-0 text-[#ffaaa0] hover:underline disabled:opacity-40" onClick={() => revokeShare(share)}>撤销</button></div>)}</div>
  </div>;
}
