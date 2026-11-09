import { Moon, Sun } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import fanjinLogo from "../assets/fanjin-logo-fj.svg";
import { useAuthStore } from "../stores/authStore";
import { useV4Theme } from "../ui/useV4Theme";
import "./PublicSiteHeader.css";

export default function PublicSiteHeader() {
  const { pathname, search } = useLocation();
  const theme = useV4Theme();
  const authenticated = Boolean(useAuthStore((state) => state.token));
  const pricing = pathname === "/models" && new URLSearchParams(search).get("section") === "pricing";
  const links = [
    { label: "首页", to: "/", active: pathname === "/" },
    { label: "模型广场", to: "/models", active: pathname === "/models" && !pricing },
    { label: "文档", to: "/docs", active: pathname.startsWith("/docs") || pathname.startsWith("/legal/") },
    { label: "价格", to: "/models?section=pricing", active: pricing },
  ];

  return (
    <header className="publicSiteHeader" data-theme={theme.mode}>
      <div className="publicSiteHeaderInner">
        <Link className="publicSiteBrand" to="/" aria-label="返回繁境首页">
          <img src={fanjinLogo} alt="" />
          <span><strong>繁境</strong><small>FANJIN STUDIO</small></span>
        </Link>
        <nav className="publicSiteNav" aria-label="主要导航">
          {links.map(({ label, to, active }) => (
            <Link key={label} to={to} aria-current={active ? "page" : undefined} onClick={() => {
              if (label === "价格" && pathname === "/models") {
                const directory = document.getElementById("model-pricing");
                directory?.scrollIntoView({ block: "start" });
                directory?.focus({ preventScroll: true });
              }
            }}>{label}</Link>
          ))}
          <span className="publicSiteStatus" title="服务状态页尚未开放，当前未接入实时监控" aria-label="状态：尚未接入实时监控"><i aria-hidden="true" />状态</span>
        </nav>
        <div className="publicSiteActions">
          <button type="button" className="publicSiteTheme" onClick={theme.toggle} aria-label={theme.mode === "light" ? "切换深色模式" : "切换浅色模式"}>
            {theme.mode === "light" ? <Moon size={17} aria-hidden="true" /> : <Sun size={17} aria-hidden="true" />}
          </button>
          <Link className="publicSiteEntry" to={authenticated ? "/workbench/create" : "/auth/login"}>{authenticated ? "进入创作台" : "登录/注册"}</Link>
        </div>
      </div>
    </header>
  );
}
