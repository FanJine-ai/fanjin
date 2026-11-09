# Fanjin CLI / MCP 创作工具

CLI 随产品版本交付，具体版本见 `package.json` 和 `fanjin --help`。服务端有 **46 个工具定义**，覆盖查询、上传、报价、生成、画布编辑、资产、制作与工作台业务；本地另提供上传、媒体处理和中转调用，共可见 **49 个工具**，实际受权限及配置限制。沿用工作区 API Key、资产库和生成计费流程；部署需匹配当前主线 schema。

## 工作台完整操作

调用 `fanjin_studio_operations` 获取当前可用操作。指定 `operation`（例如 `assets.classify`）查询完整参数，再用 `fanjin_studio_execute` 的 `operation` 和 `parameters` 执行。目录包含 153 项业务动作；不会接受任意 URL、HTTP 方法或认证头。

- 画布：`fanjin_canvas_graph_edit` 支持复制/删除、连线、组、节点参数、模板、转绘、合成时间线和撤销；必须传 `expectedRevision`、`idempotencyKey`。`fanjin_canvas_execution_plan` 返回依赖顺序，Agent 再逐项报价执行。
- 素材：`files.*`、`assets.*`、`history.*` 与网页共用分类/分组/引用/历史；本地上传可附带 `usage`。分类失败会保留已保存资产并返回补做入口。
- 制作：`novel.*`、`scripts.*`、`storyboards.*`、`production.*`、`editing.*`、`director.*`。可能调用模型的组合流程需显式 `workflow:execute`，带模型限制或额度上限的 Key 使用逐项报价生成工具，避免组合流程越过密钥限制。
- 会话与管理：`agent.*`、`workspace.*`、`billing.*`、`developer.*`、`account.*`。敏感操作用 `fanjin_human_continue` 返回本人接续入口，不能传入密码或验证码。
- 本地媒体：`fanjin_local_media_edit` 的 `crop/rotate/flip/grid_split/extract_frames` 需要 ffmpeg；只处理 `FANJIN_UPLOAD_ROOTS` 中的文件，保留原文件，输出可用 `fanjin_local_upload` 入库。
- 中转调试：`fanjin_relay_request` 的 `chat/responses/embeddings/rerank/speech/transcription` 使用原兼容接口、模型范围和额度，可能计费，不自动重试。转录用 `file` 传允许目录下最大 25 MiB 的音频；合成语音用 `outputDirectory` 保存音频。

MCP 参数最大 512 KiB；较大文档先抽取正文按章节导入。`fanjin_context_get` 返回 `capabilitiesVersion` 和工作台可用操作数；客户端工具列表未更新时重连即可。管理 MCP 仍使用独立管理身份，普通工作台 Key 不具备发布权限。

本包为私有源码包，未发布 npm。必须连接部署了对应服务端代码及数据库迁移的环境；默认生产域名不代表这些改动已经上线。当前开发目录的迁移序列不能直接覆盖不同版本的生产数据库。

## 安装与连接

开发版界面入口：**工作区 → MCP / CLI 连接**（`/#/workspace/connections`）。也可从 API 密钥页的快捷链接进入。新建连接密钥默认只读、30 天有效，可切换完整创作预设。创建或轮换后可复制 CLI / 本地 MCP / 远程 MCP 配置，并检测 CLI 鉴权与 MCP 握手；检测不发起生成、不扣费。关闭后不再显示明文密钥。

需要 Node.js 22+，CLI 无额外运行依赖。在本目录执行 `node bin/fanjin.mjs --help`，也可以 `npm link` 后使用 `fanjin`。

| 环境变量 | 用途 |
| --- | --- |
| `FANJIN_API_KEY` | 绑定工作区及有效成员的 API Key，由秘密管理工具或终端安全注入 |
| `FANJIN_API_URL` | API 根地址，默认 `https://fanjin.top/api`，接受站点根地址 |

远程仅允许 HTTPS，本机回环允许 HTTP。Key 不接受命令参数、不写配置文件、不放 URL。客户端不会将 Fanjin Key 转发给对象存储或供应商。

## 完整创作流程

先查询模型目录，以返回的 `id`、比例、分辨率、时长和 `inputSlots` 为准，不使用通道 ID：

```bash
fanjin auth whoami
fanjin projects create --name '修仙短剧' --key project-xianxia-001
fanjin models list --type video --available
fanjin models get MODEL_ID --type video
fanjin assets upload ./reference.png --project PROJECT_ID --key reference-001
```

上传实际文件字节，核验大小、文件类型及 SHA-256，然后返回稳定的 `assetId`、`assetVersionId`。图片、视频、音频均支持。文件上限还受服务端配置约束，不能超过 2 GiB。

把实际参数写入 `request.json`（替换示例 ID；引用版本 ID 为字符串）：

```json
{
  "projectId": 123,
  "type": "video",
  "modelId": "从模型目录返回的 id",
  "prompt": "云海之上的山门，镜头缓缓推进",
  "aspectRatio": "16:9",
  "resolution": "1080p",
  "duration": 10,
  "count": 1,
  "audio": true,
  "references": [{ "assetVersionId": "456", "role": "subject" }]
}
```

`references` 可为空；支持角色 `subject`、`style`、`storyboard`、`first_frame`、`last_frame`，具体组合仍由模型能力约束。图片用 `type: "image"`，分辨率如目录中的 `1K`/`2K`/`4K`；省略视频专用 `duration`/`mode`，`audio` 为 false。视频每次一个任务，图片数量由接口及供应商支持范围决定。

```bash
fanjin generate quote --input request.json --key quote-scene01-001
```

报价不调用供应商、不扣费。先展示报价中的 `maximumPrice.gu` / `maximumPrice.yuan` 和完整参数。用户已授权预算后可以直接提交，无需额外打开批准页；可选网页确认仍保留。普通生成省略画幅、分辨率、时长时按模型目录默认值报价，编辑/延长需显式填写参数。

```bash
fanjin generate submit --quote QUOTE_ID --budget-gu 10 --key generate-scene01-001
fanjin tasks wait TASK_ID --wait-ms 1800000
fanjin tasks billing TASK_ID
fanjin assets download ASSET_ID --project PROJECT_ID --version VERSION_ID --output ./scene01.mp4
```

报价高于 `--budget-gu` 时不提交。`tasks billing` 仅查询原任务账单；冻结、扣费、释放、退款分开列出，并给出 GU 与人民币。金额未知返回 null，不等于零；查账不是取作品的前置步骤。

提交后任务持久化，由 Worker 调用实际生成服务。视频复用现有中转任务，图片作为持久任务执行同步供应商请求。生成完成与存储完成分别返回：只有 `storageStatus: "ready"` 才会提供已保存的作品。下载实际字节并检查大小和 SHA-256，临时文件写完后才生成目标文件，拒绝覆盖已有文件。

报价有效期 15 分钟，一份报价和批准最多消费一次。提交和派发前都会重新核验权限、价格与模型能力；价格变化必须重新报价。底层计费在冻结资金前检查批准上限，不能通过切换供应商突破预算。

## 海外 Dreamina Seedance 2.5

能力依据 [BytePlus 官方 Seedance 2.5 文档](https://docs.byteplus.com/en/docs/modelark/seedance-2-5)，模型为 `dreamina-seedance-2-5-260628`。先用 `models get` 获取当前平台配置与可用状态。

- 普通生成：4–30 秒或 `duration: -1` 自动时长，480p/720p/1080p，六种固定比例或 `adaptive`，`outputFormat` 可选 `mp4`/`mov`。
- 全能参考：最多 30 张图片、10 段视频、10 段音频，总计 50 个素材；允许仅音频参考。视频合计不超过 30 秒，音频合计不超过 30 秒。
- 首帧、首尾帧：使用 `first_frame`/`last_frame`，画幅为 `adaptive`。
- 原生编辑：`operation: "edit"`、`mode: "video_edit"`、`aspectRatio: "adaptive"`、`duration: -1`。以 `sourceAssetVersionId` 指定原片，并将该版本作为 `source_video` 放入 `references`；其他素材继续作为参考。编辑视频每段 4–30 秒。
- 原生延长：`operation: "extend"`、`mode: "video_extension"`、`aspectRatio: "adaptive"`，同样指定原片，提示词明确向前或向后延长及生成内容。
- 样片：`renderMode: "draft"`、`resolution: "480p"`；转正式片只提交 `projectId,type,renderMode:"finalize",draftTaskId`，另可指定 `outputFormat`，其他参数继承原样片，沿用同一模型与通道。

`audio: true` 控制输出是否含音频。音频参考可以引导对白、声音与节奏；保留要求应写入提示词，不保证原声无损或动作逐帧复制。样片与正式片分别报价，`generate quote`/`video draft`/`video finalize` 均只报价，须另行提交才创建生成任务。

## 命令与工具

| CLI 命令 | MCP / HTTP 工具 | Key 权限 |
| --- | --- | --- |
| `auth whoami` | `fanjin_context_get` | 有效工作区 Key |
| `projects list` | `fanjin_projects_list` | `project:read` |
| `projects get ID` | `fanjin_project_get` | `project:read` |
| `projects create --name NAME --key KEY` | `fanjin_project_create` | `project:create` |
| `models list` | `fanjin_models_list` | `model:read` |
| `models get ID` | `fanjin_model_get` | `model:read` |
| `billing balance` | `fanjin_billing_balance` | `billing:read` |
| `canvas get --project ID` | `fanjin_canvas_get` | `project:read` |
| `canvas create-nodes --input nodes.json --key KEY` | `fanjin_canvas_nodes_create` | `project:write` |
| `canvas update-nodes --input changes.json --key KEY` | `fanjin_canvas_nodes_update` | `project:write` |
| `canvas arrange --input layout.json --key KEY` | `fanjin_canvas_arrange` | `project:write` |
| `assets list --project ID` | `fanjin_assets_list` | `asset:read` |
| `assets get ID --project ID` | `fanjin_asset_get` | `asset:read` |
| `uploads start --input metadata.json --key KEY` | `fanjin_upload_prepare` | `asset:write` |
| `uploads status ID --project ID` | `fanjin_upload_get` | `asset:read` |
| `uploads complete ID --project ID` | `fanjin_upload_complete` | `asset:write` |
| `generate quote --input request.json --key KEY` | `fanjin_generation_quote` | `generation:quote` |
| `approvals request QUOTE_ID --key KEY` | `fanjin_approval_request` | `generation:create` |
| `approvals get ID` | `fanjin_approval_get` | `generation:read` |
| `generate submit --quote ID --approval ID --key KEY` | `fanjin_generation_submit` | `generation:create` |
| `tasks list --project ID` | `fanjin_tasks_list` | `generation:read` |
| `tasks get ID` | `fanjin_task_get` | `generation:read` |
| `tasks billing ID` | `fanjin_task_billing` | `billing:read` |
| MCP 有界等待（无独立 CLI 命令） | `fanjin_task_wait` | `generation:read` |
| `canvas attach --input target.json --key KEY` | `fanjin_canvas_attach` | `project:write` |
| `tasks recover --key KEY` | `fanjin_task_recover` | `generation:read` |
| `tasks cancel ID` | `fanjin_task_cancel` | `generation:create` |
| `assets download ID --project ID --output FILE` | `fanjin_asset_download` | `asset:download` |
| `history list --project ID` | `fanjin_history_list` | `generation:read` |
| `assets rename ID --project ID --name NAME --revision UPDATED_AT --key KEY` | `fanjin_asset_rename` | `asset:write` |

`assets upload` 编排 prepare → 文件 PUT → complete；`tasks wait` 只轮询原任务。上传会话断线后可以 `uploads status` 查询已上传/已登记状态，结果不确定时保留原上传 ID。`uploads start` 的 JSON 字段为 `projectId,fileName,assetName,assetType,mimeType,sizeBytes,contentHash`。

列表支持 `--limit` 和 `--cursor`，每页默认 20、最多 100。素材 get/download 可用 `--version` 指定版本；重命名的 `--revision` 来自素材 `updatedAt`，并发编辑冲突会拒绝覆盖。`history list` 当前列出该 Key 经工具提交的历史；项目素材列表可查看当前项目的已登记资产。

Key 权限还要与成员权限交集：查询通常需要成员 `project:read`，项目/素材写入需要 `project:write`，报价与生成需要 `generation:create`，余额需要 `billing:read`。MCP 另需 `mcp:connect`。密钥设置页提供这些独立选项；不会自动扩大已有 Key 权限。撤销、过期、移出工作区、权限变化和模型白名单每次重新校验。

## 编辑画布，不发起生成

先 `canvas get --project PROJECT_ID --canvas CANVAS_ID --include-content` 获取节点与当前 `revision`。编辑 JSON 包含 `projectId`、`canvasId`、`expectedRevision`，每次成功后沿用返回的新版本；`--key` 为本次操作的唯一幂等键。

```json
{
  "projectId": 123,
  "canvasId": 456,
  "expectedRevision": 1,
  "nodes": [{"type": "video", "title": "镜头一", "prompt": "清晨海岸", "aspectRatio": "16:9"}]
}
```

用 `canvas create-nodes --input nodes.json --key canvas-create-001` 创建，返回 `nodes[].id`；类型支持 text/image/video，文本正文用 `text`。省略位置时放在旧节点下方。

修改时把 `nodes` 换为 `updates: [{"nodeId": "返回的 ID", "prompt": "新的提示词"}]`，调用 `canvas update-nodes`。布局使用 `nodeIds` 和 `mode: "grid" | "horizontal" | "vertical"`（网格可带 `columns`）；指定坐标用 `mode: "manual", positions: [{nodeId, x, y}]`，调用 `canvas arrange`。

创建/文字修改每批最多 50 个，排列最多 100 个；一项无效整批回滚。只改指定内容，保留作品、边、分组和视图。正在生成的节点不允许改提示词。网络超时用原参数、原键重试；版本冲突则重新读取确认后使用新键。重放回执保留原 `revision`，另有 `currentRevision`，继续操作前重新读取。服务端无法读取网页未保存草稿；外部编辑后重新载入查看。这些编辑不创建生成任务或扣费。

## 画布上的本地 MCP 连接状态

使用本版本的 `fanjin mcp serve` 完成握手后，画布右上角会显示绿点和「本地 MCP 已连接」。状态仅匹配当前登录账号与当前工作区，Key 被撤销、过期或移除 MCP 权限后不再显示连接。正常退出会主动下线；客户端异常关闭或网络中断后，心跳最长 45 秒过期，页面每 5 秒检查一次。浏览器离线或状态服务故障显示「状态未知」。

旧版 CLI 需要更新并在 Agent 客户端中重启 MCP。普通 CLI 请求、连接检测和直接使用无状态远程 HTTP 的客户端不作为本地桥接在线证明。服务端与网页需一同部署；生产多 API 实例共用 Redis，开发单进程可在 Redis 关闭时使用内存状态。心跳不调用生成工具、不产生生成费用，也不在 MCP stdout 输出日志。

## MCP 与 HTTP

远程 MCP：`POST /api/mcp`，使用 `X-API-Key`，也可用 `Authorization: Bearer <工作区 API Key>`。不要同时提供不同的 Key。支持官方 SDK 的现代发现和旧版初始化；可选 `?projectId=123` 提供默认项目，不增加权限。

仅支持 stdio 的客户端，可配置命令 `node`，参数为本机 `bin/fanjin.mjs` 的绝对路径、`mcp`、`serve`，通过客户端的安全环境配置注入上述变量。桥接只在 stdout 写 JSON-RPC，支持 JSON/SSE HTTP 响应，普通日志写 stderr。服务端无法读取你本机文件；MCP 上传返回传输指引，由具备文件权限的客户端传输，或直接使用 CLI。

普通 HTTP：`POST /api/tools/v1/:toolName`，JSON 为工具参数。文件 PUT/GET 使用工具返回的同源路径或短期对象存储上传 URL；下载需再次校验 Key。不要把供应商临时 URL 当作最终作品。

部署需要 API 路由、Web 确认页、后台 Worker 和 `external_tools` 持久操作表。生产多节点使用共享对象存储。Host / Origin 允许列表由 `FANJIN_PUBLIC_BASE_URL`、`FANJIN_APP_PUBLIC_URL` 或 `FANJIN_TOOLS_ALLOWED_ORIGINS` 配置，反向代理必须正确配置可信代理。不要用开发模式绕过生产检查。

## 故障恢复与金额

创建/提交/重命名操作使用显式幂等键；一键上传可省略键，由项目、内容校验值与文件元数据产生稳定键；同键不同请求会被拒绝。提交超时用 `tasks recover --key 原键` 找回原任务，再 `tasks wait`，**不能换键重新生成**。供应商受理结果不明确时后台自动查询原记录，`executionPhase: recovering_result` 提示继续等待，无需用户核账；不会自动重新扣费生成。24 小时仍找不到结果时报告 `RESULT_UNAVAILABLE`，费用仍以独立账单查询为准。`tasks cancel` 仅能取消尚未派发的工具任务，不会把已派发任务伪报为取消或退款。

CLI 默认输出 JSON。`--timeout-ms` 默认 30000、范围 250–120000；`tasks wait` 的 `--wait-ms` 单独控制总等待时间，超时不取消服务端任务。退出码：0 成功，1 网络/超时/完整性等本地错误，2 参数/配置错误，3 权限/服务端拒绝/任务失败或待核对。脚本应同时检查 `error.code`。

金额返回十进制字符串 `guMicros` 和 `gu`；沿用账本单位，**1 GU = 100000000 原始单位，1 元 = 10 GU**。余额范围是工作区额度账本，`available = balance - frozen`，授信单列，不包含个人钱包或赠送余额，也不构成预算批准。

目前仍不包含全平台管理、画布写入/排版、外部历史迁移、OAuth 和 MCP 订阅。这些与本次已实现的素材到成片创作流程分开。

## 验证入口

```bash
# fanjin-cli
npm test
# fanjin-api
npm run lint
npx --no-install vitest run tests/unit/fanjinToolsCreation.test.ts tests/api/fanjinToolsLifecycle.test.ts
npm run build
# fanjin-v4
npx --no-install playwright test e2e/tool-approval.spec.ts --workers=1
```

集成测试使用真实 API、会话、数据库、计费和文件传输，付费供应商替换为本机 HTTP 测试服务；它验证实现链路，不代表真实供应商质量或生产部署验收。测试与缺陷记录见仓库 `artifacts/tools-full-20260915/`。

## 账号与工作区查询、后台导出

使用 `fanjin_analytics_query`，详见 共享协议（参见 API 工具发现返回的参数说明）。`usage list` 的 `--execution-status` 与 `--failure-category` 可筛执行结果和失败原因；`--status` 仍为结算状态。现有查询权限不自动扩张。

```bash
fanjin usage export-create --key export-20260921-01 --kind usage --format csv
fanjin usage export-jobs
fanjin usage export-status JOB_ID
fanjin usage export-download JOB_ID --output ./usage.csv
fanjin usage export-cancel JOB_ID
```

任务在服务器生成，关闭 CLI 不取消。结果保留 24 小时，必须使用创建时的 Key 下载，每段重新校验权限；网页会话创建的任务请在网页下载。下载完成前不会写入目标文件，不覆盖已有文件。`usage export --output FILE` 仍提供同步分页导出。

## 固定项目、本地上传和画布回填

客户端安全环境配置可加 `FANJIN_PROJECT_ID` 与 `FANJIN_CANVAS_ID`，CLI 和桥接会将其传给服务端，显式参数优先；成员权限始终重新校验。只读 `fanjin_context_get` 可核对绑定，不能绑定其他项目的画布。

本地 MCP 使用 `node /absolute/path/bin/fanjin.mjs mcp serve`。额外配置 `FANJIN_UPLOAD_ROOTS='["/absolute/media"]'` 后可发现 `fanjin_local_upload`，参数为 `file` 绝对路径、可选 `projectId`、`name` 和 `idempotencyKey`。仅允许配置目录中的图片、视频、音频；禁止符号链接越界。服务端不接收本地路径。相同文件重试复用已上传或已入库会话，CLI 的 `assets upload` 同样支持这一路径。

`fanjin_task_wait` 是最多 20 秒的 MCP 查询；CLI `tasks wait` 则按 `--wait-ms` 连续查询原任务，不重投。判断完成使用 `deliveryReady: true` 或兼容的 `executionStatus: succeeded` + `storageStatus: ready`。

`canvas attach` 的 JSON 填 `projectId,canvasId,taskId,nodeId,expectedRevision`（可选 `assetIndex`）。先从 `canvas get` 读取 revision，仅回填已保存作品到匹配类型的现有节点。Key 与成员均需 `project:write`；版本冲突不覆盖编辑。同一幂等键重试只写入一次。MCP 提交还支持 `targetCanvas` 在完成后自动回填；冲突保留作品并在 `canvasDelivery` 返回提示。旧 Key 不自动加权限。


### 自动初剪、文档和整组任务

- 通过 `fanjin_studio_operations(operation="editing.autocut")` 查询参数；传入素材裁切信息和偏好可生成初剪方案，再用 `editing.draft.save` 保存。
- `fanjin_local_upload` 现在也支持 PDF、UTF-8 TXT/Markdown（最多 20 MiB），仍须在允许的本地目录内。返回 assetVersionId 后可复用或提取正文。
- `projects.cover.update` 更换封面，`projects.deletion.status` 查询原删除操作进度。
- `fanjin_canvas_run_start` 用 `projectId/canvasId/expectedRevision/budgetGu/idempotencyKey/steps` 启动整组；每步给 `nodeId/request/outputReferences`。输出引用指定 `nodeId/assetIndex/role`，从已完成的前序节点取素材。
- 用 `fanjin_canvas_run_get` 或 `fanjin_canvas_runs_list` 找回任务；`fanjin_canvas_run_control` 携带 `runId/expectedVersion/action` 暂停、继续或取消后续节点。继续时可显式调整总预算或画布版本。失败任务不会自动重新生成。
- `ui.state.get/update` 同步通知已读、主题和字号；`fanjin_canvas_viewport_set` 保存画布视角。客户端没有新工具时重新连接刷新工具列表。

整组预算按已受理节点的最高报价累计控制，实际扣费仍使用原账单。停止组执行不等于撤销已受理的上游任务；有预算授权才能开始付费生成。新能力需服务端升级到对应版本，文档上传还需数据库 schema 61。
