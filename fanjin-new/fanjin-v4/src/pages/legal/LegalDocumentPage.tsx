import { useEffect, type ReactNode } from "react";
import PublicDocsShell from "../docs/PublicDocsShell";
import { useTenantRuntime } from "../../lib/tenant-runtime";
import "./LegalDocumentPage.css";

export type LegalDocumentKind = "terms" | "privacy";

const EFFECTIVE_DATE = "2026年7月17日";

interface LegalSectionProps {
  id: string;
  title: string;
  children: ReactNode;
}

function LegalSection({ id, title, children }: LegalSectionProps) {
  return (
    <section className="legalSection" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function LegalTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="legalTableWrap">
      <table className="legalTable">
        <thead>
          <tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const termsToc = [
  ["terms-scope", "一、协议主体与适用范围"],
  ["terms-service", "二、平台服务"],
  ["terms-account", "三、账号、认证与安全"],
  ["terms-workspace", "四、工作区与团队协作"],
  ["terms-ai", "五、AI 服务与生成内容"],
  ["terms-content", "六、用户内容与授权"],
  ["terms-rules", "七、使用规范"],
  ["terms-fees", "八、费用、积分与退款"],
  ["terms-ip", "九、知识产权"],
  ["terms-third-party", "十、第三方服务"],
  ["terms-change", "十一、变更、中止与终止"],
  ["terms-liability", "十二、责任边界"],
  ["terms-law", "十三、法律适用与争议解决"],
  ["terms-contact", "十四、联系我们"],
] as const;

const privacyToc = [
  ["privacy-scope", "一、适用范围与处理者"],
  ["privacy-collect", "二、我们处理的信息"],
  ["privacy-sensitive", "三、敏感个人信息"],
  ["privacy-purpose", "四、处理目的与依据"],
  ["privacy-local", "五、Cookie 与本地存储"],
  ["privacy-sharing", "六、委托处理与对外提供"],
  ["privacy-storage", "七、存储地点与期限"],
  ["privacy-security", "八、安全保护"],
  ["privacy-rights", "九、您的权利"],
  ["privacy-minors", "十、未成年人保护"],
  ["privacy-update", "十一、政策更新"],
  ["privacy-contact", "十二、联系我们"],
] as const;

function TermsContent() {
  const tenant = useTenantRuntime();
  const OPERATOR = tenant.operatorName;
  const WEBSITE = window.location.hostname;
  const CONTACT_EMAIL = tenant.customerServiceEmail || "auth@fanjin.top";
  const ICP = tenant.icpNumber || "备案信息待配置";
  return (
    <>
      <p className="legalLead">
        欢迎使用 Fanjin 繁境。请您在注册、登录或使用服务前完整阅读本协议，特别是关于 AI 生成内容、费用、知识产权、责任限制和争议解决的条款。
        您勾选同意或实际使用服务，即表示您已理解并接受本协议。
      </p>

      <LegalSection id="terms-scope" title="一、协议主体与适用范围">
        <p>本协议由您与 <strong>{OPERATOR}</strong>（下称“繁境”或“我们”）共同订立，适用于您通过 {WEBSITE}、相关客户端、API、工作区及我们提供的其他入口使用繁境服务。</p>
        <p>如某项功能另有专项规则、订单说明、开发者文档或活动规则，该等内容构成本协议的补充；与本协议不一致的，以针对该功能特别展示并经您确认的规则为准。</p>
      </LegalSection>

      <LegalSection id="terms-service" title="二、平台服务">
        <p>繁境面向个人创作者、团队和企业提供 AI 视频创作与生产协作能力，包括但不限于：</p>
        <ul>
          <li>灵感、文案、小说、剧本、分镜、图片、视频、音频及相关多模态内容的生成、编辑和管理；</li>
          <li>无限画布、项目、素材库、生成队列、历史任务和团队工作区；</li>
          <li>第三方模型的统一调用、任务调度、用量计量、余额或积分管理；</li>
          <li>开发者 API、API 密钥、调用日志、模型路由及企业管理功能；</li>
          <li>我们后续上线并明确展示的其他功能。</li>
        </ul>
        <p>部分服务可能处于测试、灰度或预约阶段，具体可用能力、模型、并发、存储、价格和交付时间以使用页面实际展示为准。</p>
      </LegalSection>

      <LegalSection id="terms-account" title="三、账号、认证与安全">
        <ol>
          <li><strong>统一账号。</strong>个人和企业使用同一用户账号注册。企业身份属于认证和工作区属性，不属于另一种登录账号。</li>
          <li><strong>信息真实。</strong>您应提供合法、真实、准确、完整的信息并及时更新。实名认证或企业认证所提交的证件、主体和联系人信息必须获得合法授权。</li>
          <li><strong>账号安全。</strong>您应妥善保管密码、验证码、恢复码、API 密钥及登录设备。通过您的账号或密钥完成的操作，原则上视为您的操作；发现异常时请立即修改凭证并联系我们。</li>
          <li><strong>不得转售。</strong>未经书面同意，不得出租、出借、买卖账号，不得绕过权限、计费、并发、风控或安全措施。</li>
          <li><strong>账号处置。</strong>如账号存在违法违规、侵权、欺诈、安全攻击或严重违约行为，我们可依法采取限制功能、暂停任务、冻结余额使用、停用密钥或终止服务等措施，并在适用法律要求下提供申诉渠道。</li>
        </ol>
      </LegalSection>

      <LegalSection id="terms-workspace" title="四、工作区与团队协作">
        <p>每个用户可拥有默认个人空间，并可创建、加入或管理一个或多个团队或企业工作区。工作区所有者和管理员应按照最小必要原则分配成员、角色、额度、密钥和数据权限。</p>
        <p>您代表企业或其他组织使用服务时，您确认已获得充分授权。工作区管理员可能依据组织规则访问、管理、导出或删除工作区内的项目、成员、素材、用量和日志；成员应向所属组织了解其内部数据管理规则。</p>
        <p>成员退出、被移除或劳动/合作关系终止后，其对工作区数据的访问权可能立即终止，但属于工作区的项目和资产仍由工作区继续管理。</p>
      </LegalSection>

      <LegalSection id="terms-ai" title="五、AI 服务与生成内容">
        <ol>
          <li><strong>模型特性。</strong>AI 输出具有概率性，可能不准确、不完整、与其他用户结果相似，或不符合您的预期。您应在发布、商用或用于重要决策前进行人工审核。</li>
          <li><strong>必要处理。</strong>为执行任务，我们可能将您的提示词、参数以及您选择的参考图片、视频、音频或文本发送给相应模型服务商。具体处理方式同时受《隐私政策》约束。</li>
          <li><strong>权利审查。</strong>您应确保输入内容和使用方式合法，并自行确认生成内容不侵犯著作权、商标权、肖像权、声音权益、隐私权、商业秘密或其他第三方权利。</li>
          <li><strong>真人与仿真内容。</strong>使用真实人物的姓名、肖像、声音、身份或高度仿真形象前，您必须取得充分授权；不得制作或传播冒充、诈骗、诽谤、色情、暴力、操纵舆论或其他违法有害内容。</li>
          <li><strong>标识义务。</strong>您应按照适用法律法规和发布平台规则，对 AI 生成或深度合成内容进行显著、可识别的标识，不得删除、篡改或规避依法添加的技术标识。</li>
          <li><strong>不替代专业意见。</strong>输出不得直接作为医疗、法律、金融、公共安全等高风险领域的唯一决策依据。</li>
        </ol>
      </LegalSection>

      <LegalSection id="terms-content" title="六、用户内容与授权">
        <p>您保留对合法上传内容所享有的权利。为向您提供上传、存储、转码、分析、生成、协作、预览、下载和故障排查服务，您授予繁境一项在服务期限和必要范围内、非独占、可撤销（但已完成处理除外）的技术处理许可。</p>
        <p>除非您主动公开、共享、发布或另行明确授权，我们不会将您的非公开项目和素材用于面向其他客户展示，也不会仅因您使用服务而主张其所有权。</p>
        <p>您向公共广场、模板库或其他公开区域发布内容时，应确认具备公开传播所需的全部权利。为展示和分发该内容，您授予我们在该公开功能范围内进行复制、信息网络传播、格式适配和推荐展示的许可；您删除内容后，我们将在合理期限内停止新的公开展示，但依法留存、备份或已被其他用户合法保存的情形除外。</p>
      </LegalSection>

      <LegalSection id="terms-rules" title="七、使用规范">
        <p>您不得利用服务实施或协助实施以下行为：</p>
        <ul>
          <li>制作、存储或传播违反法律法规、公序良俗或监管要求的内容；</li>
          <li>侵害国家安全、公共利益、他人合法权益，或实施歧视、骚扰、诈骗、赌博、色情、暴力和恶意营销；</li>
          <li>未经授权处理他人的个人信息、生物识别信息、商业秘密、未公开数据或受保护作品；</li>
          <li>干扰平台运行，批量注册、恶意抓取、攻击、注入、逆向、探测漏洞、绕过内容安全或访问控制；</li>
          <li>通过 API 超出约定频率、并发或用途调用，转售未获许可的模型能力，或伪造、隐瞒调用来源；</li>
          <li>其他可能使繁境、模型供应商或第三方承担法律责任的行为。</li>
        </ul>
        <p>我们可依法使用自动化和人工方式进行安全检测、内容治理和违规处置，但该等措施不代表我们对所有内容作出事前审查或合法性保证。</p>
      </LegalSection>

      <LegalSection id="terms-fees" title="八、费用、积分与退款">
        <ol>
          <li>收费项目、计费单位、套餐周期、积分或余额有效期、并发和存储权益以购买页、订单页或双方合同为准。</li>
          <li>模型任务提交后可能立即产生上游调用成本。对于已完成或已实际消耗资源的数字化服务，除法律另有规定、页面规则另有承诺或因平台故障导致未提供服务外，通常不支持无理由退款。</li>
          <li>任务失败时，是否扣费、返还或补偿以系统记录、失败原因和当时展示的计费规则为准；因用户输入违规、参数错误、主动取消、第三方限流或不可归责于繁境的原因产生的成本，可能无法返还。</li>
          <li>您应在支付前核对账号、工作区、商品、金额和适用范围。企业合同、发票、税费和结算以订单或补充协议为准。</li>
          <li>如发现明显计费错误，您可在合理期限内提交订单号和调用记录申请核对。</li>
        </ol>
      </LegalSection>

      <LegalSection id="terms-ip" title="九、知识产权">
        <p>繁境平台的软件、界面、品牌、商标、文档、流程设计、代码、运营内容及相关知识产权归繁境或合法权利人所有。本协议不构成对前述权利的转让。</p>
        <p>在法律允许且不受第三方权利、模型规则或双方另行约定限制的范围内，您可使用自己合法生成的内容。我们不保证任何 AI 输出具备著作权法意义上的独创性或可登记、可独占性。</p>
        <p>如您认为平台内容侵犯您的合法权利，请向联系邮箱提交权属证明、具体链接、侵权说明和有效联系方式，我们将依法处理。</p>
      </LegalSection>

      <LegalSection id="terms-third-party" title="十、第三方服务">
        <p>繁境会按您选择的功能连接云基础设施、对象存储、邮件、支付、身份认证和 AI 模型等第三方服务。第三方服务可能有独立的服务条款、内容规则、区域限制、可用性和计费方式。</p>
        <p>我们会审慎选择并管理合作方，但第三方原因造成的模型波动、内容拒绝、接口变更、网络中断或交付延迟，可能超出我们的直接控制。我们将尽合理努力进行路由切换、重试、告警或协助排查，但不承诺所有第三方能力永久可用。</p>
      </LegalSection>

      <LegalSection id="terms-change" title="十一、变更、中止与终止">
        <p>我们可能因产品升级、合规要求、安全风险、模型调整或经营安排变更服务。对显著影响您权益的变更，我们将通过页面公告、站内通知、邮件或其他合理方式告知。</p>
        <p>您可以停止使用服务，并可按照《隐私政策》申请注销账号或删除相关信息。注销前请结清费用、处理企业工作区权限并自行导出所需数据。法律法规要求留存、争议处理、安全审计或备份尚未完成清除的内容除外。</p>
      </LegalSection>

      <LegalSection id="terms-liability" title="十二、责任边界">
        <p>我们将按照法律要求和合理行业标准保障服务安全、连续和可用，但互联网、云服务和生成式 AI 不可能完全无故障。计划维护、网络波动、不可抗力、监管要求、第三方服务异常或用户设备问题可能导致服务暂时不可用。</p>
        <p>在法律允许范围内，繁境不对 AI 输出的准确性、独创性、适销性、特定用途适用性或不侵权性作绝对保证。您应对输入、生成内容的审核、发布、传播和商业使用承担责任。</p>
        <p>任何责任限制均不适用于因故意或重大过失造成的人身损害、法律明确不得限制的消费者权益，或我们依法应承担的个人信息保护责任。</p>
      </LegalSection>

      <LegalSection id="terms-law" title="十三、法律适用与争议解决">
        <p>本协议的订立、生效、履行、解释和争议解决适用中华人民共和国大陆地区法律。</p>
        <p>发生争议时，双方应先友好协商；协商不成的，任何一方可依法向运营主体住所地有管辖权的人民法院提起诉讼。法律对消费者争议管辖另有强制规定的，从其规定。</p>
      </LegalSection>

      <LegalSection id="terms-contact" title="十四、联系我们">
        <div className="legalContact">
          <p><strong>运营主体：</strong>{OPERATOR}</p>
          <p><strong>网站：</strong>{WEBSITE}</p>
          <p><strong>服务与法律联系邮箱：</strong>{CONTACT_EMAIL}</p>
          <p><strong>ICP备案：</strong>{ICP}</p>
        </div>
      </LegalSection>
    </>
  );
}

function PrivacyContent() {
  const tenant = useTenantRuntime();
  const OPERATOR = tenant.operatorName;
  const WEBSITE = window.location.hostname;
  const CONTACT_EMAIL = tenant.customerServiceEmail || "auth@fanjin.top";
  const ICP = tenant.icpNumber || "备案信息待配置";
  return (
    <>
      <p className="legalLead">
        我们重视您的个人信息和创作数据安全。本政策说明繁境在提供账号、工作区、AI 生成、素材存储、开发者 API、计费与认证服务时，
        如何收集、使用、存储和保护信息，以及您如何行使相关权利。
      </p>

      <LegalSection id="privacy-scope" title="一、适用范围与个人信息处理者">
        <p>本政策适用于由 <strong>{OPERATOR}</strong> 运营的 Fanjin 繁境网站、工作台、控制台、API 及相关服务。针对由第三方独立提供并由您直接跳转使用的服务，以该第三方隐私政策为准。</p>
        <p>企业或团队工作区可能由所属组织作为独立个人信息处理者决定成员数据的处理目的和方式。繁境按照企业客户指示提供技术服务时，企业客户应向其成员履行相应告知和授权义务。</p>
      </LegalSection>

      <LegalSection id="privacy-collect" title="二、我们处理的信息">
        <LegalTable
          headers={["场景", "可能处理的信息", "主要用途"]}
          rows={[
            ["账号注册与登录", "邮箱、用户名或昵称、密码密文、验证码状态、登录时间、IP 地址、会话和安全设置；手机号功能启用后可能处理手机号码", "创建账号、身份验证、找回账号、异常登录识别和安全保护"],
            ["个人或企业认证", "真实姓名、证件号码、联系电话；企业名称、统一社会信用代码、法定代表人、营业执照及审核记录", "实名认证、企业认证、合同、发票、团队管理和敏感操作校验"],
            ["创作与素材服务", "提示词、文本、脚本、图片、视频、音频、文档、项目结构、画布节点、任务参数、生成结果及您选择的参考素材", "执行生成、编辑、转码、存储、协作、历史恢复和内容安全"],
            ["工作区与协作", "工作区名称、成员、角色、权限、邀请、操作记录和资产归属", "团队协作、授权管理、审计和组织数据隔离"],
            ["开发者与 API", "API 密钥标识或密文、请求参数、模型、Token 或任务用量、响应状态、错误信息、调用时间和来源 IP", "鉴权、路由、限流、计费、排障、审计和防滥用"],
            ["交易与客户服务", "订单、商品、金额、余额或积分变动、支付状态、发票抬头和服务工单；支付账户敏感信息通常由支付机构处理", "完成交易、对账、开票、退款核验和售后服务"],
            ["设备与运行日志", "浏览器类型、操作系统、设备和网络信息、页面访问、点击、崩溃、性能、安全和审计日志", "保障运行、定位故障、改进体验、统计分析和安全防护"],
          ]}
        />
        <p>您可以不提供非必要信息，但拒绝提供某项功能所必需的信息，可能导致该功能无法使用。例如，不提交企业认证资料不会影响普通账号登录，但无法使用依赖企业认证的合同、结算或团队能力。</p>
      </LegalSection>

      <LegalSection id="privacy-sensitive" title="三、敏感个人信息">
        <p>证件号码、身份认证材料、未成年人信息、精确财务账户信息，以及包含人脸、声音、健康或其他高度私密内容的素材，可能构成敏感个人信息。我们仅在实现明确功能、履行法定义务或获得单独同意的情况下处理。</p>
        <p>上传包含他人肖像、声音、身份或其他个人信息的素材前，您应取得合法授权并遵循最小必要原则。请勿在提示词、文件名或公开项目中提交与任务无关的身份证件、银行卡、密码、密钥或其他敏感信息。</p>
      </LegalSection>

      <LegalSection id="privacy-purpose" title="四、处理目的与依据">
        <p>我们在以下依据和目的范围内处理信息：</p>
        <ul>
          <li>为订立、履行您作为一方的合同所必需，例如注册、生成任务、素材存储、工作区协作、API 调用和订单结算；</li>
          <li>履行网络安全、日志留存、实名核验、财税、内容治理和监管配合等法定义务；</li>
          <li>为保护账号、平台、其他用户和公众的合法权益，进行安全检测、反欺诈、限流、防攻击和故障排查；</li>
          <li>基于您的同意提供非必要功能，并在需要时取得单独同意；</li>
          <li>对无法识别特定个人的汇总或匿名化数据进行统计、容量规划和产品改进。</li>
        </ul>
        <p><strong>未经另行明确告知和授权，我们不会将您的非公开创作素材用于训练面向其他客户的通用生成模型。</strong>如未来提供可选的数据改进计划，我们将单独说明范围、退出方式和权益影响。</p>
      </LegalSection>

      <LegalSection id="privacy-local" title="五、Cookie、会话与本地存储">
        <p>为维持登录状态、保存界面偏好、当前工作区、草稿或临时预览，我们可能使用 Cookie、浏览器本地存储和会话存储。必要存储用于身份验证、安全和核心功能；关闭后可能导致无法登录或丢失尚未上传的本地草稿。</p>
        <p>我们不会要求您通过 Cookie 保存明文密码。请勿在公共设备上长期保持登录，使用完成后应及时退出并清除浏览器数据。</p>
      </LegalSection>

      <LegalSection id="privacy-sharing" title="六、委托处理、共同处理与对外提供">
        <p>我们不会出售您的个人信息。为完成您选择的服务，可能在最小必要范围内向以下类型的合作方提供信息或委托其处理：</p>
        <LegalTable
          headers={["合作方类型", "处理内容", "目的与说明"]}
          rows={[
            ["火山引擎等云基础设施服务", "账号、数据库、缓存、日志、项目和素材等运行数据", "用于计算、负载均衡、数据库、Redis、TOS 对象存储、CDN、安全防护和备份；具体启用资源以生产配置为准"],
            ["AI 模型与任务服务商", "提示词、任务参数，以及您主动选择提交的图片、视频、音频、文本或文档", "执行您发起的模型推理、生成、解析或转码任务；不同模型由不同服务商处理"],
            ["邮件与消息服务商", "邮箱、消息模板、投递状态和必要日志", "发送注册验证、密码重置、安全通知和服务消息"],
            ["支付、开票与结算服务商", "订单号、金额、支付状态、发票信息及必要的交易识别信息", "仅在相关功能启用且您主动使用时完成支付、退款、对账和开票"],
            ["登录与授权服务商", "第三方账号标识、授权凭证和必要的公开资料", "仅在微信、抖音等第三方登录正式启用且您主动授权时使用"],
          ]}
        />
        <p>我们会通过合同、权限控制、安全评估等方式要求受托方按照约定处理并保护信息。涉及独立第三方处理者时，我们会尽力通过页面提示、第三方清单或专项规则向您说明。</p>
        <p>发生合并、分立、重组、资产转让或破产清算等导致个人信息处理者变更的情形，我们将依法告知接收方信息，并要求其继续受本政策约束；处理目的或方式发生变化时，将重新取得必要同意。</p>
        <p>除获得您的授权或法律规定的情形外，我们不会公开披露您的个人信息。依法向监管、司法或执法机关提供信息时，我们会核验合法性并控制在必要范围内。</p>
      </LegalSection>

      <LegalSection id="privacy-storage" title="七、存储地点与期限">
        <p>当前面向中国大陆提供的生产服务原则上在中华人民共和国境内存储和处理数据。若您主动选择的模型或第三方服务涉及境外处理，我们将按照适用法律另行告知并履行相应程序；未完成必要程序前，不会仅为便利而主动向境外提供个人信息。</p>
        <p>我们仅在实现目的所需的最短期限内保留信息：</p>
        <ul>
          <li>账号、工作区和创作资产通常保留至您删除、退出相关工作区或注销账号；</li>
          <li>安全、访问和审计日志按照网络安全、争议处理和运营安全需要保留，法定最低留存期限优先适用；</li>
          <li>订单、支付、发票、合同和财税资料按照相关法律规定的期限保存；</li>
          <li>备份中的已删除数据会在备份轮换周期内逐步清除，在此期间仅用于灾难恢复并受到隔离保护。</li>
        </ul>
        <p>超过保存期限后，我们将删除或匿名化处理；法律法规要求继续保存或为争议解决所必需的除外。</p>
      </LegalSection>

      <LegalSection id="privacy-security" title="八、安全保护">
        <p>我们采用与风险相适应的保护措施，包括传输加密、密码哈希、访问控制、工作区隔离、敏感字段脱敏、密钥管理、操作审计、限流、备份恢复和安全监测。</p>
        <p>互联网服务无法保证绝对安全。发生或可能发生个人信息泄露、篡改、丢失时，我们将依法采取补救措施，并通过邮件、站内通知、公告或监管认可的方式告知相关情况；难以逐一告知时，将采用合理方式发布公告。</p>
        <p>请您使用高强度且独立的密码，启用可用的多因素认证，妥善保管 API 密钥，并避免在不可信设备和网络中处理敏感素材。</p>
      </LegalSection>

      <LegalSection id="privacy-rights" title="九、您的个人信息权利">
        <p>在适用法律规定范围内，您可以：</p>
        <ul>
          <li>通过账号设置访问、复制、更正或补充账号资料和认证信息；</li>
          <li>删除项目、素材、密钥或其他由您控制的内容；</li>
          <li>撤回基于同意的处理授权，但撤回不影响撤回前处理活动的合法性；</li>
          <li>申请解释本政策和自动化处理规则，并在对个人权益产生重大影响时依法提出异议；</li>
          <li>申请注销账号、删除个人信息或取得个人信息副本；</li>
          <li>对企业工作区管理员的处理行为，先向所属企业或组织提出请求。</li>
        </ul>
        <p>如页面暂未提供自助入口，可通过 {CONTACT_EMAIL} 联系我们。为保护账号安全，我们可能核验您的身份和请求范围。一般会在法律规定期限内答复；对于无正当理由的重复请求、涉及他人权益、商业秘密或法律要求保留的信息，我们可能依法限制响应并说明理由。</p>
      </LegalSection>

      <LegalSection id="privacy-minors" title="十、未成年人保护">
        <p>繁境主要面向具备完全民事行为能力的个人、专业创作者和组织用户。未满十四周岁的未成年人不得自行注册或提交个人信息；确需使用时，应由监护人阅读并同意相关规则，并在法律要求下取得监护人单独同意。</p>
        <p>如我们发现未经有效同意收集了未成年人的个人信息，将依法尽快删除或采取其他保护措施。监护人可通过联系邮箱提出请求。</p>
      </LegalSection>

      <LegalSection id="privacy-update" title="十一、政策更新">
        <p>我们可能因功能、第三方服务、法律法规或处理方式变化更新本政策。重大变更包括处理目的、信息类型、对外提供对象或您权利方式的实质变化。</p>
        <p>重大变更将通过页面提示、站内通知、邮件或其他合理方式告知，并在依法需要时重新取得您的同意。页面顶部的更新日期和版本号可帮助您识别变化。</p>
      </LegalSection>

      <LegalSection id="privacy-contact" title="十二、联系我们">
        <div className="legalContact">
          <p><strong>个人信息处理者：</strong>{OPERATOR}</p>
          <p><strong>网站：</strong>{WEBSITE}</p>
          <p><strong>个人信息保护与用户请求邮箱：</strong>{CONTACT_EMAIL}</p>
          <p><strong>ICP备案：</strong>{ICP}</p>
          <p>请在邮件中注明“隐私请求”，并说明账号邮箱、请求事项和必要证明。请勿直接通过普通邮件发送完整证件号码、密码、验证码或 API 密钥。</p>
        </div>
      </LegalSection>
    </>
  );
}

export default function LegalDocumentPage({ kind }: { kind: LegalDocumentKind }) {
  const tenant = useTenantRuntime();
  const OPERATOR = tenant.operatorName;
  const ICP = tenant.icpNumber || "备案信息待配置";
  const isPrivacy = kind === "privacy";
  const title = isPrivacy ? "隐私政策" : "用户服务协议";
  const toc = isPrivacy ? privacyToc : termsToc;

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title}｜Fanjin ${tenant.name}`;
    window.scrollTo({ top: 0, behavior: "auto" });
    return () => {
      document.title = previousTitle;
    };
  }, [tenant.name, title]);

  return (
    <PublicDocsShell toc={toc} tocLabel={`${title}目录`}>
      <section className="legalHero">
        <p className="legalEyebrow">法律与合规 / 2026.07</p>
        <h1>{title}</h1>
        <div className="legalMeta">
          <span>生效日期：{EFFECTIVE_DATE}</span>
          <span>更新日期：{EFFECTIVE_DATE}</span>
          <span>运营主体：{OPERATOR}</span>
        </div>
        <div className="legalNotice">
          {isPrivacy
            ? "本政策结合繁境的账号、工作区、企业认证、AI 生成、素材存储、API、日志和计费场景制定。"
            : "本协议适用于繁境网站、创作平台、企业工作区和开发者 API。请在注册或使用前完整阅读。"}
        </div>
      </section>

      <article className="legalArticle">
        {isPrivacy ? <PrivacyContent /> : <TermsContent />}
        <footer className="legalFooter">
          <p>{OPERATOR} · {ICP}</p>
          <p>© 2026 Fanjin. 保留所有权利。</p>
        </footer>
      </article>
    </PublicDocsShell>
  );
}
