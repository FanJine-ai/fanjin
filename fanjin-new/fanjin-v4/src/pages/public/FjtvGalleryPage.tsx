import { useV4Theme } from "../../ui/useV4Theme";
import { V4ThemeToggle } from "../../ui/V4ThemeToggle";
import "../frontstage/FrontstagePage.css";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Play } from "lucide-react";

import { toApiErrorView } from "@/api/http";
import fanjinLogo from "@/assets/fanjin-logo-fj.svg";
import { api, type FjtvPublicationRecord } from "@/lib/api";

export default function FjtvGalleryPage() {
  const theme = useV4Theme();
  const [items, setItems] = useState<FjtvPublicationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.listPublicFjtv(48).then((result) => {
      if (!cancelled) setItems(result.publications || []);
    }).catch((reason) => {
      if (!cancelled) setError(toApiErrorView(reason).message || "FJTV 加载失败");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="frontPagePalette publicShowcase" data-theme={theme.mode}>
      <header className="flex h-20 items-center justify-between border-b border-[var(--front-line)] px-6 md:px-10">
        <Link to="/" className="flex items-center gap-3 text-lg font-semibold"><img src={fanjinLogo} alt="繁境" className="h-9 w-9 publicShowcaseLogo" />FJTV</Link>
        <div className="publicShowcaseActions"><V4ThemeToggle mode={theme.mode} onToggle={theme.toggle} /><Link to="/workbench/create" className="rounded-full border border-[var(--front-line)] px-5 py-2 text-sm hover:bg-white/10">进入创作台</Link></div>
      </header>
      <section className="mx-auto max-w-[1500px] px-6 py-12 md:px-10">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--front-accent)]">Fanjin creator television</p>
        <h1 className="mt-3 text-4xl font-bold">发现好作品</h1>
        <p className="mt-3 text-[var(--front-muted)]">探索创作者的灵感、画面与故事。</p>
        {loading ? <div className="mt-12 text-[var(--front-muted)]">正在加载…</div> : null}
        {error ? <div role="alert" className="mt-12 rounded-2xl border border-red-400/30 bg-red-400/10 p-6 text-red-200">{error}</div> : null}
        {!loading && !error ? (
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((item) => (
              <Link key={item.id} to={`/fjtv/${item.slug}`} className="group overflow-hidden rounded-2xl border border-[var(--front-line)] bg-[var(--front-surface)] transition hover:-translate-y-1 hover:border-sky-300/50">
                <div className="relative aspect-video bg-[var(--front-soft)]">
                  {item.coverUrl ? <img src={item.coverUrl} alt={item.title} className="h-full w-full object-cover" /> : null}
                  <span className="absolute inset-0 flex items-center justify-center"><span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55"><Play className="ml-0.5 h-5 w-5" /></span></span>
                </div>
                <div className="p-5">
                  <h2 className="truncate text-lg font-semibold">{item.title}</h2>
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-[var(--front-muted)]">{item.description || `画布版本 v${item.snapshotRevision}`}</p>
                </div>
              </Link>
            ))}
            {!items.length ? <div className="col-span-full rounded-2xl border border-[var(--front-line)] bg-[var(--front-surface)] min-h-60 content-center p-12 text-center text-[var(--front-muted)]">暂时还没有公开作品</div> : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
