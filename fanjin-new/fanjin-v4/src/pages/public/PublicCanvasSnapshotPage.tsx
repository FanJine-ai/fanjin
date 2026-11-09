import { useV4Theme } from "../../ui/useV4Theme";
import { V4ThemeToggle } from "../../ui/V4ThemeToggle";
import "../frontstage/FrontstagePage.css";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Play, Video } from "lucide-react";

import { api } from "@/lib/api";
import { toApiErrorView } from "@/api/http";
import fanjinLogo from "@/assets/fanjin-logo-fj.svg";

type PublicNode = {
  id: string;
  type: "image" | "video" | "audio" | "text" | "compose" | "script";
  title?: string;
  prompt?: string;
  outputText?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  imageUrl?: string;
  primaryImageUrl?: string;
  generatedImages?: Array<{ url: string }>;
  videoUrl?: string;
  videoPosterUrl?: string;
  audioUrl?: string;
};

type PublicEdge = { id: string; fromNodeId: string; toNodeId: string };
type PublicSnapshot = {
  canvas?: {
    name?: string;
    revision?: number;
    nodes?: PublicNode[];
    edges?: PublicEdge[];
  };
};

function nodeDimensions(node: PublicNode) {
  return {
    x: Number.isFinite(Number(node.x)) ? Number(node.x) : 0,
    y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0,
    width: Math.max(220, Math.min(760, Number(node.width) || 320)),
    height: Math.max(160, Math.min(760, Number(node.height) || 240)),
  };
}

function NodeMedia({ node }: { node: PublicNode }) {
  const imageUrl = node.imageUrl || node.primaryImageUrl || node.generatedImages?.[0]?.url;
  if (node.type === "image" && imageUrl) {
    return <img src={imageUrl} alt={node.title || "画布图片"} className="h-full w-full object-contain" />;
  }
  if ((node.type === "video" || node.type === "compose") && node.videoUrl) {
    return <video controls preload="metadata" poster={node.videoPosterUrl} src={node.videoUrl} className="h-full w-full bg-black object-contain" />;
  }
  if (node.type === "audio" && node.audioUrl) {
    return <audio controls preload="metadata" src={node.audioUrl} className="w-[calc(100%-32px)]" />;
  }
  if (node.type === "text" || node.type === "script") {
    return <div className="h-full overflow-auto whitespace-pre-wrap px-5 py-4 text-[15px] leading-7 text-[var(--front-text)]">{node.outputText || node.prompt || "空文本节点"}</div>;
  }
  const Icon = node.type === "video" ? Video : Play;
  return <div className="flex h-full flex-col items-center justify-center gap-3 text-[var(--front-muted)]"><Icon className="h-10 w-10" /><span>此媒体未包含可公开地址</span></div>;
}

export default function PublicCanvasSnapshotPage({ source }: { source: "share" | "fjtv" }) {
  const theme = useV4Theme();
  const { slug = "" } = useParams();
  const [record, setRecord] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    setLoading(true);
    setError(null);
    setRecord(null);
    const refresh = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const value = source === "share"
          ? (await api.getPublicCanvasShare(slug)).share
          : (await api.getPublicFjtvPublication(slug)).publication;
        if (!cancelled) { setRecord(value); setError(null); }
      } catch (reason) {
        if (!cancelled) {
          setRecord(null);
          setError(toApiErrorView(reason).message || "作品加载失败");
        }
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [slug, source]);

  const snapshot = (record?.snapshot || {}) as PublicSnapshot;
  const nodes = Array.isArray(snapshot.canvas?.nodes) ? snapshot.canvas!.nodes! : [];
  const edges = Array.isArray(snapshot.canvas?.edges) ? snapshot.canvas!.edges! : [];
  const layout = useMemo(() => {
    if (!nodes.length) return { minX: 0, minY: 0, width: 960, height: 600 };
    const dimensions = nodes.map(nodeDimensions);
    const minX = Math.min(...dimensions.map((item) => item.x));
    const minY = Math.min(...dimensions.map((item) => item.y));
    const maxX = Math.max(...dimensions.map((item) => item.x + item.width));
    const maxY = Math.max(...dimensions.map((item) => item.y + item.height));
    return { minX, minY, width: Math.max(960, maxX - minX + 160), height: Math.max(600, maxY - minY + 160) };
  }, [nodes]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  return (
    <main className="frontPagePalette publicShowcase" data-theme={theme.mode}>
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-[var(--front-line)] bg-[var(--front-surface)] px-5 backdrop-blur">
        <Link to={source === "fjtv" ? "/fjtv" : "/"} className="flex items-center gap-3 font-semibold"><ArrowLeft className="h-5 w-5" /><img src={fanjinLogo} alt="繁境" className="h-8 w-8" /><span>繁境</span></Link>
        <div className="publicShowcaseActions"><V4ThemeToggle mode={theme.mode} onToggle={theme.toggle} /><div className="text-sm text-[var(--front-muted)]">只读快照 · v{record?.snapshotRevision || snapshot.canvas?.revision || "-"}</div></div>
      </header>
      <section className="mx-auto max-w-[1800px] px-5 py-8">
        <div className="mb-6">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--front-accent)]">{source === "fjtv" ? "FJTV" : "Canvas Share"}</div>
          <h1 className="mt-2 text-3xl font-bold">{record?.title || snapshot.canvas?.name || "画布作品"}</h1>
          {record?.description ? <p className="mt-3 max-w-3xl text-[var(--front-muted)]">{record.description}</p> : null}
        </div>
        {loading ? <div className="rounded-2xl border border-[var(--front-line)] bg-[var(--front-surface)] p-12 text-center text-[var(--front-muted)]">正在加载作品…</div> : null}
        {error ? <div role="alert" className="rounded-2xl border border-[var(--front-danger-line)] bg-[var(--front-danger-bg)] p-8 text-center text-[var(--front-danger)]">{error}</div> : null}
        {!loading && !error ? (
          <div className="overflow-auto rounded-3xl border border-[var(--front-line)] bg-[var(--front-surface)] shadow-sm">
            <div className="relative bg-[radial-gradient(circle,var(--front-line)_1px,transparent_1px)] [background-size:24px_24px]" style={{ width: nodes.length ? layout.width : "100%", minWidth: "100%", height: layout.height }}>
              <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
                {edges.map((edge) => {
                  const from = byId.get(edge.fromNodeId);
                  const to = byId.get(edge.toNodeId);
                  if (!from || !to) return null;
                  const a = nodeDimensions(from);
                  const b = nodeDimensions(to);
                  const x1 = a.x - layout.minX + 80 + a.width / 2;
                  const y1 = a.y - layout.minY + 80 + a.height / 2;
                  const x2 = b.x - layout.minX + 80 + b.width / 2;
                  const y2 = b.y - layout.minY + 80 + b.height / 2;
                  return <path key={edge.id} d={`M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`} fill="none" stroke="#94a3b8" strokeWidth="2" />;
                })}
              </svg>
              {nodes.map((node) => {
                const box = nodeDimensions(node);
                return (
                  <article key={node.id} className="absolute overflow-hidden rounded-2xl border border-[var(--front-line)] bg-[var(--front-surface)] shadow-[0_12px_40px_rgba(15,23,42,0.12)]" style={{ left: box.x - layout.minX + 80, top: box.y - layout.minY + 80, width: box.width, height: box.height }}>
                    <div className="flex h-10 items-center border-b border-[var(--front-line)] px-4 text-sm font-semibold text-[var(--front-text)]">{node.title || node.type}</div>
                    <div className="flex h-[calc(100%-40px)] items-center justify-center"><NodeMedia node={node} /></div>
                  </article>
                );
              })}
              {!nodes.length ? <div className="flex h-full items-center justify-center text-[var(--front-muted)]">这个快照没有节点</div> : null}
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
