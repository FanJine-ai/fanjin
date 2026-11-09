import { MessageSquareText, ShieldCheck } from "lucide-react";
import PromptManage from "../../components/setting/components/promptManage";
import { ConsolePage, Section } from "../../ui/console";
import "./systemPrompts.css";

export default function AdminSystemPromptsPage() {
  return (
    <ConsolePage
      className="adminSystemPromptsPage"
      breadcrumbs={[{ label: "AI 策略" }, { label: "系统提示词" }]}
      layoutWidth="content"
      title="系统提示词"
      description="管理全平台 AI 生产链路使用的系统提示词与生成策略。"
    >
      <aside className="adminSystemPromptsNote" aria-label="系统提示词治理范围">
        <ShieldCheck size={15} aria-hidden="true" />
        <div>
          <strong>平台级配置</strong>
          <p>仅平台管理员可修改；变更影响后续新任务，发布前请验证输出格式与下游兼容性。</p>
        </div>
      </aside>
      <Section
        title="AI 生成策略"
        description="统一维护小说分析、资产提取、视频提示词和音色匹配策略。"
        icon={MessageSquareText}
      >
        <PromptManage />
      </Section>
    </ConsolePage>
  );
}
