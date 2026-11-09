import { useEffect, type ReactNode } from "react";
import {
  BookOpenText,
  Braces,
  CheckCircle2,
  CircleHelp,
  FileClock,
  FolderKanban,
  KeyRound,
  Layers3,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Workflow,
} from "lucide-react";
import { Link } from "react-router-dom";
import PublicDocsShell from "./PublicDocsShell";
import "./GuideArticle.css";

const toc = [
  ["guide-start", "快速开始"],
  ["guide-account", "账号与登录"],
  ["guide-workspace", "工作区与权限"],
  ["guide-create", "选择创作方式"],
  ["guide-projects", "项目、素材与资产"],
  ["guide-tasks", "任务、用量与计费"],
  ["guide-developer", "开发者功能"],
  ["guide-security", "内容与账号安全"],
  ["guide-troubleshooting", "常见问题"],
  ["guide-support", "反馈与支持"],
] as const;

type GuideSectionProps = {
  id: string;
  title: string;
  icon: typeof BookOpenText;
  children: ReactNode;
};

function GuideSection({ id, title, icon: Icon, children }: GuideSectionProps) {
  return (
    <section className="guideSection" id={id}>
      <div className="guideSectionHeading">
        <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function GuideNote({
  title,
  tone = "info",
  children,
}: {
  title: string;
  tone?: "info" | "warning";
  children: ReactNode;
}) {
  return (
    <aside className="guideNote" data-tone={tone}>
      <strong>{title}</strong>
      <div>{children}</div>
    </aside>
  );
}

export default function UserGuidePage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "用户说明｜Fanjin 繁境";
    window.scrollTo({ top: 0, behavior: "auto" });
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <PublicDocsShell toc={toc} tocLabel="用户说明目录">
      <section className="guideHero">
        <p className="guideEyebrow">产品使用说明</p>
        <h1>繁境用户说明</h1>
        <p>
          从账号登录、工作区选择到内容生成、项目管理和问题排查，帮助您安全地完成一次创作。
        </p>
        <div className="guideMeta">
          <span>首次发布版本：Fanjin v0.0.7</span>
          <span>更新日期：2026年7月23日</span>
        </div>
      </section>

      <article className="guideArticle">
        <p className="guideLead">
          繁境是一套面向视频与视觉内容生产的 AI 创作平台。您可以在个人或团队工作区中组织项目、上传素材、发起生成任务，
          并通过任务与资产页面追踪结果。实际可见功能会随账号角色、工作区权限、平台配置和版本有所不同。
        </p>

        <GuideSection id="guide-start" title="快速开始" icon={CheckCircle2}>
          <ol className="guideSteps">
            <li>
              <strong>登录或注册账号</strong>
              <p>使用邮箱注册并完成验证，也可以使用登录页当前已启用的第三方登录方式。</p>
            </li>
            <li>
              <strong>选择工作区</strong>
              <p>进入工作区首页，确认当前工作区、身份和可用额度。团队邀请需要使用邀请对应的账号接受。</p>
            </li>
            <li>
              <strong>进入创作台</strong>
              <p>从即梦工作台开始自由创作，或根据任务类型选择流程视图、画布模式、小说、剧本等入口。</p>
            </li>
            <li>
              <strong>提交并查看任务</strong>
              <p>提交生成后，在任务页观察排队、处理中、成功或失败状态。完成的内容会进入项目、素材库或资产库。</p>
            </li>
            <li>
              <strong>检查并交付</strong>
              <p>下载、发布或用于商业场景前，请人工检查内容质量、事实准确性、人物一致性和权利风险。</p>
            </li>
          </ol>
          <div className="guideActionRow">
            <Link className="guidePrimaryLink" to="/auth/login">登录繁境</Link>
            <Link className="guideSecondaryLink" to="/workbench/create">进入创作台</Link>
          </div>
        </GuideSection>

        <GuideSection id="guide-account" title="账号与登录" icon={KeyRound}>
          <h3>注册和验证</h3>
          <ul>
            <li>按照注册页提示填写邮箱、验证码和密码，并在注册前阅读用户协议与隐私政策。</li>
            <li>若平台要求验证邮箱，请先完成验证再继续使用受限功能。</li>
            <li>第三方登录入口由平台管理员配置。登录页未显示的方式代表当前没有启用。</li>
          </ul>
          <h3>忘记密码</h3>
          <p>
            在登录页选择“忘记密码”，使用账号邮箱发起重置。重置链接或令牌仅供本人使用，不要转发或截图分享。
          </p>
          <h3>个人资料与安全设置</h3>
          <p>
            在“设置”中维护基本信息、认证信息和安全设置。公共设备使用完成后应主动退出，不要让浏览器代为保存密码或密钥。
          </p>
          <GuideNote title="登录异常">
            如果重复登录后仍返回登录页，请确认网络与系统时间正常，清理过期站点数据后重新登录。问题持续时，请记录出现时间和页面提示。
          </GuideNote>
        </GuideSection>

        <GuideSection id="guide-workspace" title="工作区与权限" icon={UsersRound}>
          <p>
            工作区用于隔离团队成员、项目、资产、用量和开发者凭据。切换工作区前，先确认当前任务和草稿已经保存。
          </p>
          <div className="guideDefinitionGrid">
            <div>
              <strong>成员</strong>
              <p>使用已授权的创作、项目和资产功能，具体范围取决于工作区角色与权限。</p>
            </div>
            <div>
              <strong>工作区管理员</strong>
              <p>管理工作区资料、工作区成员，并查看被授权的账单和开发者功能。</p>
            </div>
            <div>
              <strong>所有者</strong>
              <p>负责工作区的重要配置、成员管理和商业信息，应谨慎分配管理权限。</p>
            </div>
            <div>
              <strong>平台管理员</strong>
              <p>管理整个平台的运营与基础配置，不等同于普通团队内的工作区管理员。</p>
            </div>
          </div>
          <h3>邀请成员</h3>
          <ol>
            <li>由有成员管理权限的用户在“工作区成员”中发起邀请。</li>
            <li>被邀请人使用邀请对应的账号完成注册或登录。</li>
            <li>加入后检查当前工作区名称和角色，再开始上传素材或发起任务。</li>
          </ol>
          <GuideNote title="数据归属提醒" tone="warning">
            团队工作区中的项目、素材、生成结果和调用记录可能归属于所属组织。离开团队前，请按照组织规则处理交接，不要擅自复制受限内容。
          </GuideNote>
        </GuideSection>

        <GuideSection id="guide-create" title="选择创作方式" icon={Sparkles}>
          <p>不同入口服务于不同的创作阶段。建议先确认目标，再选择最短的工作路径。</p>
          <div className="guideLinkGrid">
            <Link to="/workbench/create">
              <Sparkles size={18} aria-hidden="true" />
              <span><strong>即梦工作台</strong><small>从灵感或参考素材开始生成图片、视频等内容</small></span>
            </Link>
            <Link to="/workbench/quick-create">
              <Workflow size={18} aria-hidden="true" />
              <span><strong>流程视图</strong><small>按阶段组织创意、脚本、分镜和生成任务</small></span>
            </Link>
            <Link to="/workbench/canvas">
              <Layers3 size={18} aria-hidden="true" />
              <span><strong>画布模式</strong><small>在可视化画布中组织节点、素材和创作流程</small></span>
            </Link>
            <Link to="/workbench/project">
              <FolderKanban size={18} aria-hidden="true" />
              <span><strong>项目广场</strong><small>查看、打开和管理已有项目</small></span>
            </Link>
          </div>
          <h3>小说、剧本与专项工具</h3>
          <p>
            小说、剧本、剧本 Agent、生产工作台、剪辑台和角景面向特定制作环节。部分入口要求先选择或创建项目。
            如果页面提示缺少项目，请先到项目广场建立项目，再从项目上下文进入。
          </p>
          <h3>提交生成前</h3>
          <ul>
            <li>确认提示词、参考素材、画面比例、时长、模型和输出数量符合目标。</li>
            <li>只上传您有权处理的素材，避免提交密码、证件、银行卡或无关的个人信息。</li>
            <li>确认当前工作区和可用额度。模型、规格和数量变化可能影响耗时与计费。</li>
            <li>提交后先观察任务状态，避免因页面没有立即刷新而重复创建相同任务。</li>
          </ul>
        </GuideSection>

        <GuideSection id="guide-projects" title="项目、素材与资产" icon={FolderKanban}>
          <h3>项目</h3>
          <p>
            项目用于集中保存一次创作的脚本、画布、素材、任务和结果。命名时建议包含作品名或用途，避免使用“新项目”等难以检索的名称。
          </p>
          <h3>素材库与资产库</h3>
          <ul>
            <li>素材库用于查找创作过程中使用的图片、视频、音频和文档。</li>
            <li>资产库用于管理上传文件、生成结果和云存储内容，并可按页面提供的分类或筛选方式查找。</li>
            <li>删除、覆盖或移动内容前，先确认是否仍被项目、画布或下游任务引用。</li>
            <li>交付前将最终版本与中间草稿区分命名，并在本地或组织指定位置保留必要备份。</li>
          </ul>
          <GuideNote title="浏览器草稿">
            某些临时输入或界面状态可能保存在浏览器本地。不要把未提交的浏览器草稿当作正式备份，切换设备、清理站点数据或退出登录前应先确认内容已经保存。
          </GuideNote>
        </GuideSection>

        <GuideSection id="guide-tasks" title="任务、用量与计费" icon={FileClock}>
          <div className="guideDefinitionGrid">
            <div>
              <strong>排队或处理中</strong>
              <p>任务已提交，正在等待平台或上游模型处理。复杂任务可能需要更长时间。</p>
            </div>
            <div>
              <strong>成功</strong>
              <p>任务已经返回结果。请打开结果检查质量，并确认内容已保存到预期项目或资产位置。</p>
            </div>
            <div>
              <strong>失败</strong>
              <p>查看页面展示的错误信息、任务时间和任务标识。先修正输入或等待服务恢复，再决定是否重新提交。</p>
            </div>
            <div>
              <strong>取消</strong>
              <p>任务没有继续执行。是否产生或返还用量，以任务记录和当时展示的计费规则为准。</p>
            </div>
          </div>
          <h3>账单与用量</h3>
          <p>
            有账单权限的用户可以在“账单与用量”中查看余额、消费和充值信息。工作区、模型、参数和任务数量都会影响实际用量。
            若发现异常，请保留订单号、任务标识和发生时间，不要通过普通消息发送支付密码或完整凭据。
          </p>
          <div className="guideActionRow">
            <Link className="guideSecondaryLink" to="/workbench/task">查看任务</Link>
            <Link className="guideSecondaryLink" to="/workspace/billing">查看账单与用量</Link>
          </div>
        </GuideSection>

        <GuideSection id="guide-developer" title="开发者功能" icon={Braces}>
          <p>
            获得开发者权限后，可以在开发者控制台管理 API 密钥，查看接口说明、请求配置、任务、日志以及模型能力。
          </p>
          <ul>
            <li>API 密钥只在需要的系统中使用，不要写入前端代码、公开仓库、截图或聊天记录。</li>
            <li>为不同环境和用途使用独立密钥，发现泄露后立即停用并创建新密钥。</li>
            <li>以开发者控制台展示的接口地址、认证方式、模型名称和限流规则为准。</li>
            <li>排查接口问题时记录请求标识、时间、状态码和安全处理后的参数，不要记录完整密钥。</li>
          </ul>
          <Link className="guideInlineLink" to="/developer">进入开发者控制台</Link>
        </GuideSection>

        <GuideSection id="guide-security" title="内容与账号安全" icon={ShieldCheck}>
          <ul>
            <li>不得上传或生成违法违规、侵害他人权益、欺诈、骚扰、色情、暴力或其他被平台规则禁止的内容。</li>
            <li>处理他人肖像、声音、身份信息、商业秘密或受版权保护的作品前，应取得必要授权。</li>
            <li>AI 输出可能存在错误、偏差或权利风险。发布、传播和商业使用前必须进行人工审核。</li>
            <li>不要共享账号、验证码、密码、重置令牌或 API 密钥。管理员也不会要求您发送完整密码。</li>
            <li>需要注销账号、删除信息或行使个人信息权利时，请按照隐私政策提供的渠道提出请求。</li>
          </ul>
          <div className="guideActionRow">
            <Link className="guideSecondaryLink" to="/docs/legal/terms">阅读用户协议</Link>
            <Link className="guideSecondaryLink" to="/docs/legal/privacy">阅读隐私政策</Link>
          </div>
        </GuideSection>

        <GuideSection id="guide-troubleshooting" title="常见问题" icon={CircleHelp}>
          <div className="guideFaq">
            <details>
              <summary>为什么看不到某个菜单或按钮？</summary>
              <p>通常是当前工作区、账号角色、功能配置或项目上下文不满足要求。先确认当前工作区和角色，再联系工作区管理员核对权限。</p>
            </details>
            <details>
              <summary>任务长时间停留在处理中怎么办？</summary>
              <p>先刷新任务状态并确认网络正常，不要重复提交。记录任务标识、提交时间、使用的模型和当前状态，再联系支持人员核查。</p>
            </details>
            <details>
              <summary>生成失败后是否会扣费？</summary>
              <p>处理方式取决于失败阶段、上游资源消耗和当时的计费规则。请以任务记录和账单明细为准，有疑问时提交任务标识申请核对。</p>
            </details>
            <details>
              <summary>上传的文件或生成结果找不到了怎么办？</summary>
              <p>确认当前工作区和项目是否正确，再检查素材库、资产库和任务结果。若曾清理浏览器数据，也要确认内容是否只保存在本地草稿中。</p>
            </details>
            <details>
              <summary>页面显示接口错误怎么办？</summary>
              <p>记录页面地址、发生时间、操作步骤和错误提示。可以先重新登录或稍后重试，但不要在连续失败时反复提交付费任务。</p>
            </details>
          </div>
        </GuideSection>

        <GuideSection id="guide-support" title="反馈与支持" icon={BookOpenText}>
          <p>提交问题时，建议提供以下信息，以便更快定位：</p>
          <ul>
            <li>账号邮箱的脱敏形式，以及当前工作区名称。</li>
            <li>发生问题的页面、时间、操作步骤和预期结果。</li>
            <li>任务标识、请求标识、订单号或项目标识中的相关一项。</li>
            <li>不包含密码、验证码、API 密钥和敏感素材的错误截图。</li>
          </ul>
          <div className="guideContact">
            <strong>服务与用户请求邮箱</strong>
            <a href="mailto:auth@fanjin.top">auth@fanjin.top</a>
            <p>涉及个人信息权利时，请在邮件主题中注明“隐私请求”。</p>
          </div>
        </GuideSection>

        <footer className="guideFooter">
          <p>本说明用于介绍平台操作，不替代用户协议、隐私政策、购买页面或双方签署的合同。</p>
          <p>© 2026 Fanjin 繁境</p>
        </footer>
      </article>
    </PublicDocsShell>
  );
}
