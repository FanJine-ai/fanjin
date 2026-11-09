## 快速开始 {#api-start}

先在[密钥管理](#/developer/api/keys)创建工作区 API Key，勾选需要的能力，再从[模型广场](#/models)选择模型。阅读文档无需登录；创建密钥需要登录并具有工作区权限。

示例使用 Bash / Zsh 和 curl。`FANJIN_BASE_URL` 是站点根地址，不带 `/api` 或 `/v1`；私有部署请替换域名。API Key 请通过终端或秘密管理工具注入环境变量，不要写入前端代码或提交到仓库。

```bash
export FANJIN_BASE_URL="https://fanjin.top"
# 先安全注入 FANJIN_API_KEY，再查询当前密钥可用的模型。
curl --fail-with-body "$FANJIN_BASE_URL/v1/models" \
  -H "Authorization: Bearer $FANJIN_API_KEY"
```

成功返回 `{"object":"list","data":[...]}`，每个模型包含 `id`、`object`、`created` 和 `owned_by`。`model` 必须使用返回的 `id`，不要使用模型展示名称或供应商通道 ID。模型列表受工作区路由、密钥权限和模型白名单共同约束。

把文本模型 ID 写入 `chat.json`，即可发起第一条请求。生成请求会按实际用量计费。

```json
{
  "model": "替换为可用文本模型 ID",
  "messages": [{"role": "user", "content": "用一句话介绍繁境"}],
  "stream": false
}
```

```bash
curl --fail-with-body "$FANJIN_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $FANJIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @chat.json
```

文本结果位于 `choices[0].message.content`，用量通常位于 `usage`。具体多模态、工具调用和推理字段取决于所选模型。

## 鉴权与权限 {#api-auth}

请求头使用 `Authorization: Bearer <工作区 API Key>`。密钥绑定工作区，仍受额度、有效期、IP 限制及模型白名单等约束。不要在 URL 中携带密钥。

| 权限 | 对应能力 |
| --- | --- |
| `relay:text` | Chat、Responses、Files、Messages、语音、向量、重排 |
| `relay:image_generation` | 图片生成 |
| `relay:video_generation` | 视频创建、列表、查询和取消 |

`GET /v1/models` 按当前密钥返回可调用目录。接口存在不代表所有模型都支持该接口，请结合模型能力和账户配置选择。MCP / CLI 的 `project:read`、`generation:create` 等工具权限与这里的中转权限分别配置，详见 [MCP 集成](#/docs/mcp)。

## 接口总览 {#api-endpoints}

以下路径拼接站点根地址。`/v1/*` 同时提供 `/api/v1/*` 别名；视频使用 `/api/v3/*`。第三方兼容客户端若要求填写 Base URL，OpenAI 兼容接口通常填写 `https://fanjin.top/v1`，不要再重复追加 `/v1`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/models` | 当前可用模型列表 |
| GET | `/v1/models/:model` | 查询单个模型 |
| POST | `/v1/chat/completions` | 文本 / 多模态对话，支持 SSE |
| POST | `/v1/responses` | Responses 与函数调用 |
| GET / DELETE | `/v1/responses/:id` | 查询 / 删除当前主体的响应资源 |
| GET | `/v1/responses/:id/input_items` | 查询响应的输入项 |
| POST | `/v1/images/generations` | 图片生成与参考图输入 |
| POST | `/api/v3/contents/generations/tasks` | 创建视频任务 |
| GET | `/api/v3/contents/generations/tasks` | 视频任务列表（`items` / `total`） |
| GET / DELETE | `/api/v3/contents/generations/tasks/:id` | 查询 / 尝试取消视频任务 |
| POST / GET | `/v1/files` | 上传 / 列出 Responses 输入文件 |
| GET / DELETE | `/v1/files/:id` | 查询 / 删除输入文件 |
| POST | `/v1/audio/speech` | 语音合成，返回音频字节 |
| POST | `/v1/audio/transcriptions` | 音频转写，multipart 文件上传 |
| POST | `/v1/embeddings` | 文本或模型支持的多模态向量 |
| POST | `/v1/rerank` | 对候选文档进行相关性重排 |
| POST | `/v1/messages` | Anthropic Messages 兼容入口 |
| POST | `/v1beta/models/:model:generateContent` | Gemini 原生非流式生成 |
| POST | `/v1beta/models/:model:streamGenerateContent` | Gemini 原生流式生成 |

兼容协议的可选参数仍受模型和供应商约束；这里的兼容入口不承诺所有厂商扩展都能互换。项目与素材工具接口见 [MCP / HTTP 工具说明](#/docs/mcp#mcp-http)。

## 文本、流式输出与 Responses {#api-text}

Chat 请求必填 `model` 和非空 `messages`。常用选项包括 `stream`、`temperature`、`max_tokens`、`tools` 和 `response_format`，需匹配模型支持范围。非流式模式返回 JSON。

流式请求把 `stream` 设置为 `true`，curl 增加 `-N`，按 SSE 事件读取。不要把 SSE 当作单个 JSON 解析；连接中断也不能当作完整生成成功。

```bash
curl -N "$FANJIN_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $FANJIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @chat-stream.json
```

`chat-stream.json` 与快速开始示例一致，仅将 `stream` 改为 `true`。客户端应先检查 HTTP 状态和 Content-Type，再读取内容。

Responses 使用 `POST /v1/responses`，请求示例：

```json
{
  "model": "替换为支持 Responses 的模型 ID",
  "input": [{
    "role": "user",
    "content": [{"type": "input_text", "text": "为这段视频写一个标题"}]
  }],
  "stream": false
}
```

返回内容遵循 Responses 的 `output` 结构。需要续接时使用同一主体拥有的 `previous_response_id`。目前函数工具 `function` 可用；尚无独立结算价格的内置工具会返回 `422 unsupported_responses_tool_billing`。`conversation` 尚未开放；文件输入必须来自同一主体通过繁境 File API 上传的文件。

## 图片生成 {#api-images}

`POST /v1/images/generations` 必填 `model` 和 `prompt`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `n` | integer | 默认 1，接口接受 1–10，最终受模型能力限制 |
| `size` | string | 模型支持的尺寸或分辨率，不能在不同模型间直接照搬 |
| `image` | string / array | 参考图 URL / Base64；数组接受 1–14 项，仍受模型限制 |
| `response_format` | string | `url`（默认）或 `b64_json` |
| `seed` | integer | 随机种子，是否支持取决于模型 |
| `output_format` | string | 模型支持时使用 `png` / `jpeg` |
| `sequential_image_generation` | string | 支持组图的模型可使用 `auto` |
| `sequential_image_generation_options.max_images` | integer | 组图数量上限 1–15 |
| `stream` | boolean | 流式组图需同时设置 `sequential_image_generation: "auto"` |

保存为 `image.json`：

```json
{
  "model": "替换为图片模型 ID",
  "prompt": "雨后山谷，清晨薄雾，电影感远景",
  "n": 1,
  "response_format": "url"
}
```

```bash
curl --fail-with-body "$FANJIN_BASE_URL/v1/images/generations" \
  -H "Authorization: Bearer $FANJIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @image.json
```

读取 `data[].url` 或 `data[].b64_json`。返回链接可能有有效期，需要保存的作品应及时下载。组图可能部分成功，应逐项检查结果；图片 `tools` 扩展当前会返回 `422 unsupported_image_tool_billing`。

## 视频任务与结果 {#api-video}

视频采用异步任务：创建 → 保存任务 ID → 轮询 → 获取结果。**HTTP 200 只表示请求被处理，任务是否成功以 `status` 为准。**

### 方舟格式中转（不保存视频）

普通方舟客户端可使用原有 `model`、`content` 和规格字段，不传繁境 `projectId` 或 `canonicalRequest`。示例：

```json
{
  "model": "替换为已开通的方舟视频模型 ID",
  "content": [{ "type": "text", "text": "海边灯塔，镜头缓缓推进" }],
  "resolution": "720p",
  "ratio": "16:9",
  "duration": 5,
  "generate_audio": true
}
```

向 `POST /api/v3/contents/generations/tasks` 发送上述内容，使用 `Authorization: Bearer <FANJIN_API_KEY>`。返回 `{ "id": "任务编号" }`；之后查询 `GET /api/v3/contents/generations/tasks/:id`，成功读取 `content.video_url`。

图片、视频、音频使用官方 `content` 引用结构，素材限制与审核由当前上游执行。`asset://` 仍需属于当前密钥工作区及选中通道；不能引用他人资源。样片转正式使用 `draft_task.id` 填写本中转返回的样片任务编号，服务端沿原通道处理。

**此模式原样返回上游视频 URL，繁境不下载、不转存、不建立成片资产。** 链接有效期由上游决定；需要长期保存时由调用方及时下载。繁境保留任务、上游回执和账单记录。结算处理不会阻止已成功视频返回；没有结果时继续查询原任务，不要求用户人工对账，也不要换键重投。

当前已覆盖创建、按 ID 查询及样片关联的主要字段；不是所有管理接口与官方完全相同。列表仍使用繁境分页封装；DELETE 仍是繁境取消语义；回调仅提供终态通知，且必须由服务端启用安全投递。普通中转不需要 `callback_secret`，首次接入建议轮询。可用模型和价格由已配置路由决定，未开通模型不会自动替换为其他供应商。

### 繁境项目扩展（画布及托管资产）

以下规则仅适用于显式提供 `projectId` 或 `canonicalRequest` 的项目扩展，不适用于上述普通方舟请求。项目创作仍保存可复用资产。

保存为 `video.json`，将 `projectId` 替换为 API Key 工作区内的活动项目 ID。以下是文生视频的规范化请求；比例、时长、分辨率、音频及 operation 必须符合当前模型能力目录，`modelRouteId` 可使用与 `model` 相同的公开模型 ID：

```json
{
  "projectId": 12345,
  "model": "替换为视频模型 ID",
  "canonicalRequest": {
    "version": "provider-neutral-video-request/v1",
    "operation": "generate",
    "modelRouteId": "与 model 相同的公开模型 ID",
    "prompt": "海边灯塔，镜头缓缓推进",
    "aspectRatio": "16:9",
    "durationSeconds": 5,
    "outputResolution": "720p",
    "generateAudio": false,
    "preserveSourceAudio": false,
    "inputs": []
  }
}
```

```bash
curl --fail-with-body "$FANJIN_BASE_URL/api/v3/contents/generations/tasks" \
  -H "Authorization: Bearer $FANJIN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: video-scene-001" \
  --data-binary @video.json

# 将返回的 id 赋给 FANJIN_TASK_ID，再查询同一个任务。
curl --fail-with-body "$FANJIN_BASE_URL/api/v3/contents/generations/tasks/$FANJIN_TASK_ID" \
  -H "Authorization: Bearer $FANJIN_API_KEY"
```

`inputs: []` 表示没有参考素材。图、视频或音频参考须先成为当前项目的受控素材版本，再将 `assetVersionId`、`mediaType`、`role`、`order` 放入 `inputs`；不得用外部 URL 或客户端伪造的策略证据替代。服务端会生成并重新校验可信策略证据。旧版纯文本 `prompt/content` 请求无论素材策略开关是否开启，均扫描完整请求中的素材引用，并由服务端补齐规范化视频请求和当前策略证据；兼容入口保留 Relay 的模型路由和定价校验，不新增 Workbench 模型目录要求。未填写规格时使用 5 秒、16:9、720p，`generate_audio` 默认 `true`，可明确传 `generate_audio: false` 关闭音频；开启与关闭音频的费用可能不同，具体费用取决于模型、规格、实时价格和实际计费用量。合法普通扩展继续保留：`seed` 为安全整数，`fps` 为正整数，`watermark`、`camera_fixed`、`return_last_frame` 为布尔值，`metadata` 为惰性 JSON 对象，`output_format` 为字符串 `mp4`/`mov`；保留兼容投递不承诺每个模型均支持这些字段。未支持的顶层控制返回 `422 legacy_video_controls_require_canonical_request`，身份、权限、内部检查点、可信证明、计费、价格、预算和审批只能由服务端控制，`metadata` 注释不会被提升为这些控制。媒体输入和 Seedance 2.5 精确模型始终要求显式 `canonicalRequest`；延长、编辑或样片操作须使用已验证的正式 canonical/Adapter 绑定及受控素材。升级前已接受的纯文本任务以原 API Key、项目、幂等键和完整原请求重试时只读返回，不再次冻结或调用上游。

`queued`、`running`、`enhancing` 表示仍在处理；`succeeded` 表示成功；`failed` 或 `canceled` 为终止状态。遇到未知状态应保留原始响应并继续核查，不要直接当作成功。响应的 `object` 为 `content.generation.task`，还包含 `stage`、`progress_percent` 和时间字段。成功后读取 `content.video_url` 或 `output[].url`；输出时长字段为 `duration_ms`。

列表支持 `page_num`、`page_size`、`filter.status`、`filter.model` 和逗号分隔的 `filter.task_ids`。建议间隔数秒查询并逐步退避，避免密集轮询。

`DELETE /api/v3/contents/generations/tasks/:id` 尝试取消任务；无法取消时返回 409。不要把取消请求已发送理解为已经取消或退款。

创建任务建议使用业务唯一的 `Idempotency-Key`。请求超时后保留原键和原参数，先找回或查询原任务；不要换键再次提交。需要回调时配置 `callback_url` 和 `callback_secret`，服务端还需启用安全回调投递；首次集成建议先使用轮询。

### 人物参考素材的两种接入方式

使用繁境项目素材进行创作时，优先采用 [MCP / HTTP 工具流程](#/docs/mcp#mcp-portraits)：上传保存 → 用 `assetVersionId` 引用 → 报价与预算确认 → 提交。人像预检状态可通过 `portraitAdmission` 查询；未完成或失败不阻止开始生成，供应商拒绝时会返回任务失败原因。有效的人像登记优先复用，未就绪时保留原始素材由供应商审核。调用方无需额外配置供应商 AK/SK。

已检测到人像或已完成来源声明后，可通过 `POST /api/tools/v1/fanjin_portrait_asset_register` 主动登记现有资产，请求体为 `{"projectId":123,"assetVersionId":789,"idempotencyKey":"portrait-register-789-001"}`。需要 `asset:write` 与项目写权限。`registration.status` 区分 `processing`（已启动）和 `registered`（已登记）；后续查询 `fanjin_asset_get`，回执本身不会随登记进度变化。通道配置缺失会明确报错。登记不创建生成任务或冻结生成预算。

视频来源已由用户确认为 AI 虚构人物时，可通过 `fanjin_portrait_admission_declare` 直接声明并登记整段视频，无需等待抽帧检测；声明参数及用户确认要求见 [人物素材接入](#/docs/mcp#mcp-portraits)。抽帧检测未检出或失败时，声明和登记须取得用户来源确认，不自动视为无人像；此确认不是未阻断素材开始生成的前提。登记有效的同一视频版本可以复用，角色图片的登记不能替代视频登记。

`POST /api/v3/portrait-assets?Action=...&Version=2024-01-01` 专用于工作区独立火山人像库中转，要求独占通道和命名空间；读取、写入、活体操作分别使用 `relay:portrait_assets:read`、`relay:portrait_assets:write`、`relay:portrait_assets:liveness`。这不是项目素材审核的前置接口，返回的上游资源 ID 也不能直接当作平台 `assetVersionId`。

该接口返回 `portrait_asset_permission_denied`（403）或 `portrait_asset_channel_unavailable`（503）时，请先核对接入方式。普通创作应沿 `guidance.managedAlternative` 查询平台素材；只有明确使用独立中转时才处理专属通道配置。

## 文件、语音与其他能力 {#api-media}

### Files

File API 管理 Responses 的输入文件，与项目素材库分别管理。使用 `multipart/form-data`，不要手工写 boundary：

```bash
curl --fail-with-body "$FANJIN_BASE_URL/v1/files" \
  -H "Authorization: Bearer $FANJIN_API_KEY" \
  -F "purpose=user_data" \
  -F "file=@./input.pdf"
```

也可使用 `url` 上传远程资源，受服务端安全检查限制。文件上限为 512 MB；实际类型及预处理支持取决于通道。查询文件直至 `active` 后，再将文件 ID 用于 Responses；列表、查询和删除仅限当前授权主体的资源。

### Speech / Transcriptions

语音合成请求包含 `model`、`input`，并按模型选择 `voice`、`response_format`、`speed`。成功返回二进制音频，使用 `--output speech.mp3` 保存；先检查 HTTP 状态，避免把错误 JSON 当音频使用。

音频转写使用 `POST /v1/audio/transcriptions`，通过 `-F "model=模型ID" -F "file=@./audio.mp3"` 提交。其他字段和文件限制按模型能力配置。

### Embeddings / Rerank

向量请求包含 `model` 和 `input`（字符串或数组）；常见响应在 `data[].embedding`。重排请求包含 `model`、`query` 和 `documents`，可按支持情况传 `top_n`。不要将文本对话模型 ID 用在这些接口。

```json
{
  "model": "替换为向量模型 ID",
  "input": ["山谷里的清晨", "海边的灯塔"]
}
```

## 错误处理与排查 {#api-errors}

错误通常包含 `error.message`，部分接口同时返回 `error.type`、`error.code` 或顶层 `message` / `code`。**不要假定所有接口都有完全相同的错误结构。**

| HTTP 状态 | 常见原因 | 处理建议 |
| --- | --- | --- |
| 400 | 参数缺失、类型错误或不支持的参数组合 | 对照当前模型能力修正请求 |
| 401 | 密钥无效、缺失、撤销或过期 | 检查密钥和鉴权请求头 |
| 402 | 可用额度或余额不足 | 检查工作区额度与余额 |
| 403 | 权限、成员身份、IP 或模型白名单限制 | 核对密钥及工作区配置 |
| 404 | 模型、文件或任务不存在或不可见 | 检查 ID 和调用主体 |
| 409 | 幂等冲突或当前状态不允许操作 | 使用原参数核查，不要盲目重建 |
| 422 | 所选能力或计费扩展尚不支持 | 按错误 code 调整工具或参数 |
| 429 | 请求频率或密钥额度限制 | 检查响应原因，退避并限制并发 |
| 5xx | 平台、供应商或依赖服务异常 | 保存请求标识，查询原任务并联系支持 |

排查时记录时间、接口、模型、HTTP 状态、任务 ID 和响应中的请求标识。不要在反馈中附带完整密钥。自动重试应有退避、次数上限和幂等保护；流式中断或任务超时不代表没有产生费用。

## API、MCP 与 CLI 如何选择 {#api-next}

直接把生成能力集成到应用中，使用本页 HTTP API。需要项目、素材、报价、预算确认和作品归档的工作流，参考 [MCP 集成](#/docs/mcp) 和 [CLI 使用指南](#/docs/cli)。这两种工具接入需要部署对应工具服务，并使用各自的工具权限。

价格以[模型广场](#/models?section=pricing)与实际账单为准；文档示例中的模型占位符不代表平台保证提供某个具体供应商型号。


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

### 视频列表与原任务恢复

视频列表使用官方 `items`、`total`，同时保留旧 `data` 别名。支持 `filter.status`、`filter.model`、重复的 `filter.task_ids`，以及 `filter.service_tier`（默认 `default`，离线任务用 `flex`）。`page_num` 和 `page_size` 均为 1–500 的整数。普通视频请求原样传递 `priority`、`safety_identifier`，查询保留上游 `frames`。

生成完成即可读取视频，账单结算独立进行。查询及等待都使用原任务 ID；暂时无法确认结果时不要创建新任务代替查询。
