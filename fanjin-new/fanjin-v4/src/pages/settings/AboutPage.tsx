import { ArrowUpRight, FileText, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import fanjinLogo from "../../assets/fanjin-logo-fj.svg";
import { ConsolePage, Section } from "../../ui/console";
import "./AboutPage.css";

const legalDocuments = [
  {
    title: "用户服务协议",
    description: "了解账号、AI 生成内容、费用、知识产权与平台使用规范。",
    path: "/docs/legal/terms",
  },
  {
    title: "隐私政策",
    description: "了解个人信息、创作素材、云存储及第三方模型的处理方式。",
    path: "/docs/legal/privacy",
  },
];

export default function AboutPage() {
  const productVersion = String(import.meta.env.VITE_APP_VERSION || "0.2.4");
  const currentYear = new Date().getFullYear();

  return (
    <ConsolePage
      className="aboutPage"
      eyebrow="设置"
      title="关于繁境"
      description="繁境是一站式 AI 视听创作平台，帮助创作者把灵感持续推进为可复用的作品与资产。"
      layoutWidth="content"
    >
      <section className="aboutProductHero" aria-labelledby="about-product-name">
        <span className="aboutProductMark" aria-hidden="true">
          <img src={fanjinLogo} alt="" />
        </span>
        <div className="aboutProductCopy">
          <span>FANJIN STUDIO</span>
          <h2 id="about-product-name">繁境</h2>
          <p>AI 视听创作平台</p>
        </div>
        <span className="aboutVersion" aria-label={`当前版本 ${productVersion}`}>
          当前版本&nbsp; {productVersion}
        </span>
      </section>

      <Section
        className="aboutLegalSection"
        title="法律与合规"
        description="适用于繁境网站、创作平台和企业工作区"
        icon={ShieldCheck}
      >
        <div className="aboutLegalGrid">
          {legalDocuments.map((document) => (
            <Link key={document.path} to={document.path} className="aboutLegalLink">
              <span className="aboutLegalIcon"><FileText size={17} aria-hidden="true" /></span>
              <span>
                <strong>{document.title}</strong>
                <small>{document.description}</small>
              </span>
              <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          ))}
        </div>
      </Section>

      <footer className="aboutFooter">
        <span>© {currentYear} 繁境 Fanjin</span>
        <span>让每一次创作都可以继续生长</span>
      </footer>
    </ConsolePage>
  );
}
