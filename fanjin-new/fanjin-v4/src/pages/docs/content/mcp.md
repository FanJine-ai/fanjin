## 接入前准备 {#mcp-start}

MCP 让 AI 客户端发现并调用繁境工具。繁境 MCP 与 CLI 共用工具权限、任务记录和素材数据，可以完成查询、上传、报价、预算确认、生成和下载。

### 操作画布与工作台

连接后先调用 `fanjin_context_get` 确认当前工作区和可用工具。`fanjin_studio_operations` 可查询素材、生成历史、小说、剧本、分镜、剪辑、Agent 会话等操作；指定 `operation` 获取所需参数，再交给 `fanjin_studio_execute` 执行。实际可用操作取决于连接密钥的授权。

| 需求 | 调用入口 |
| --- | --- |
| 新建节点、修改提示词、排列 | `fanjin_canvas_nodes_create` / `nodes_update` / `arrange` |
| 复制删除、连线、分组、模型参数、转绘、合成、撤销 | `fanjin_canvas_graph_edit` |
| 按依赖顺序执行一组节点 | `fanjin_canvas_execution_plan` 先出计划，再逐项报价、提交和回填 |
| 素材分类、分组、回收站、引用和历史 | Studio 中的 `assets.*` / `files.*` / `history.*` |
| 剧本分镜、镜头生产与剪辑 | Studio 中的 `scripts.*` / `storyboards.*` / `production.*` / `editing.*` |
| 查询费用和账目 | `fanjin_task_billing` / `fanjin_analytics_query` |

画布编辑须先读取最新 `revision`，使用同一个请求键重试。发生版本冲突时重新读取，避免覆盖其他人的编辑。查询账目独立于取片流程。

本地桥接还提供 `fanjin_local_media_edit`，可裁剪、旋转、翻转、拆图和抽帧；需安装 ffmpeg 并配置允许的素材目录。处理结果是新文件，原文件保留，再用 `fanjin_local_upload` 入库。上传可指定 `usage` 设置用途分类。

文字与语音 API 调试可用本地 `fanjin_relay_request`，沿用中转密钥的模型和额度设置，可能产生费用。组合制作流程需额外授权 `workflow:execute`；旧密钥不会自动增加权限。带模型限制或额度上限的密钥继续使用逐项报价生成工具，组合流程不会绕过这些限制。密码、真人核验、付款及敏感管理操作由 `fanjin_human_continue` 返回本人接续入口，无需把密码或验证码发给 Agent。

如果服务端列出了新工具而客户端看不到，请断开后重新连接，刷新工具目录。

> MCP 与 CLI 工具服务已纳入繁境主线。前往[工作区 → MCP / CLI 连接](#/workspace/connections)创建连接密钥、复制客户端配置并执行只读连接检测。私有部署需要匹配的 API、Worker 和数据库版本。

准备工作：

1. 获取已开通工具服务的 HTTPS 站点地址。
2. 创建绑定有效工作区成员的 API Key，至少具备 `mcp:connect` 和所需业务工具权限。
3. 选择支持自定义鉴权请求头的远程 MCP 客户端，或使用本地 stdio 桥接。
4. 先执行 `fanjin_context_get` 与只读查询确认身份，再开放创作权限。

当前使用 API Key，不提供 OAuth 登录授权。仅支持 OAuth、无法配置请求头或本地桥接的客户端暂不能直接接入。MCP 不等于 Responses 请求体中的内置 MCP 工具，两者是不同入口。

## 远程连接 {#mcp-remote}

| 配置项 | 值 |
| --- | --- |
| 传输 | Streamable HTTP，支持 JSON 或请求级 SSE 响应 |
| 地址 | `https://你的站点/api/mcp` |
| 方法 | POST |
| 鉴权 | `X-API-Key: <工作区 API Key>`，或 `Authorization: Bearer <工作区 API Key>` |
| 默认项目（可选） | 地址追加 `?projectId=123`，不会扩大访问权限 |

在客户端的 MCP 设置中填写地址与请求头。不同客户端的配置字段不同，以下是连接参数示意，并非可直接粘贴到所有客户端的通用配置文件：

```json
{
  "transport": "streamable-http",
  "url": "https://your-fanjin.example/api/mcp",
  "headers": {
    "X-API-Key": "<由客户端秘密配置注入>"
  }
}
```

不要同时传两个不同的 Key；不要把 Key 放在 URL 或聊天提示词里。浏览器直接打开 MCP 地址使用的是 GET，可能收到 405，这是预期的方法限制，不能据此判断服务未部署。

服务端通过协议 SDK 处理工具发现与调用，并兼容旧版初始化握手。客户端应自行协商协议版本。传输机制参考 [MCP 官方规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)。

## 本地 stdio 桥接 {#mcp-stdio}

仅支持本地命令的客户端，可以运行 [CLI 源码包](#/docs/cli#cli-install)中的桥接命令。需要 Node.js 22+，桥接连接同一个远程工具服务，不在本机启动繁境后端。

| 字段 | 配置 |
| --- | --- |
| command | `node`，桌面客户端无法找到时填 Node 可执行文件绝对路径 |
| args | CLI 包中 `bin/fanjin.mjs` 的绝对路径、`mcp`、`serve` |
| 环境变量 | `FANJIN_API_URL`、`FANJIN_API_KEY` |

```json
{
  "command": "node",
  "args": ["/absolute/path/fanjin-cli/bin/fanjin.mjs", "mcp", "serve"],
  "env": {
    "FANJIN_API_URL": "https://your-fanjin.example/api"
  }
}
```

在客户端的安全环境配置中另外注入 `FANJIN_API_KEY`。桌面客户端不一定继承终端环境变量，也不要假定配置里的 `${FANJIN_API_KEY}` 会自动展开。

桥接只在 stdout 输出协议消息，日志写 stderr。不要用打印欢迎语的 shell 包装器污染 stdout。停止桥接不会自动取消服务器上已提交的生成任务。

## 工具目录与权限 {#mcp-tools}

工具发现只返回当前身份允许使用的工具，实际参数以客户端获取的 `inputSchema` 为准。本版本定义 36 个远程工具；不同权限、部署配置可能显示更少。本地上传工具另计。

| 工具 | 用途 | Key 权限 |
| --- | --- | --- |
| `fanjin_analytics_query` | 账号、工作区用量、流水与后台导出 | 按 action 与范围校验，见下文 |
| `fanjin_context_get` | 当前工作区、身份和可用工具 | 有效工作区 Key |
| `fanjin_projects_list` | 分页列项目 | `project:read` |
| `fanjin_project_get` | 项目详情 | `project:read` |
| `fanjin_project_create` | 创建项目与默认画布 | `project:create` |
| `fanjin_models_list` | 图片 / 视频模型列表 | `model:read` |
| `fanjin_model_get` | 模型能力 | `model:read` |
| `fanjin_billing_balance` | 工作区账本余额 | `billing:read` |
| `fanjin_canvas_get` | 已保存画布摘要 | `project:read` |
| `fanjin_canvas_nodes_create` | 批量新建文本、图片、视频节点 | `project:write` |
| `fanjin_canvas_nodes_update` | 批量修改节点标题、提示词、文本正文 | `project:write` |
| `fanjin_canvas_arrange` | 网格、横排、竖排或指定位置排列 | `project:write` |
| `fanjin_assets_list` | 项目素材列表 | `asset:read` |
| `fanjin_asset_get` | 素材与版本详情 | `asset:read` |
| `fanjin_upload_prepare` | 创建上传会话 | `asset:write` |
| `fanjin_upload_get` | 查询上传状态 | `asset:read` |
| `fanjin_upload_complete` | 核验并登记上传素材 | `asset:write` |
| `fanjin_generation_quote` | 保存生成请求并报价 | `generation:quote` |
| `fanjin_approval_request` | 请求网页预算确认 | `generation:create` |
| `fanjin_approval_confirm` | 密钥所属用户直接确认或拒绝报价 | `generation:create` |
| `fanjin_approval_get` | 查询确认结果 | `generation:read` |
| `fanjin_generation_submit` | 提交已批准的生成 | `generation:create` |
| `fanjin_tasks_list` | 项目生成任务列表 | `generation:read` |
| `fanjin_task_get` | 任务状态和保存结果 | `generation:read` |
| `fanjin_task_wait` | 有界等待原任务，最多 20 秒 | `generation:read` |
| `fanjin_task_billing` | 独立查询任务冻结、扣费、释放和退款 | `billing:read` |
| `fanjin_canvas_attach` | 把已保存作品放回指定节点 | `project:write` |
| `fanjin_task_recover` | 按原幂等键找回任务 | `generation:read` |
| `fanjin_task_cancel` | 取消尚未派发的工具任务 | `generation:create` |
| `fanjin_asset_download` | 获取授权下载指引 | `asset:download` |
| `fanjin_history_list` | 当前 Key 的工具生成历史 | `generation:read` |
| `fanjin_asset_rename` | 带版本检查的素材重命名 | `asset:write` |
| `fanjin_portrait_asset_register` | 主动登记或复用图片、视频人像资产 | `asset:write` |
| `fanjin_portrait_admission_retry` | 重试服务失败的素材检查 | `asset:write` |
| `fanjin_portrait_admission_declare` | 用户确认后提交真实来源声明 | `asset:write` |
| `fanjin_portrait_admission_authorize` | 发起真人授权并取得网页链接 | `asset:write` |

通过 MCP 调用以上工具还需要 `mcp:connect`。密钥权限与工作区成员权限取交集：查询通常需要成员 `project:read`，项目或素材写入需要 `project:write`，生成与报价需要 `generation:create`，余额查询需要 `billing:read`。

列表通常接受 `limit`（默认 20，最大 100）和 `cursor`。项目和素材 ID 按工具 schema 传数字；报价、批准、任务与上传会话使用 UUID。模型列表的 `available` 表示配置可用，不等于已完成实时供应商探测。

## 用量查询与后台导出 {#mcp-analytics}

`fanjin_analytics_query` 与 CLI 共用查询协议。支持 `balance`、`summary`、`usage`、`usage-detail`、`ledger`、`ledger-detail`、`export`、`export-create`、`export-jobs`、`export-status`、`export-cancel`、`export-part`。

```json
{
  "action": "usage",
  "scope": "workspace",
  "executionStatus": "failed",
  "failureCategory": "timeout",
  "limit": 20
}
```

- `usage:read` 只允许当前 Key 的用量；`usage:read:workspace` 还要求成员具有 `api_key:read` 或 `billing:read`。
- 财务数据需要 Key 和成员双方的 `billing:read`；`account:read` 单独授权 Key 所属用户的账号范围。平台管理员身份不会自动扩大工作区 Key 权限。
- `from` / `to` 使用毫秒时间戳，区间左闭右开、最长 366 天；`status` 是结算状态，`executionStatus` 是执行状态。
- 创建后台导出使用 `export-create` 与显式 `idempotencyKey`；用返回的 `id` 查询、取消或通过 `export-part` 下载。分段从 0 开始，直到 `nextPart` 为 null。结果保留 24 小时，且只允许创建时的凭据下载。
- 余额和消费返回精确十进制字符串。通用余额、赠额、授信分别计算；**1 元 = 10 GU，1 GU = 100000000 账本原始单位**。

查询不会发起付费生成；后台导出会创建持久任务，关闭客户端不会取消。

## 从素材到生成作品 {#mcp-workflow}

1. **绑定项目并选模型。** 连接地址可添加 `?projectId=123&canvasId=456`；`fanjin_context_get` 回显当前绑定。不会自动猜测或切换项目，所有操作仍校验权限。
2. **复用或上传素材。** 已有素材直接使用 `assetVersionId`。本地桥接启用允许目录后，用 `fanjin_local_upload` 一次完成上传和入库。登记由后台处理，不要求先等人像检查完成再报价。
3. **报价后提交。** `fanjin_generation_quote` 回显最终参数、GU 上限和人民币。用户已有预算授权时直接 `fanjin_generation_submit`，可传 `budgetGu` 限制最高 GU，无需额外调用批准工具；报价超过上限会拒绝提交。
4. **等待并取回作品。** 用 `fanjin_task_wait` 或 `fanjin_task_get` 查询同一任务。`deliveryReady: true` 表示作品已保存；可下载，也可按下面说明回填节点。费用更新不阻断作品交付。

报价工具参数示例（替换项目及模型 ID）：

```json
{
  "request": {
    "projectId": 123,
    "type": "video",
    "modelId": "替换为工具模型目录返回的 ID",
    "prompt": "海边灯塔，清晨的光线，镜头缓缓推进",
    "aspectRatio": "16:9",
    "resolution": "720p",
    "duration": 5,
    "count": 1,
    "audio": false,
    "references": []
  },
  "idempotencyKey": "quote-lighthouse-001"
}
```

参考素材使用 `assetVersionId` 字符串，角色可为 `subject`、`style`、`storyboard`、`first_frame`、`last_frame`，组合由模型约束。

报价默认有效期 15 分钟，一份报价与批准最多消费一次。`fanjin_generation_submit` 省略 `approvalId` 时会按密钥所属用户身份确认并提交，可能消耗 GU；客户端应在用户授权预算后调用。显式传入 `approvalId` 时沿用该批准结果。过期、价格或能力变化需要重新报价并确认。

普通生成可省略画幅、分辨率、视频时长，服务端从该模型目录补默认值，并在报价中完整回显。原生编辑和延长需明确对应参数，不套用普通生成默认值。

### 本地一键上传

远程 MCP 不读取本机路径。使用 `fanjin mcp serve` 本地桥接，在客户端的安全环境配置中设置 `FANJIN_UPLOAD_ROOTS`（允许素材目录的 JSON 数组，例如 `["/absolute/media"]`），可用 `fanjin_local_upload({file: "/absolute/media/scene.mp4", projectId: 123})` 一次上传。可选 `FANJIN_PROJECT_ID` / `FANJIN_CANVAS_ID` 固定上下文。未配置允许目录时不提供此工具；符号链接不能越出目录。文件字节走上传通道，不进入对话 JSON。相同项目、文件和名称重试复用原上传会话；远程 HTTP 仍支持 prepare → PUT → complete。

### 等待、查账和回填

`fanjin_task_wait({taskId, waitMs: 10000})` 最多等待 20 秒，到期返回当前进度，继续等待同一编号即可。生成状态与账单状态独立：视频已完成时正常交付，费用记录可单独查询，不要求用户人工对账。旧的“待核账”生成任务由 Worker 自动查询原受理记录，结果不明时不会换键重投。恢复超过 24 小时仍无结果则报告结果暂不可用，不编造费用结算。

查账独立使用 **`fanjin_task_billing({taskId})`**，或 HTTP **`POST /api/tools/v1/fanjin_task_billing`**。返回 `maximum`、`frozen`、`charged`、`released`、`refunded`、`netCharged`，每项含精确字符串 `gu` 和 `yuan`（1 元 = 10 GU）。`amountsKnown: false` 时金额是 `null`，不是零。冻结不是实际扣费，释放冻结不是退款；该接口不修改账单，也不发起生成。

将作品放回画布：先调用 `fanjin_canvas_get` 获取节点 ID 与 `revision`，提交时可增加 `targetCanvas: {canvasId, nodeId, expectedRevision}`。也可在完成后调用 `fanjin_canvas_attach({projectId, canvasId, taskId, nodeId, expectedRevision, idempotencyKey})`。只允许本项目已保存的图片/视频回填到匹配类型的现有节点，需 Key 和成员都有 `project:write`。画布已被编辑时返回版本冲突，作品仍保存在资产库；重新读取后明确选择回填。`canvasDelivery` 报告回填结果。需要读取节点文字时，给 `fanjin_canvas_get` 加 `includeContent: true`；默认只返回摘要。

旧密钥不会自动增加画布写权限，需要在密钥设置中启用；新建完整创作连接预设包含该权限。不要把供应商临时 URL 当作已经归档的作品。

### 建节点、改提示词和排列

先用 `fanjin_canvas_get({projectId, canvasId, includeContent: true})` 读取已保存节点和 `revision`。三项编辑工具均需 `project:write`、`expectedRevision` 和 `idempotencyKey`；只修改画布，不提交生成、不冻结额度。每一步使用上一步返回的新 `revision`。

例如创建两个视频节点：

```json
{
  "projectId": 123,
  "canvasId": 456,
  "expectedRevision": 1,
  "idempotencyKey": "canvas-scenes-001",
  "nodes": [
    {"type": "video", "title": "镜头一", "prompt": "清晨海岸，缓缓推近", "aspectRatio": "16:9"},
    {"type": "video", "title": "镜头二", "prompt": "灯塔亮起，镜头拉远", "aspectRatio": "16:9"}
  ]
}
```

将此参数传给 `fanjin_canvas_nodes_create`；每次最多 50 个，返回 `nodes[].id`。文本节点用 `text` 写正文，`prompt` 单独保存。可为每个节点指定 `position: {x, y}`，省略则接在已有节点下方。

- **修改文字：** `fanjin_canvas_nodes_update` 传 `updates: [{nodeId, title, prompt, text}]`，最多 50 个，仅修改提供的字段；`text` 仅适用于文本节点。正在生成的节点不可改提示词，避免显示内容与实际任务不一致；修改不会重投已有任务。
- **排列：** `fanjin_canvas_arrange` 传 `nodeIds`（最多 100 个）与 `mode: "grid" | "horizontal" | "vertical"`，按节点尺寸留间距。网格可指定 `columns`，自动排列可指定 `origin: {x, y}` 与 `gap`（40–1000）。手动模式 `mode: "manual"` 传一一对应的 `positions: [{nodeId, x, y}]`。只移动所选节点，保留连接、分组、视图和作品。
- **冲突与重试：** 同一批中任意节点无效，整批不保存。`CANVAS_REVISION_CONFLICT` 时重新读取并检查最新内容，再用新幂等键提交；网络超时则用原键、原参数查询重试，避免重复创建。重放回执的 `revision` 是原操作版本，`currentRevision` 是当前版本，继续编辑前重新读取。

编辑基于服务端已保存画布，不能读取网页尚未保存的草稿。网页有未保存内容时先保存；外部编辑后重新载入画布即可看到新节点。新节点可以继续用于报价提交的 `targetCanvas`，或生成完成后的 `fanjin_canvas_attach`。

## 人物参考素材与审核 {#mcp-portraits}

**MCP / CLI 使用平台项目素材流程，无需调用独立人像中转接口，也无需工作区另配火山 AK/SK 或追加 `relay:portrait_assets:*` 权限。** 上传后平台处理适用的检测、审核和供应商同步；需要用户确认来源或授权时，由用户在项目素材中完成。

`fanjin_upload_complete`、`fanjin_asset_get` 与 `fanjin_assets_list` 的素材对象包含 `portraitAdmission`。素材顶层的 `status: "active"` 只表示文件已保存，不表示审核已通过。查询特定版本：

```json
{"projectId": 123, "assetId": 456, "assetVersionId": 789}
```

将以上参数传给 `fanjin_asset_get`，根据 `portraitAdmission` 处理：

**人像预检仅作提示，不是开始生成的前置条件。** `blocking: false`、`canSubmitForProviderReview: true` 表示可继续报价，经用户确认预算后提交；检测中、失败、待确认或登记准备中均不因此拒绝提交。平台优先使用当前通道有效的登记资产，否则保留原始素材交给生成平台审核。这不代表人像检查已通过。上游明确拒绝会返回任务失败原因，不自动重投；授权撤销、管理员禁止使用和已收到的上游明确拒绝仍须处理。

| 状态 | 下一步 |
| --- | --- |
| `processing` | 可后台查询检查或登记进度；`blocking: false` 时可直接继续生成流程 |
| `action_required` | 阅读 `blocking`、`message` 和 `error`；未阻断时可先生成，也可处理来源声明或登记 |
| `ready` | 使用该 `assetVersionId` 字符串作为生成参考并报价；目标模型和通道适配仍在报价、提交时校验 |
| `unavailable` | 尚无准入记录，`blocking: null`；在项目素材中检查，不能推断通过或平台缺少凭据 |
| `null` | 此媒体类型不适用人像准入，例如音频；仍受模型的输入约束 |

已上传且已检测到人像，或已完成来源声明的素材，可调用 **`fanjin_portrait_asset_register`** 主动绑定平台人像通道并启动登记：

```json
{"projectId": 123, "assetVersionId": 789, "idempotencyKey": "portrait-register-789-001"}
```

需要 `asset:write` 和项目写权限，不需要独立人像中转权限。可选 `expectedRevision` 使用最近一次 `portraitAdmission.revision`。已登记的资产会复用；重复请求保留原幂等键。回执 `registration.status: "processing"` 仅表示已启动登记，`registered` 才表示已登记；回执是本次操作的快照，后续用 `fanjin_asset_get` 查询至 `portraitAdmission.status: "ready"`。通道未配置会返回 `portrait_provider_channel_unavailable`，不会假报登记成功。此操作不创建视频任务或冻结生成预算。

检测到人像的素材会自动排队登记，无需额外声明。来源未明确的视频先进行首尾帧、均匀时间点和镜头切换处的有限抽帧检测；未检出人脸只代表所抽帧未检出，不能证明整段视频无人像。检测失败或未能确定时，`nextAction: "confirm_source"` 提供来源确认入口；选择声明或登记时须展示免责声明并取得用户真实来源确认：`ordinary_no_person` 走普通素材，`fully_virtual_person` 走整段视频人像登记；真人还须完成授权。`blocking: false` 时无需等待此确认即可报价和提交生成。

用户已经明确确认视频中的人物是 AI 虚构角色，并接受来源及使用权声明时，无需等待抽帧检测，即使 `nextAction: "wait_for_scan"`，也可调用 `fanjin_portrait_admission_declare`，提交 `choice: "fully_virtual_person"`、`termsAccepted: true`。这表示开始登记，使用上游登记资产须等待登记有效；未阻断的原始素材仍可先提交生成。不能由 Agent 代替用户确认。网页检测详情提供“确认虚拟来源并登记视频”，同步状态提供“登记视频人像资产”。

`portraitAdmission.registration` 返回登记状态和 `reusable`。同一素材版本已登记且可用时，直接使用原 `assetVersionId`，无需重复上传、声明或登记；更换供应商通道时平台会校验该通道的登记。剪辑、转码或补帧生成的新版本需要重新校验，已有角色图片的登记不能代替整段视频的登记。登记通过也不保证后续生成审核通过。

例如 `references: [{"assetVersionId": "789", "role": "subject"}]`。报价后仍须用户批准预算，才能提交生成。工具不会代替用户作来源或权利声明，也不会通过更换接口绕过审核。

`POST /api/v3/portrait-assets` 是另一套**工作区独立人像库中转**，用于明确需要管理独立上游人像库的集成，要求专属通道、独占命名空间及对应中转权限。其 `portrait_asset_permission_denied` 或 `portrait_asset_channel_unavailable` 只说明独立中转未获授权或未配置，不能用作平台素材审核是否可用的判断。返回的 `guidance.managedAlternative` 会指向上述平台流程。

## 普通 HTTP 工具调用 {#mcp-http}

不使用 MCP 协议时，可调用同一工具服务：`POST /api/tools/v1/:toolName`。请求体直接是工具参数，不需要 JSON-RPC 包装。HTTP 工具调用需要对应业务权限，不要求 `mcp:connect`。

下面的只读检查用于确认部署、鉴权和接口版本，不发起生成：

```bash
export FANJIN_BASE_URL="https://your-fanjin.example"
curl --fail-with-body "$FANJIN_BASE_URL/api/tools/v1/fanjin_context_get" \
  -H "X-API-Key: $FANJIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{}'
```

成功响应包含 `apiVersion: "fanjin-tools/v1"`、`requestId`、`ok: true` 和 `data`。失败时检查 HTTP 状态、`ok` 和 `error.code`。MCP 的工具结果通过 `structuredContent` 及文本内容承载同一响应，工具失败还会设置 `isError`。

请求和工具 JSON 响应上限为 512 KiB；文件字节走单独上传或下载通道，不塞进工具 JSON。下载以及同源文件传输仍需鉴权；对象存储的短期传输地址不得附带繁境 API Key。

## 故障恢复与接入边界 {#mcp-troubleshooting}

| 现象 | 排查方式 |
| --- | --- |
| 404、返回 HTML 或协议版本不匹配 | 检查站点地址，并让管理员确认已部署工具服务 |
| 401 / 403 | 检查 Key 有效期、`mcp:connect`、业务权限及工作区成员身份 |
| 能连接但看不到某工具 | 工具发现按权限过滤，核对 Key 和成员权限 |
| `UNTRUSTED_ENDPOINT` / `UNTRUSTED_ORIGIN` | 管理员核对 HTTPS、代理及站点允许列表 |
| 本地桥接无法启动 | 检查 Node.js 版本、绝对路径和客户端环境变量 |
| 提交超时 | 使用 `fanjin_task_recover` 和原提交幂等键找回任务 |
| `recovering_result` / 旧 `needs_reconciliation` | 后台恢复原任务结果；继续查询同一编号，费用另用 `fanjin_task_billing`，不重复生成 |
| 已生成但无法下载 | 查看 `storageStatus`，等待持久化完成后再下载 |
| 独立人像中转返回 403 / 503 | 正常创作改用 `fanjin_asset_get` 查询 `portraitAdmission`，见[人物参考素材与审核](#/docs/mcp#mcp-portraits)；不要直接要求用户加权限或配置 AK/SK |

创建、提交和重命名操作使用显式幂等键；同一键对应同一请求。同键不同参数会冲突，不能通过换键解决不确定的提交结果。取消只适用于尚未派发的工具任务，不代表已派发生成一定可撤销或退款。

当前支持上述三类节点的创建、文字编辑、基本排列和已保存作品回填；尚不包含节点删除、连接编辑、全平台管理、OAuth、MCP 订阅或外部历史迁移。部署管理员需配置工具 API、网页确认页、Worker、持久化数据和多节点共享存储；用户可先通过上述只读检查确认环境，再参照 [CLI 使用指南](#/docs/cli)操作。


## Seedance 2.5 样片转正式片

仅模型目录 `videoGeneration.draft.enabled=true` 的通道可用。样片与正式片分别报价和提交，不会一次冻结两阶段费用。

通过 `fanjin_generation_quote` 传入普通视频请求，并增加 `renderMode: "draft"`、`resolution: "480p"`。确认本次预算后用 `fanjin_generation_submit` 提交，通过 `fanjin_task_get` 查询结果。普通 480p 视频不等于样片。

样片成功后，只使用以下请求重新报价；`draftTaskId` 使用繁境样片任务编号（画布 Relay 任务或 MCP 任务均可），不要填上游 ID：

```json
{
  "projectId": 2,
  "type": "video",
  "renderMode": "finalize",
  "draftTaskId": "样片的繁境任务 UUID"
}
```

正式片为 1080p，并继承样片的提示词、参考素材、画幅、时长和音频；不能再次传入这些字段。正式片使用原样片通道，不会自动换模型、退回普通生成或超分。资格从上游样片创建时间起计 7 天；以任务的 `draft.canFinalize` 和 `draft.expiresAt` 为准，下载链接的期限与此不同。

每次报价和提交保留原幂等键；网络超时用任务查询或原键恢复，不换键自动重投。素材权利、上游准入与供应商拒绝提示继续生效。


### 自动初剪、文档和整组任务

- 通过 `fanjin_studio_operations(operation="editing.autocut")` 查询参数；传入素材裁切信息和偏好可生成初剪方案，再用 `editing.draft.save` 保存。
- `fanjin_local_upload` 现在也支持 PDF、UTF-8 TXT/Markdown（最多 20 MiB），仍须在允许的本地目录内。返回 assetVersionId 后可复用或提取正文。
- `projects.cover.update` 更换封面，`projects.deletion.status` 查询原删除操作进度。
- `fanjin_canvas_run_start` 用 `projectId/canvasId/expectedRevision/budgetGu/idempotencyKey/steps` 启动整组；每步给 `nodeId/request/outputReferences`。输出引用指定 `nodeId/assetIndex/role`，从已完成的前序节点取素材。
- 用 `fanjin_canvas_run_get` 或 `fanjin_canvas_runs_list` 找回任务；`fanjin_canvas_run_control` 携带 `runId/expectedVersion/action` 暂停、继续或取消后续节点。继续时可显式调整总预算或画布版本。失败任务不会自动重新生成。
- `ui.state.get/update` 同步通知已读、主题和字号；`fanjin_canvas_viewport_set` 保存画布视角。客户端没有新工具时重新连接刷新工具列表。

整组预算按已受理节点的最高报价累计控制，实际扣费仍使用原账单。停止组执行不等于撤销已受理的上游任务；有预算授权才能开始付费生成。新能力需服务端升级到对应版本，文档上传还需数据库 schema 61。

旧任务查询到原生成任务的成功回执时，平台会自动恢复保存和回填，无需人工核账或重新生成。保存完成前 `deliveryReady` 仍为 `false`，继续 `fanjin_task_wait`；完成后按 `nextAction: use_assets` 使用结果。账单未知不等于零费用，可单独调用 `fanjin_task_billing`。
