import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./AgentMarkdown.css";

export type AgentMarkdownContentProps = {
  content: string;
  className?: string;
};

/**
 * Agent 消息正文渲染(REVAMP-PLAN 4.6):react-markdown + remark-gfm,
 * 支持表格/代码块/列表等 GFM 语法,替代原先的纯文本 <p> 直出。
 * 样式全部收在 .agentMarkdown 作用域内,不影响页面其它区域。
 */
export function AgentMarkdownContent({ content, className }: AgentMarkdownContentProps) {
  return (
    <div className={["agentMarkdown", className].filter(Boolean).join(" ")}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export default AgentMarkdownContent;
