import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpenText,
  Braces,
  Command,
  ChevronDown,
  FileText,
  Plug,
  ShieldCheck,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import PublicSiteHeader from "../../components/PublicSiteHeader";
import { useV4Theme } from "../../ui/useV4Theme";
import "./PublicDocsShell.css";

export type PublicDocsTocItem = readonly [string, string];

type PublicDocsShellProps = {
  children: ReactNode;
  toc?: readonly PublicDocsTocItem[];
  tocLabel?: string;
};

const docsNavigation = [
  {
    label: "产品说明",
    items: [
      { label: "文档首页", to: "/docs", icon: BookOpenText },
      { label: "用户说明", to: "/docs/user-guide", icon: BookOpenText },
    ],
  },
  {
    label: "法律与合规",
    items: [
      { label: "用户协议", to: "/docs/legal/terms", icon: FileText },
      { label: "隐私政策", to: "/docs/legal/privacy", icon: ShieldCheck },
    ],
  },
  {
    label: "开发者资源",
    items: [
      { label: "API 文档", to: "/docs/api", icon: Braces },
      { label: "MCP 集成", to: "/docs/mcp", icon: Plug },
      { label: "CLI 使用指南", to: "/docs/cli", icon: Command },
    ],
  },
] as const;

function isActivePath(pathname: string, target: string) {
  if (target === "/docs") return pathname === target;
  return pathname === target || pathname.replace(/^\/legal\//, "/docs/legal/") === target;
}

export default function PublicDocsShell({
  children,
  toc,
  tocLabel = "本页目录",
}: PublicDocsShellProps) {
  const location = useLocation();
  const theme = useV4Theme();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("");
  const sectionIds = toc?.map(([id]) => id).join("|") ?? "";
  const currentPage = docsNavigation.flatMap((group) => [...group.items])
    .find((item) => isActivePath(location.pathname, item.to))?.label ?? "文档";

  useEffect(() => { setNavigationOpen(false); }, [location.pathname]);

  useEffect(() => {
    const sections = sectionIds.split("|").filter(Boolean)
      .map((id) => document.getElementById(id)).filter((section): section is HTMLElement => Boolean(section));
    if (!sections.length) return;
    let frame = 0;
    function update() {
      const header = document.querySelector(".publicSiteHeader");
      const offset = (header?.getBoundingClientRect().bottom ?? 66) + 48;
      let current = sections[0].id;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= offset) current = section.id;
      }
      setActiveSection(current);
      frame = 0;
    }
    function scheduleUpdate() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    scheduleUpdate();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [location.pathname, sectionIds]);

  useEffect(() => {
    if (!location.hash) return;
    const frame = requestAnimationFrame(() => {
      let id: string;
      try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, location.hash]);

  return (
    <main className="publicDocsPage" data-theme={theme.mode}>
      <PublicSiteHeader />

      <div className={`publicDocsLayout ${toc?.length ? "publicDocsLayoutWithToc" : ""}`}>
        <aside className="publicDocsSidebar" data-open={navigationOpen}>
          <button className="publicDocsNavToggle" type="button" aria-expanded={navigationOpen} aria-controls="public-docs-navigation" onClick={() => setNavigationOpen((open) => !open)}>
            <BookOpenText size={16} aria-hidden="true" />
            <span>文档导航 <span>{currentPage}</span></span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          <nav id="public-docs-navigation" aria-label="文档导航">
            {docsNavigation.map((group) => (
              <section key={group.label} className="publicDocsNavGroup">
                <strong>{group.label}</strong>
                <div>
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.label}
                        onClick={() => setNavigationOpen(false)}
                        className={isActivePath(location.pathname, item.to) ? "is-active" : ""}
                        aria-current={isActivePath(location.pathname, item.to) ? "page" : undefined}
                        to={item.to}
                      >
                        <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </nav>
          <p className="publicDocsSidebarNote">
            面向用户、团队与开发者的公开资料。
          </p>
        </aside>

        <div className="publicDocsContent">
          {children}
        </div>

        {toc?.length ? (
          <aside className="publicDocsToc">
            <strong>{tocLabel}</strong>
            <nav aria-label={tocLabel}>
              {toc.map(([id, label]) => <Link key={id} aria-current={activeSection === id ? "location" : undefined} to={{ pathname: location.pathname, search: location.search, hash: `#${id}` }} onClick={() => document.getElementById(id)?.scrollIntoView({ block: "start" })}>{label}</Link>)}
            </nav>
          </aside>
        ) : null}
      </div>
    </main>
  );
}
