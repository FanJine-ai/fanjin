import { useEffect } from "react";
import { BookOpenText, Braces, ChevronRight, Command, FileText, Plug, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import PublicDocsShell from "./PublicDocsShell";

export default function PublicDocsHome() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "文档中心｜Fanjin 繁境";
    window.scrollTo({ top: 0, behavior: "auto" });
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <PublicDocsShell>
      <section className="publicDocsHomeHero">
        <span>繁境公共文档</span>
        <h1>产品规则与开发者资源</h1>
        <p>
          从产品使用到开发者接入，查阅 API 参考、MCP 集成、CLI 操作指南，以及平台规则与隐私说明。
        </p>
      </section>

      <section className="publicDocsHomeSection">
        <h2>产品说明</h2>
        <div className="publicDocsHomeRows">
          <Link to="/docs/user-guide">
            <BookOpenText size={20} strokeWidth={1.7} aria-hidden="true" />
            <span>
              <strong>用户说明</strong>
              <small>账号、工作区、创作流程、任务、资产与常见问题</small>
            </span>
            <ChevronRight size={17} aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section className="publicDocsHomeSection">
        <h2>法律与合规</h2>
        <div className="publicDocsHomeRows">
          <Link to="/docs/legal/terms">
            <FileText size={20} strokeWidth={1.7} aria-hidden="true" />
            <span>
              <strong>用户协议</strong>
              <small>服务范围、账号规则、AI 内容、费用与责任边界</small>
            </span>
            <ChevronRight size={17} aria-hidden="true" />
          </Link>
          <Link to="/docs/legal/privacy">
            <ShieldCheck size={20} strokeWidth={1.7} aria-hidden="true" />
            <span>
              <strong>隐私政策</strong>
              <small>信息处理、第三方服务、数据安全与用户权利</small>
            </span>
            <ChevronRight size={17} aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section className="publicDocsHomeSection">
        <h2>开发者资源</h2>
        <div className="publicDocsHomeRows">
          <Link to="/docs/api">
            <Braces size={20} strokeWidth={1.7} aria-hidden="true" />
            <span><strong>API 文档</strong><small>鉴权、模型发现、文本、图片、视频与错误处理</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </Link>
          <Link to="/docs/mcp">
            <Plug size={20} strokeWidth={1.7} aria-hidden="true" />
            <span><strong>MCP 集成</strong><small>连接配置、工作区工具、用量查询与权限</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </Link>
          <Link to="/docs/cli">
            <Command size={20} strokeWidth={1.7} aria-hidden="true" />
            <span><strong>CLI 使用指南</strong><small>安装连接、素材创作、任务恢复与用量导出</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </Link>
        </div>
      </section>
    </PublicDocsShell>
  );
}
