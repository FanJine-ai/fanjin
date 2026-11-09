import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Moon, Sun } from "lucide-react";
import { useV4Theme } from "../../ui/useV4Theme";
import "./AuthShell.css";

interface AuthShellProps {
  title: string;
  subtitle: string;
  eyebrow?: string;
  shellStyle?: CSSProperties;
  toolsSlot?: ReactNode;
  children: ReactNode;
}

export default function AuthShell({ title, subtitle, shellStyle, toolsSlot, children }: AuthShellProps) {
  const theme = useV4Theme();
  return (
    <main className="authShell" data-theme={theme.mode} style={shellStyle}>
      <header className="authShell__topbar">
        <Link to="/" className="authShell__brand" aria-label="Fanjin 首页">
          <img src="/assets/fanjin-logo-fj.svg" alt="" />
          <span><strong>繁境</strong><small>FANJIN</small></span>
        </Link>
        <div className="authShell__tools">
          {toolsSlot}
          <button type="button" onClick={theme.toggle} aria-label={theme.mode === "dark" ? "切换浅色主题" : "切换深色主题"}>
            {theme.mode === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <Link to="/">返回首页</Link>
        </div>
      </header>
      <section className="authShell__frame" aria-label="Fanjin 账号入口">
        <div className="authShell__narrative">
          <img className="authShell__poster" src="/assets/auth-creation-portal.png" alt="旅人走向沙漠中的光之门" />
          <span className="authShell__posterBrand">FANJIN STUDIO</span>
          <div className="authShell__posterCopy"><h2>让想象抵达画面</h2><p>从一个想法，到一段好作品</p></div>
        </div>
        <div className="authShell__portal">
          <div className="authShell__panel">
            <h1 className="authShell__title">{title}</h1>
            <p className="authShell__subtitle">{subtitle}</p>
            {children}
          </div>
        </div>
      </section>
    </main>
  );
}
