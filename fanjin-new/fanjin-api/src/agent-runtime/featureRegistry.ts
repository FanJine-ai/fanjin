import { AgentRuntimePhase, ToolAvailability } from "@/agent-runtime/contracts";

export const AGENT_RUNTIME_FEATURE_IDS = [
  "permission-contract",
  "runtime-config-control-plane",
  "tool-catalog",
  "main-agent-runtime",
  "persistent-agent-thread",
  "sse-event-replay",
  "lease-worker-recovery",
  "command-idempotency",
  "project-session-toolpack",
  "script-toolpack",
  "asset-toolpack",
  "storyboard-canvas-toolpack",
  "specialist-delegation",
  "delegation-grant-enforcement",
  "approval-service",
  "generation-toolpack",
  "task-asset-writeback",
  "video-merge-toolpack",
  "delivery-toolpack",
  "reviewer-quality-gate",
  "model-profile-routing",
  "memory-message-source",
  "canvas-structured-commands",
  "project-budget-auto-execution",
  "legacy-socket-migration",
  "external-publishing",
  "destructive-delete",
  "cross-workspace-operation",
  "raw-system-access",
] as const;

export type AgentRuntimeFeatureId = (typeof AGENT_RUNTIME_FEATURE_IDS)[number];

export interface AgentRuntimeFeatureStatus {
  id: AgentRuntimeFeatureId;
  displayName: string;
  description: string;
  availability: ToolAvailability;
}

const preview = (
  reason: string,
  targetPhase: Exclude<AgentRuntimePhase, "A0" | "never">,
): ToolAvailability => ({ state: "preview", reason, targetPhase });

const disabled = (reason: string, targetPhase: Exclude<AgentRuntimePhase, "A0">): ToolAvailability => ({
  state: "disabled",
  reason,
  targetPhase,
});

export const AGENT_RUNTIME_FEATURES: Readonly<Record<AgentRuntimeFeatureId, AgentRuntimeFeatureStatus>> = {
  "permission-contract": {
    id: "permission-contract",
    displayName: "权限契约",
    description: "Agent 角色、工具风险、可用性、委派和最小策略判定契约。",
    availability: { state: "available", sincePhase: "A0" },
  },
  "runtime-config-control-plane": {
    id: "runtime-config-control-plane",
    displayName: "Agent 运行配置管理面",
    description: "平台管理员独立读取和更新版本化角色配置；不依赖 Agent Runtime 数据面开关，也不代表模型或领域工具已开放。",
    availability: { state: "available", sincePhase: "A0" },
  },
  "tool-catalog": {
    id: "tool-catalog",
    displayName: "工具目录",
    description: "服务端可发现、可按需加载的领域工具目录。",
    availability: preview("真实 Tool Registry、Schema 校验及项目/会话/领域查询/生成报价适配器已建立；plan.present R0 方案呈现工具已注册并随默认主 Prompt v6 暴露；canvas.commands.apply R1 画布命令已注册并随默认主 Prompt v7 暴露；pre-Run threads/ensure 不属于 Tool Catalog。R0/R1 ToolLoop 已接入默认关闭的新 Run admission 与持久化快照路由。", "A2"),
  },
  "main-agent-runtime": {
    id: "main-agent-runtime",
    displayName: "主 Agent 运行时",
    description: "主 Agent 的持久化运行、工具循环和恢复能力。",
    availability: preview("真实文本 executor、MainAgentToolLoopModel、多轮 Context、strict R1 evidence/claim/checkpoint、Approval、取消与重启已接入 Worker；FANJIN_AGENT_TOOLS_ENABLED 默认 0 且只控制新 Run admission，Worker 双 Processor 严格按持久化 toolsEnabled===true 路由并排空旧工具 Run。", "A3"),
  },
  "persistent-agent-thread": {
    id: "persistent-agent-thread",
    displayName: "持久化会话",
    description: "服务端保存并恢复 Agent 消息与运行记录。",
    availability: preview("Thread、Message、Run、Step、Event 与 CreationSession 已持久化；认证用户的 pre-Run threads/ensure 命令可在同一幂等事务中确保 Project、CreationSession、Thread，且不会创建 Run 或向模型开放。", "A1"),
  },
  "sse-event-replay": {
    id: "sse-event-replay",
    displayName: "SSE 事件回放",
    description: "按 Thread cursor 持久化并重放 Message、Run 和 Step 事件。",
    availability: preview("已支持持久化 Event、cursor 回放，并覆盖真实文本模型 Run 的完成/失败事件；仍是显式开启的预览能力。", "A1"),
  },
  "lease-worker-recovery": {
    id: "lease-worker-recovery",
    displayName: "租约 Worker 与恢复",
    description: "后台认领 Run、心跳、过期租约恢复和安全重放。",
    availability: preview("attempt 仅作单调 claim fence，recoveryCount/maxAttempts 表示恢复预算；新 Run 固定创建时上限，Worker 当前值作为安全 ceiling。queued 预算耗尽收尾、Run 锁内 checkpoint 重读、relay/billing 崩溃恢复、双 Processor 快照路由与同服 E2E 已闭环；工具 admission 默认关闭。", "A1"),
  },
  "command-idempotency": {
    id: "command-idempotency",
    displayName: "Agent 命令幂等",
    description: "消息、取消和工具副作用使用稳定幂等键。",
    availability: preview("pre-Run Project/CreationSession/Thread ensure、Thread 创建和消息提交已有稳定请求哈希、重放与冲突检测；project.ensure 不属于模型 Tool ID。", "A1"),
  },
  "project-session-toolpack": {
    id: "project-session-toolpack",
    displayName: "项目与创作会话工具包",
    description: "读取项目上下文并安全更新 CreationSession。",
    availability: preview("project.get/project.update/session.get/session.update 已通过 Gateway、strict 2.0 Schema、新鲜 evidence、版本 CAS/undo、单 Turn 单写、claim fence、checkpoint/replay 和 Step/Event 审计；创建资源仍只走认证用户 pre-Run 命令。R0/R1 新 Run admission 默认关闭。", "A2"),
  },
  "script-toolpack": {
    id: "script-toolpack",
    displayName: "剧本工具包",
    description: "剧本读取和可版本化草稿写入。",
    availability: preview("script.list/get 已注册到 Gateway，具备项目范围、分页/分段、资源证据、陈旧重放拒绝和 Step/Event 审计；script.draft.create/update(R1) 已注册，具备项目范围、全文内容指纹 CAS、输入派生证据稳定重放和幂等 Step/Event 审计；主 Prompt 已升级 v8，两个写工具只对 v8 主 Agent 模型目录暴露（R1、mutatesState、非计费，v2-v7 与委派子 Run 继续 fail-closed/R0-only），新 Run admission 默认开关不变。", "A2"),
  },
  "asset-toolpack": {
    id: "asset-toolpack",
    displayName: "资产工具包",
    description: "资产检索、资产设定和不可变版本引用。",
    availability: preview("asset.search/get/version.list 已注册到 Gateway，严格校验项目与选中版本归属且不返回路径、URL 或内部错误；只对显式准入的新工具 Run 可见，资产写入仍关闭。", "A2"),
  },
  "storyboard-canvas-toolpack": {
    id: "storyboard-canvas-toolpack",
    displayName: "分镜与画布工具包",
    description: "使用带 revision 的领域命令编辑分镜和画布。",
    availability: preview("storyboard.list/get 与 canvas.get 已注册到 Gateway，具备关联资源证据、有界安全投影和 legacy 异常 fail-closed；canvas.commands.apply(R1) 已注册并随主 Prompt v7 模型可见，见 canvas-structured-commands；只对显式准入的新工具 Run 可见，分镜写命令仍关闭。", "A2"),
  },
  "specialist-delegation": {
    id: "specialist-delegation",
    displayName: "专项 Agent 委派",
    description: "主 Agent 委派编剧、视觉、分镜和监督角色。",
    availability: preview("历史 v4/V1 Writer/Storyboard 与当前 v5/V2 Writer/Visual/Storyboard/Reviewer 的 Coordinator、child Worker、Completion、取消和精确重放已内部闭环；新准入默认关闭，Executor 与 R2/R3 执行未接入。", "A4"),
  },
  "delegation-grant-enforcement": {
    id: "delegation-grant-enforcement",
    displayName: "委派授权强制执行",
    description: "服务端签发、消费和撤销 DelegationGrant。",
    availability: preview("服务端签发、HMAC 签名校验、父级缩权、TTL、Run/角色/资源范围绑定、配额与同事务单次消费/精确重放已落地，并由四个 proposal-only 专项角色的 child Run 强制消费；外部 admission 仍默认关闭。", "A2"),
  },
  "approval-service": {
    id: "approval-service",
    displayName: "审批服务",
    description: "为 R2/R3 工具签发绑定精确 scope 的审批证据。",
    availability: preview("精确 Approval、TTL/CAS、暂停/原子 requeue、恢复分页、取消竞态与安全事件已闭环；v15 consumedStepId 不可回滚地绑定实际消费 Tool Step，过 TTL 仅允许该 terminal Step 重放。真实 R2/R3 副作用仍关闭。", "A2"),
  },
  "generation-toolpack": {
    id: "generation-toolpack",
    displayName: "生成工具包",
    description: "统一图片、视频生成报价、提交、取消和重试。",
    availability: preview("generation.quote、图片/视频 submit 与 task list/get/cancel/retry 已注册到 Gateway。付费 submit/retry 以不可变 quoteId 固定 Relay requestId、供应商和 GU 幂等边界；取消后如供应商或账务未闭合会公开为 pending_reconcile，禁止假成功与重复重试。0.0.8 启用要求 Runtime/Worker/Model/Tools 四层开关与 FANJIN_AGENT_GENERATION_SUBMIT_ENABLED=1，并且 /api/ready 的 PostgreSQL 池、稳定对象存储、对象写补偿 Worker 与积压检查全部为绿色。", "A3"),
  },
  "task-asset-writeback": {
    id: "task-asset-writeback",
    displayName: "任务到资产回写",
    description: "生成成功后确定性创建 AssetVersion 并回填画布。",
    availability: preview("图片生成以 durable checkpoint 恢复并原子写 o_media_asset + o_assets/o_image；视频由真实 Relay 任务轮询/回调，终态媒体先镜像到受控对象存储，再原子写同三表并回填 assetVersionId。两条链路均绑定工作区/项目，视频不会把上游临时 URL 当成成片资产。真实执行受 FANJIN_AGENT_GENERATION_SUBMIT_ENABLED 与 /api/ready 的 durable object-write 门共同约束。", "A3"),
  },
  "video-merge-toolpack": {
    id: "video-merge-toolpack",
    displayName: "成片拼接工具包",
    description: "把多段视频资产版本按顺序拼接为完整成片（ffmpeg concat demuxer，流复制优先、重编码回退）。",
    availability: preview("video.merge(R2)已注册到 Gateway:证据相位只读校验段归属/类型/数量、impactSummary 审批通道(本地计算不铸造 GU 报价)、执行相位 ffmpeg 拼接并同链路写 o_media_asset + o_assets/o_image;拼接失败回结构化 JSON,不自动重试。AGENTKIT-ADOPTION-CHECKLIST P2。", "A4"),
  },
  "delivery-toolpack": {
    id: "delivery-toolpack",
    displayName: "交付工具包",
    description: "交付版本、预览、导出和分享。",
    availability: preview("delivery.preview(R0 只读)已注册到 Gateway:输入项目内资产版本,返回限时签名预览链接(远端存储签名 TTL 跟随对象存储配置,本地存储返回站内 URL);Deliverable 领域对象、delivery.draft.create/publish/share 仍未建立。AGENTKIT-ADOPTION-CHECKLIST P3。", "A4"),
  },
  "reviewer-quality-gate": {
    id: "reviewer-quality-gate",
    displayName: "质量监督门禁",
    description: "监督 Agent 读取真实快照并产出不可变审核报告。",
    availability: preview("Reviewer 的只读证据、严格报告契约、无可执行操作校验、append-only 记录及与 child/parent 终态同事务提交和精确重放已内部闭环；自动阻断发布或交付的强制质量门仍未实现。", "A4"),
  },
  "model-profile-routing": {
    id: "model-profile-routing",
    displayName: "角色模型路由",
    description: "Agent Role 解析为 Model Profile，再进入统一模型通道路由。",
    availability: preview("六角色 Prompt/Skill/Profile 与持久化覆盖已建立；默认 Prompt v7（v6 边界 + canvas.commands.apply 指引）可在四层开关与 tools Profile 合格时进入 R0/R1 ToolLoop 并暴露画布命令，v6（v2 工具边界 + plan.present 指引）与 v2 保持注册供既有快照解析，只有显式固定 v3 才增加 project.update/session.update R1；v4/V1 与 v5/V2 已支持四个 A4 proposal-only 角色执行并按旧快照排空；Executor 尚未接入。", "A3"),
  },
  "memory-message-source": {
    id: "memory-message-source",
    displayName: "消息事实源与记忆分层",
    description: "Message 作为事实源，摘要与 RAG 仅作为辅助上下文。",
    availability: preview("新 Runtime 的 MainAgentExecutor 已以持久化 o_agent_message 作为多轮事实源；摘要压缩、RAG 和长期记忆分层尚未实现。", "A2"),
  },
  "canvas-structured-commands": {
    id: "canvas-structured-commands",
    displayName: "画布结构化命令",
    description: "通过 revision、幂等和撤销信息修改画布，而非覆盖整图。",
    availability: { state: "available", sincePhase: "A5" },
  },
  "project-budget-auto-execution": {
    id: "project-budget-auto-execution",
    displayName: "项目预算内自动执行",
    description: "在用户明确设置的单次和每日预算内自动执行 R2 工具。",
    availability: preview("项目级 GU 预算(agentBudgetMicros/agentBudgetReservedMicros)已落地:预算内 R2 审批在 pauseForApproval 同事务自动批准、Run 直接转 queued 恢复,预留随审批 consumed/expired/denied/revoked 同事务回滚;整体受 FANJIN_AGENT_AUTO_APPROVE_ENABLED(默认 0)灰度控制,关闭时全部走人工;GET/PUT /api/agent/projects/:id/budget 已开放;对账 reconcile 列后续。", "A6"),
  },
  "legacy-socket-migration": {
    id: "legacy-socket-migration",
    displayName: "旧 Agent 链路迁移",
    description: "把旧 Socket、XML 和浏览器模型调用迁移到持久化 Runtime。",
    availability: disabled("旧链路仍存在，只能作为 legacy 兼容入口。", "A5"),
  },
  "external-publishing": {
    id: "external-publishing",
    displayName: "外部发布",
    description: "发布、分享或向外部系统发送内容。",
    availability: disabled("外部副作用必须等待 R3 精确审批、撤销和审计链路。", "A5"),
  },
  "destructive-delete": {
    id: "destructive-delete",
    displayName: "永久删除",
    description: "永久删除项目、资产或交付物。",
    availability: disabled("引用检查、延迟删除和恢复窗口尚未实现。", "A5"),
  },
  "cross-workspace-operation": {
    id: "cross-workspace-operation",
    displayName: "跨工作区操作",
    description: "跨工作区读取、复制或移动资源。",
    availability: disabled("Agent 必须维持单工作区沙箱，当前没有开放计划。", "never"),
  },
  "raw-system-access": {
    id: "raw-system-access",
    displayName: "原始系统访问",
    description: "原始 SQL、Shell、供应商密钥和对象存储访问。",
    availability: disabled("R4 特权系统能力永久禁止暴露给 Agent。", "never"),
  },
};

export const UNOPENED_AGENT_RUNTIME_FEATURES = AGENT_RUNTIME_FEATURE_IDS.map(
  (id) => AGENT_RUNTIME_FEATURES[id],
).filter((feature) => feature.availability.state !== "available");

export function getAgentRuntimeFeatureStatus(id: AgentRuntimeFeatureId): AgentRuntimeFeatureStatus {
  return AGENT_RUNTIME_FEATURES[id];
}
