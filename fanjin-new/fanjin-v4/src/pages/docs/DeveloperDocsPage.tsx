import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Code2, Copy, KeyRound, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import PublicDocsShell from "./PublicDocsShell";
import apiMarkdown from "./content/api.md?raw";
import mcpMarkdown from "./content/mcp.md?raw";
import cliMarkdown from "./content/cli.md?raw";
import "./GuideArticle.css";
import "./DeveloperDocsPage.css";

const documents = {
  api: { title: "API 文档", summary: "从第一条请求开始，接入文本、图片、视频和多模态能力。", label: "HTTP API", markdown: apiMarkdown },
  mcp: { title: "MCP 集成", summary: "让支持 MCP 的客户端在授权范围内查询项目、管理素材并发起创作。", label: "工作区工具 · API Key", markdown: mcpMarkdown },
  cli: { title: "CLI 使用指南", summary: "在终端和自动化脚本中完成素材上传、生成报价、任务查询与作品下载。", label: "Node.js 22+ · 私有源码包", markdown: cliMarkdown },
};

function parseSections(markdown: string) {
  const headings = [...markdown.matchAll(/^## (.+) \{#([a-z0-9-]+)\}$/gm)];
  return headings.map((match, index) => ({
    title: match[1],
    id: match[2],
    content: markdown.slice(match.index! + match[0].length, headings[index + 1]?.index ?? markdown.length).trim(),
  }));
}

function CodeExample({ children, className }: { children?: React.ReactNode; className?: string }) {
  const code = String(children ?? "").replace(/\n$/, "");
  const language = className?.replace("language-", "") || "示例";
  const [feedback, setFeedback] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(code);
      setFeedback("copied");
    } catch {
      setFeedback("failed");
    }
    timer.current = setTimeout(() => setFeedback("idle"), 3000);
  }
  return (
    <div className="developerDocCode">
      <div className="developerDocCodeToolbar">
        <span className="developerDocCodeLanguage">
          {language === "bash" ? <Terminal size={14} aria-hidden="true" /> : <Code2 size={14} aria-hidden="true" />}
          {language === "bash" ? "Shell" : language === "json" ? "JSON" : language}
        </span>
        <button type="button" onClick={() => void copy()} aria-label="复制代码">
          {feedback === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span aria-live="polite">{feedback === "copied" ? "已复制" : feedback === "failed" ? "复制失败，请手动选择" : "复制"}</span>
        </button>
      </div>
      <pre tabIndex={0} aria-label="代码示例"><code>{code}</code></pre>
    </div>
  );
}

const markdownComponents: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ children, className }) => className || String(children).includes("\n")
    ? <CodeExample className={className}>{children}</CodeExample>
    : <code>{children}</code>,
  table: ({ children }) => <div className="developerDocTable" role="region" aria-label="参考表格" tabIndex={0}><table>{children}</table></div>,
  a: ({ href = "", children }) => href.startsWith("/") || href.startsWith("#")
    ? <Link to={href.startsWith("#/") ? href.slice(1) : href}>{children}</Link>
    : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
};

export default function DeveloperDocsPage({ kind }: { kind: keyof typeof documents }) {
  const doc = documents[kind];
  const sections = parseSections(doc.markdown);
  useEffect(() => {
    const previous = document.title;
    document.title = `${doc.title}｜Fanjin 繁境`;
    // A section hash is handled by PublicDocsShell after the document mounts.
    if (!window.location.hash.includes("#", 1)) window.scrollTo({ top: 0, behavior: "auto" });
    return () => { document.title = previous; };
  }, [doc.title]);

  return (
    <PublicDocsShell toc={sections.map(({ id, title }) => [id, title] as const)}>
      <header className="guideHero developerDocHero">
        <p className="guideEyebrow"><Link to="/docs">文档</Link><span aria-hidden="true">/</span>开发者资源</p>
        <h1>{doc.title}</h1>
        <p>{doc.summary}</p>
        <div className="developerDocMeta">{doc.label}</div>
        <div className="guideActionRow">
          <Link className="guidePrimaryLink" to="/developer/api/keys"><KeyRound size={15} aria-hidden="true" />管理 API 密钥</Link>
          <Link className="guideSecondaryLink" to="/models">浏览模型与价格<ArrowUpRight size={15} aria-hidden="true" /></Link>
        </div>
      </header>
      <article className="developerDocArticle">
        {sections.map(({ id, title, content }) => (
          <section className="developerDocSection" key={`${kind}-${id}`} id={id} tabIndex={-1}>
            <h2>{title}</h2>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>
          </section>
        ))}
      </article>
      <footer className="developerDocFooter">
        <span>继续阅读</span>
        {Object.entries(documents).filter(([key]) => key !== kind).map(([key, value]) => <Link key={key} to={`/docs/${key}`}>{value.title} →</Link>)}
      </footer>
    </PublicDocsShell>
  );
}
