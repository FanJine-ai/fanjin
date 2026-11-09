export type ReleaseNote = {
  id: string;
  version: string;
  date: string;
  title: string;
  summary: string;
  groups: Array<{ label: string; items: string[] }>;
};

// Public copy only: describe verified user-visible changes and required user actions.
// Keep supplier configuration, processing pipelines, security internals and release operations in internal docs.
export const FRONTSTAGE_RELEASE_NOTES: ReleaseNote[] = [
  {
    id: "0.2.6-workbench-experience",
    version: "Fanjin v0.2.6",
    date: "2026-09-10",
    title: "工作台与后台体验更新",
    summary: "统一明暗主题、字体与页面布局，改善登录、项目创作和导航体验。",
    groups: [
      { label: "创作体验", items: [
        "未登录时可先浏览创作首页，登录后继续编辑保存的想法。",
        "修复开始创作进入画布的流程，完善项目选择与失败重试提示。",
        "创作模式自动收起导航，切页、展开与收起更平滑。",
      ] },
      { label: "界面与账户", items: [
        "统一创作台、用户后台和平台后台的字体、颜色与图表样式。",
        "新增账户菜单和更多菜单的充值入口，优化余额展示。",
        "优化手机导航、登录表单和窄屏布局，支持系统减少动态效果设置。",
      ] },
    ],
  },
  {
    id: "0.2.3-api-surface",
    version: "Fanjin v0.2.3",
    date: "2026-09-05",
    title: "开发者 API 地址更新",
    summary: "更新开发者 API 地址，方便接入和管理视频任务。",
    groups: [
      {
        label: "开发者 API",
        items: [
          "OpenAI 与 Anthropic 兼容接口统一使用 /v1，Gemini 使用 /v1beta，火山兼容接口使用 /api/v3。",
          "废弃 /api/v1、/api/v1beta 与 /api/relay 等历史别名；这些地址现在固定返回 404。",
          "视频任务的创建、查询与取消统一到 /api/v3/contents/generations/tasks。",
        ],
      },
    ],
  },
  {
    id: "0.2.2-model-plaza-themes",
    version: "Fanjin v0.2.2",
    date: "2026-09-01",
    title: "模型广场、双主题与分时计费",
    summary: "模型广场升级为可搜索、筛选和对比的模型目录，并补全输入/输出分价与分时计费。",
    groups: [
      {
        label: "新增",
        items: [
          "新增模型分组、厂商、能力和计费方式筛选，以及价格与上下文排序。",
          "新增卡片和表格两种目录视图、模型详情抽屉与模型 ID 快速复制。",
          "新增浅色与深色主题切换，并记住当前主题和目录视图偏好。",
          "文本模型可独立配置输入与输出 Token 价格，并支持按时区、星期与跨午夜时段设置价格倍率。",
        ],
      },
      {
        label: "优化",
        items: [
          "更新模型与厂商图标，方便识别模型。",
          "重新组织模型价格、上下文和能力标签，提升模型比较效率。",
          "使用分时价格的任务按提交时的价格计费，跨时段完成不会改变价格。",
          "优化桌面与移动端的模型目录布局，并支持 ⌘/Ctrl + K 快捷搜索。",
        ],
      },
    ],
  },
  {
    id: "0.1.3-creation-routing-release",
    version: "Fanjin v0.1.3",
    date: "2026-08-17",
    title: "画布、Agent 与资产体验优化",
    summary: "改善画布创作、Agent 对话与工作区资产的使用体验。",
    groups: [
      {
        label: "创作与资产",
        items: [
          "修复 Agent 对话与项目隔离、新项目默认对话、账号与工作区资产共享，以及人物素材检查链路。",
          "改善画布创作入口与导航交互，完善图片和视频分辨率选项。",
        ],
      },
    ],
  },
  {
    id: "0.1.2-model-operations-release-control",
    version: "Fanjin v0.1.2",
    date: "2026-08-14",
    title: "模型目录与价格展示优化",
    summary: "改善模型目录与价格展示的一致性。",
    groups: [
      {
        label: "体验优化",
        items: ["统一创作台、开发者目录与模型广场的模型信息和价格展示。"],
      },
    ],
  },
  {
    id: "2026-07-11-creation-flows",
    version: "Fanjin V4 · 2026.07.11",
    date: "2026-07-11",
    title: "创作链路与工作台增强",
    summary: "生成、资产、小说、剧本和画布体验完成一轮集中升级。",
    groups: [
      {
        label: "新增",
        items: [
          "补齐图片与视频生成、任务追踪和资产沉淀的完整链路。",
          "统一小说与剧本工作区，让长内容创作入口保持一致。",
        ],
      },
      {
        label: "优化",
        items: [
          "改善画布浏览与编辑交互，并统一产品品牌为“繁境”。",
        ],
      },
    ],
  },
  {
    id: "2026-07-10-quick-create",
    version: "Fanjin V4 · 2026.07.10",
    date: "2026-07-10",
    title: "快速创作与 Agent 体验升级",
    summary: "重新组织从灵感输入到 Agent 协作的首屏体验。",
    groups: [
      {
        label: "体验",
        items: [
          "重设计快速创作工作台，强化创意导演、图片生成和视频生成入口。",
          "简化 Agent 初始状态，让新对话和技能选择更聚焦。",
        ],
      },
    ],
  },
];

export const latestReleaseNotificationId = `release:${FRONTSTAGE_RELEASE_NOTES[0].id}`;

export function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
