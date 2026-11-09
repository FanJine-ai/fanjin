import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo, useState } from "react";
import { BookOpen, Boxes, ChevronDown, ChevronRight, Copy, FileCode2, Globe, Lock, TerminalSquare, Zap } from "lucide-react";
import { Alert, Badge, Button, CodeBlock, ConsolePage, Section } from "../../ui/console";
import { resolveDeveloperDocModelExamples } from "./developerDocModels";
import { useDeveloperConfig } from "./useDeveloperConfig";
import { useDeveloperCatalog, activeModels } from "./useDeveloperCatalog";
import publicVideoResponseContract from "./publicVideoResponse.contract.json";
import "./DeveloperConsole.css";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const PUBLIC_VIDEO_RESPONSE_CONTRACT = publicVideoResponseContract;

export const API_SECTIONS = [
  {
    id: "auth",
    title: "鉴权",
    icon: Lock,
    description: "所有 API 调用需要在请求头中携带 API Key。",
    content: `## 鉴权方式

所有 API 请求需要在 Header 中携带 API Key：

\`\`\`
Authorization: Bearer <FANJIN_API_KEY>
Content-Type: application/json
\`\`\`

API Key 属于工作区，可由管理员创建、禁用、轮换和删除。服务端只保存哈希，不保存明文 Key。

### 获取 API Key

1. 前往「密钥管理 → API 密钥」
2. 点击「创建密钥」
3. 设置名称和权限
4. 复制并安全保存（仅显示一次）

### 权限说明

| 权限 | 说明 |
| --- | --- |
| \`relay:video_generation\` | 视频生成 |
| \`relay:text\` | 文本相关（Chat、TTS、Embeddings） |
| \`relay:image_generation\` | 图像生成 |
| \`relay:portrait_assets:read\` | 人像资产读取（Get/List） |
| \`relay:portrait_assets:write\` | 人像资产写入（Create/Update/Delete） |
| \`relay:portrait_assets:liveness\` | 真人认证会话 |`,
  },
  {
    id: "portrait-assets",
    title: "人像资产中转",
    icon: Boxes,
    description: "工作区隔离的火山方舟资产组、资产与真人认证 Action API。",
    endpoint: "POST /api/v3/portrait-assets?Action=...&Version=2024-01-01",
    method: "POST",
    path: "/api/v3/portrait-assets",
    permission: "relay:portrait_assets:read / write / liveness",
    content: `## 人像资产中转

固定入口：

\`\`\`text
POST /api/v3/portrait-assets?Action=<Action>&Version=2024-01-01
\`\`\`

Action 使用火山 PascalCase 请求合同，不提供任意 Action 或未知字段透传。

| 类别 | Action | 权限 |
| --- | --- | --- |
| 读取 | GetAssetGroup、ListAssetGroups、GetAsset、ListAssets | \`relay:portrait_assets:read\` |
| 写入 | Create/Update/Delete AssetGroup、Create/Update/Delete Asset | \`relay:portrait_assets:write\` |
| 真人认证 | CreateVisualValidateSession、GetVisualValidateResult | \`relay:portrait_assets:liveness\` |

所有写操作必须携带 \`Idempotency-Key\`。\`CreateAsset\` 还必须携带 \`X-Fanjin-Portrait-Consent: confirmed\`，确认调用方已经取得合法肖像、声音和素材授权。

### 读取资产组

\`\`\`bash
curl -X POST \\
  'https://<繁境域名>/api/v3/portrait-assets?Action=ListAssetGroups&Version=2024-01-01' \\
  -H 'Authorization: Bearer <FANJIN_API_KEY>' \\
  -H 'Content-Type: application/json' \\
  -d '{"PageNumber":1,"PageSize":20}'
\`\`\`

### 创建资产

\`\`\`bash
curl -X POST \\
  'https://<繁境域名>/api/v3/portrait-assets?Action=CreateAsset&Version=2024-01-01' \\
  -H 'Authorization: Bearer <FANJIN_API_KEY>' \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: portrait-create-0001' \\
  -H 'X-Fanjin-Portrait-Consent: confirmed' \\
  -d '{"GroupId":"group-xxx","URL":"https://media.example.com/person.png","Name":"角色正面","AssetType":"Image"}'
\`\`\`

工作区始终由 API Key 的服务端绑定决定；\`X-Fanjin-Workspace-Id\` 只能缺省或与绑定值一致。0.1.5 不在繁境本地镜像该 URL，也不建立本地资产归属副本，请保证地址在火山异步处理期间持续有效。

本接口的错误包络为扁平格式：\`{"code":"...","message":"..."}\`；不要按下方其他通用 API 的嵌套 \`error\` 包络解析。`,
  },
  {
    id: "mcp",
    title: "Codex / MCP",
    icon: TerminalSquare,
    description: "让 Codex 或 IDE 通过繁境平台 MCP 读取工作区与项目上下文。",
    endpoint: "POST /api/mcp",
    method: "POST",
    path: "/api/mcp",
    permission: "mcp:connect",
    content: `## Codex / MCP

繁境提供 Streamable HTTP MCP。请创建一个绑定工作区、包含 \`mcp:connect\` 和所需工具权限的 API Key（建议使用“MCP / CLI 连接”页面的只读预设）。

**权限**: \`mcp:connect\`

### Codex CLI

\`\`\`bash
export FANJIN_MCP_TOKEN="<YOUR_FANJIN_API_KEY>"
codex mcp add fanjin --url "https://YOUR_FANJIN_HOST/api/mcp" --bearer-token-env-var FANJIN_MCP_TOKEN
\`\`\`

若要默认绑定项目，可在 URL 后增加 \`?projectId=123\`。密钥只保存在用户本机环境变量中，不要写入项目文件。`,
  },
  {
    id: "errors",
    title: "错误处理",
    icon: Zap,
    description: "通用 API 的错误响应格式和常见错误码。",
    content: `## 错误响应格式

\`\`\`json
{
  "error": {
    "code": "invalid_api_key",
    "message": "API Key 缺失、无效或已撤销",
    "type": "authentication_error"
  }
}
\`\`\`

## 常见错误码

| HTTP | code | 说明 |
| --- | --- | --- |
| 400 | \`invalid_request\` | 参数结构错误或字段类型错误 |
| 401 | \`invalid_api_key\` | API Key 缺失、无效或已撤销 |
| 403 | \`permission_denied\` | 无权限访问该能力 |
| 429 | \`rate_limit_exceeded\` | 触发限流 |
| 429 | \`quota_exceeded\` | 额度不足 |
| 500 | \`internal_error\` | 服务器内部错误 |
| 503 | \`service_unavailable\` | 模型能力暂不可用 |
| 504 | \`task_timeout\` | 任务超时 |`,
  },
  {
    id: "chat",
    title: "Chat Completions",
    icon: TerminalSquare,
    description: "与 OpenAI 兼容的聊天补全接口，支持流式输出。",
    endpoint: "POST /v1/chat/completions",
    method: "POST",
    path: "/v1/chat/completions",
    permission: "relay:text",
    content: `## Chat Completions

与 OpenAI Chat Completions API 兼容，支持流式 (SSE) 和非流式模式。

**权限**: \`relay:text\`

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`model\` | string | 是 | 模型 ID |
| \`messages\` | array | 是 | 消息数组 |
| \`stream\` | boolean | 否 | 是否启用流式输出，默认 false |
| \`temperature\` | number | 否 | 采样温度 |
| \`max_tokens\` | integer | 否 | 最大生成 token 数 |

### 请求示例

\`\`\`json
{
  "model": "deepseek-v3",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": false
}
\`\`\`

### 响应示例

\`\`\`json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1760000000,
  "model": "deepseek-v3",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 8,
    "total_tokens": 18
  }
}
\`\`\``,
  },
  {
    id: "images",
    title: "图片生成",
    icon: FileCode2,
    description: "与 OpenAI 兼容的图像生成接口。",
    endpoint: "POST /v1/images/generations",
    method: "POST",
    path: "/v1/images/generations",
    permission: "relay:image_generation",
    content: `## 图片生成

与 OpenAI Image Generation API 兼容。

**权限**: \`relay:image_generation\`

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`model\` | string | 是 | 模型 ID |
| \`prompt\` | string | 是 | 图像描述提示词 |
| \`n\` | integer | 否 | 生成数量，默认 1 |
| \`size\` | string | 否 | 图像尺寸，如 \`1024x1024\` |
| \`seed\` | integer | 否 | 随机种子 |
| \`guidance_scale\` | number | 否 | 引导强度 |
| \`output_format\` | string | 否 | 输出格式 (png/jpeg/webp) |

### 请求示例

\`\`\`json
{
  "model": "flux-1-dev",
  "prompt": "A beautiful sunset over the ocean, digital art",
  "n": 1,
  "size": "1024x1024"
}
\`\`\`

### 响应示例

\`\`\`json
{
  "created": 1760000000,
  "data": [
    {
      "url": "https://media.fanjin.example.com/signed/image.png",
      "revised_prompt": "A beautiful sunset over the ocean, digital art"
    }
  ]
}
\`\`\``,
  },
  {
    id: "video",
    title: "视频生成",
    icon: Globe,
    description: "异步视频生成任务接口，支持文生视频和图生视频。",
    endpoint: "POST /api/v3/contents/generations/tasks",
    method: "POST",
    path: "/api/v3/contents/generations/tasks",
    permission: "relay:video_generation",
    content: `## 视频生成

创建异步视频生成任务，支持文生视频、图生视频。

**权限**: \`relay:video_generation\`

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`projectId\` | integer | 是 | 当前 API Key 工作区内的活动项目 ID；请从项目列表或创建项目响应读取，不得使用默认/system 项目 |
| \`model\` | string | 是 | 模型 ID |
| \`canonicalRequest\` | object | 推荐；媒体或 Seedance 2.5 必填 | 规范化视频请求；使用模型目录声明的 operation、时长、画幅、分辨率和音频能力 |
| \`canonicalRequest.inputs\` | array | 规范化请求内必填 | 文生视频传 []；参考素材必须使用当前项目的受控 assetVersionId、mediaType、role、order，不能直接传外部 URL |
| \`callback_url\` | string | 否 | 任务完成回调地址 |

### 请求示例

\`\`\`json
{
  "projectId": 12345,
  "model": "doubao-seedance-2-0-fast-260128",
  "canonicalRequest": {
    "version": "provider-neutral-video-request/v1",
    "operation": "generate",
    "modelRouteId": "doubao-seedance-2-0-fast-260128",
    "prompt": "雨夜便利店，电影感镜头",
    "aspectRatio": "16:9",
    "durationSeconds": 5,
    "outputResolution": "720p",
    "generateAudio": false,
    "preserveSourceAudio": false,
    "inputs": []
  }
}
\`\`\`

示例参数须与当前模型能力目录一致；modelRouteId 可使用同一公开模型 ID。规范化请求不是绕过校验的标记：服务端会重新校验模型能力、项目素材与当前策略，并生成可信策略证据。旧版纯文本 \`prompt/content\` 请求无论素材策略开关是否开启，均扫描完整请求中的素材引用，并由服务端补齐规范化视频请求和当前策略证据；兼容入口保留 Relay 的模型路由和定价校验，不新增 Workbench 模型目录要求。未填写规格时使用 5 秒、16:9、720p，\`generate_audio\` 默认 \`true\`，可明确传 \`generate_audio: false\` 关闭音频；开启与关闭音频的费用可能不同，具体费用取决于模型、规格、实时价格和实际计费用量。合法普通扩展继续保留：\`seed\` 为安全整数，\`fps\` 为正整数，\`watermark\`、\`camera_fixed\`、\`return_last_frame\` 为布尔值，\`metadata\` 为惰性 JSON 对象，\`output_format\` 为字符串 \`mp4\`/\`mov\`；保留兼容投递不承诺每个模型均支持这些字段。未支持的顶层控制返回 \`422 legacy_video_controls_require_canonical_request\`，身份、权限、内部检查点、可信证明、计费、价格、预算和审批只能由服务端控制，\`metadata\` 注释不会被提升为这些控制。媒体输入和 Seedance 2.5 精确模型始终要求显式 \`canonicalRequest\`；延长、编辑或样片操作须使用已验证的正式 canonical/Adapter 绑定及受控素材。升级前已接受的纯文本任务以原 API Key、项目、幂等键和完整原请求重试时只读返回，不再次冻结或调用上游。

### 响应示例

\`\`\`json
{
  "id": "fvgen_01J00000000000000000000000",
  "object": "${PUBLIC_VIDEO_RESPONSE_CONTRACT.object}",
  "created_at": 1760000000,
  "updated_at": 1760000000,
  "completed_at": null,
  "model": "doubao-seedance-2-0-fast-260128",
  "status": "${PUBLIC_VIDEO_RESPONSE_CONTRACT.statuses[0]}"
}
\`\`\`

### 任务状态

| 状态 | 说明 |
| --- | --- |
| \`${PUBLIC_VIDEO_RESPONSE_CONTRACT.statuses[0]}\` | 已接受，等待处理 |
| \`${PUBLIC_VIDEO_RESPONSE_CONTRACT.statuses[1]}\` | 任务处理中 |
| \`${PUBLIC_VIDEO_RESPONSE_CONTRACT.statuses[2]}\` | 上游处理可能已完成，但本地计费或交付仍待对账；这是非终态，请继续查询且不要重复提交 |
| \`${PUBLIC_VIDEO_RESPONSE_CONTRACT.statuses[3]}\` | 任务成功，结果可用 |
| \`${PUBLIC_VIDEO_RESPONSE_CONTRACT.statuses[4]}\` | 任务失败 |
| \`${PUBLIC_VIDEO_RESPONSE_CONTRACT.statuses[5]}\` | 任务已取消 |

v0.0.7 的 wire schema 固定使用 \`${PUBLIC_VIDEO_RESPONSE_CONTRACT.object}\`、snake_case 时间字段
\`${PUBLIC_VIDEO_RESPONSE_CONTRACT.timestampFields.join(" / ")}\`，视频时长使用毫秒字段
\`output[].${PUBLIC_VIDEO_RESPONSE_CONTRACT.outputDurationField}\`。`,
  },
  {
    id: "task-query",
    title: "任务查询",
    icon: BookOpen,
    description: "查询视频生成任务状态和结果。",
    endpoint: "GET /api/v3/contents/generations/tasks/:id",
    method: "GET",
    path: "/api/v3/contents/generations/tasks/{id}",
    permission: "relay:video_generation",
    content: `## 任务查询

查询视频生成任务的当前状态和结果。

**权限**: \`relay:video_generation\`

### 路径参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`id\` | string | 是 | 任务 ID |

### 响应示例（成功）

\`\`\`json
{
  "id": "fvgen_01J00000000000000000000000",
  "object": "${PUBLIC_VIDEO_RESPONSE_CONTRACT.object}",
  "created_at": 1760000000,
  "updated_at": 1760000120,
  "completed_at": 1760000120,
  "model": "doubao-seedance-2-0-fast-260128",
  "status": "${PUBLIC_VIDEO_RESPONSE_CONTRACT.statuses[3]}",
  "output": [
    {
      "type": "video",
      "url": "${PUBLIC_VIDEO_RESPONSE_CONTRACT.stableVideoUrl}",
      "mime_type": "video/mp4",
      "width": 1280,
      "height": 720,
      "${PUBLIC_VIDEO_RESPONSE_CONTRACT.outputDurationField}": 5000
    }
  ]
}
\`\`\`

### 响应示例（失败）

\`\`\`json
{
  "id": "fvgen_01J00000000000000000000000",
  "object": "${PUBLIC_VIDEO_RESPONSE_CONTRACT.object}",
  "status": "${PUBLIC_VIDEO_RESPONSE_CONTRACT.statuses[4]}",
  "error": {
    "code": "service_unavailable",
    "message": "The selected model is temporarily unavailable."
  }
}
\`\`\``,
  },
  {
    id: "task-cancel",
    title: "取消任务",
    icon: Zap,
    description: "取消进行中的视频生成任务。",
    endpoint: "DELETE /api/v3/contents/generations/tasks/:id",
    method: "DELETE",
    path: "/api/v3/contents/generations/tasks/{id}",
    permission: "relay:video_generation",
    content: `## 取消任务

取消进行中的视频生成任务。

**权限**: \`relay:video_generation\`

仅 \`queued\` 或尚未进入不可取消阶段的任务可以取消。

### 路径参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`id\` | string | 是 | 任务 ID |

### 响应示例

\`\`\`json
{
  "id": "fvgen_01J00000000000000000000000",
  "object": "${PUBLIC_VIDEO_RESPONSE_CONTRACT.object}",
  "status": "${PUBLIC_VIDEO_RESPONSE_CONTRACT.statuses[5]}"
}
\`\`\``,
  },
  {
    id: "tts",
    title: "语音合成",
    icon: TerminalSquare,
    description: "与 OpenAI 兼容的 TTS 接口，返回音频二进制数据。",
    endpoint: "POST /v1/audio/speech",
    method: "POST",
    path: "/v1/audio/speech",
    permission: "relay:text",
    content: `## 语音合成 (TTS)

与 OpenAI TTS API 兼容，返回音频二进制数据。

**权限**: \`relay:text\`

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`model\` | string | 是 | TTS 模型 ID |
| \`input\` | string | 是 | 要转换为语音的文本 |
| \`voice\` | string | 否 | 语音类型 |
| \`response_format\` | string | 否 | 音频格式 (mp3/opus/aac/flac/wav) |
| \`speed\` | number | 否 | 语速，范围 0.25-4.0 |

### 请求示例

\`\`\`json
{
  "model": "tts-1",
  "input": "Hello, welcome to Fanjin!",
  "voice": "alloy",
  "response_format": "mp3"
}
\`\`\`

### 响应

返回音频二进制流，Content-Type 为对应格式的 MIME 类型。`,
  },
  {
    id: "embeddings",
    title: "文本嵌入",
    icon: FileCode2,
    description: "与 OpenAI 兼容的文本嵌入接口。",
    endpoint: "POST /v1/embeddings",
    method: "POST",
    path: "/v1/embeddings",
    permission: "relay:text",
    content: `## 文本嵌入 (Embeddings)

与 OpenAI Embeddings API 兼容。

**权限**: \`relay:text\`

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`model\` | string | 是 | 嵌入模型 ID |
| \`input\` | string/array | 是 | 要嵌入的文本或文本数组 |
| \`encoding_format\` | string | 否 | 编码格式 (float/base64) |
| \`dimensions\` | integer | 否 | 输出维度 |

### 请求示例

\`\`\`json
{
  "model": "text-embedding-3-small",
  "input": ["Hello world", "Fanjin AI platform"]
}
\`\`\`

### 响应示例

\`\`\`json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [0.0023064255, -0.009327292, ...],
      "index": 0
    }
  ],
  "model": "text-embedding-3-small",
  "usage": {
    "prompt_tokens": 8,
    "total_tokens": 8
  }
}
\`\`\``,
  },
  {
    id: "multimodal-embeddings",
    title: "多模态嵌入",
    icon: FileCode2,
    description: "接收带类型的文本、图片或视频输入，使用独立的多模态向量接口。",
    endpoint: "POST /v1/embeddings/multimodal",
    method: "POST",
    path: "/v1/embeddings/multimodal",
    permission: "relay:text",
    content: `## 多模态嵌入 (Multimodal Embeddings)

该接口与文本嵌入接口分离，输入必须是带 \`type\` 的对象数组；支持 \`text\`、\`image_url\` 和 \`video_url\`。

**权限**: \`relay:text\`

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`model\` | string | 是 | \`multimodal_embedding\` 模型 ID |
| \`input\` | object[] | 是 | 非空的带类型输入数组 |
| \`encoding_format\` | string/null | 否 | \`float\`、\`base64\` 或 \`null\` |
| \`dimensions\` | integer | 否 | 仅支持 1024 或 2048 |
| \`instructions\` | string | 否 | 向量化指令 |

### 请求示例

\`\`\`json
{
  "model": "doubao-embedding-vision-251215",
  "input": [
    { "type": "text", "text": "雨夜便利店" },
    {
      "type": "image_url",
      "image_url": { "url": "https://assets.example.com/rainy-store.jpg" }
    }
  ],
  "encoding_format": "float",
  "dimensions": 1024
}
\`\`\`

视频输入使用 \`{ "type": "video_url", "video_url": { "url": "https://..." } }\`；它不能作为普通字符串提交到 \`/v1/embeddings\`。`,
  },
  {
    id: "models",
    title: "模型列表",
    icon: BookOpen,
    description: "获取当前工作区可用的模型列表。",
    endpoint: "GET /v1/models",
    method: "GET",
    path: "/v1/models",
    permission: "api_key:read",
    content: `## 模型列表

获取当前工作区可用的开放 API 模型列表，已按 API Key 权限和模型白名单过滤。图片与视频模型和 Agent 创作台共用统一目录；Agent 对话模型属于内部运行时目录，不可直接作为开放 API 模型 ID 使用。

**权限**: 通过 API Key 自动鉴权

### 响应示例

\`\`\`json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v3",
      "object": "model",
      "created": 1760000000,
      "owned_by": "fanjin"
    },
    {
      "id": "flux-1-dev",
      "object": "model",
      "created": 1760000000,
      "owned_by": "fanjin"
    }
  ]
}
\`\`\`

### 获取单个模型

\`\`\`
GET /v1/models/:model
\`\`\``,
  },
] as const;

type ApiSection = {
  id: string;
  title: string;
  icon: typeof BookOpen;
  description: string;
  content: string;
  endpoint?: string;
  permission?: string;
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const node = document.createElement("textarea");
      node.value = text;
      node.className = "developerClipboardFallback";
      document.body.appendChild(node);
      node.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(node);
      return ok;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function DocSection({ section, isExpanded, onToggle }: { section: ApiSection; isExpanded: boolean; onToggle: () => void }) {
  const Icon = section.icon;
  return (
    <div className="developerDocSection">
      <button className="developerDocSectionHeader" onClick={onToggle} aria-expanded={isExpanded}>
        <div className="developerDocSectionHeaderLeft">
          <Icon size={18} />
          <span className="developerDocSectionTitle">{section.title}</span>
          {"endpoint" in section && section.endpoint ? (
            <Badge tone="info" className="developerDocEndpoint">{section.endpoint}</Badge>
          ) : null}
          {"permission" in section && section.permission ? (
            <Badge tone="neutral" className="developerDocPermission">{section.permission}</Badge>
          ) : null}
        </div>
        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {isExpanded ? (
        <div className="developerDocSectionBody">
          <p className="developerDocSectionDesc">{section.description}</p>
          <div className="developerDocMarkdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown></div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function ApiDocsPage() {
  const [copied, setCopied] = useState("");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["auth", "chat", "video"]));
  const [activeCategory, setActiveCategory] = useState<"all" | "chat" | "media" | "tasks">("all");
  const {
    catalog,
    error: catalogError,
    loading: catalogLoading,
    retry: retryCatalog,
  } = useDeveloperCatalog();
  const {
    config,
    error: configError,
    loading: configLoading,
    retry: retryConfig,
  } = useDeveloperConfig();

  const videoModel = activeModels(catalog, ["video_generation"])[0]?.model ?? "";
  const imageModel = activeModels(catalog, ["image_generation"])[0]?.model ?? "";
  const apiBaseUrl = config.apiBaseUrl;
  const videoEndpoint = config.endpoint
    || (apiBaseUrl ? `${apiBaseUrl}/api/v3/contents/generations/tasks` : "");

  const apiExample = useMemo(() => videoEndpoint && videoModel
    ? `curl -X POST ${videoEndpoint}\n  -H "Authorization: Bearer fanjin_***"\n  -H "Content-Type: application/json"\n  -d '{ "projectId": 12345, "model": "${videoModel}", "prompt": "雨夜便利店" }'`
    : "平台尚未返回可调用的视频模型；请先在「模型与能力」确认 active 模型。", [videoEndpoint, videoModel]);

  const resolvedSections = useMemo(() => API_SECTIONS.map((section) => ({
    ...section,
    content: resolveDeveloperDocModelExamples(section.content, catalog),
  })), [catalog]);

  const filteredSections = useMemo(() => {
    if (activeCategory === "all") return resolvedSections;
    const categoryMap: Record<string, string[]> = {
      chat: ["auth", "errors", "chat", "embeddings", "multimodal-embeddings", "models"],
      media: ["auth", "errors", "images", "video", "tts"],
      tasks: ["auth", "errors", "video", "task-query", "task-cancel"],
    };
    const ids = categoryMap[activeCategory] || [];
    return resolvedSections.filter((s) => ids.includes(s.id));
  }, [activeCategory, resolvedSections]);

  function toggleSection(id: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function copyExample() {
    const ok = await copyToClipboard(apiExample);
    setCopied(ok ? "示例已复制" : "复制失败，请手动复制");
    setTimeout(() => setCopied(""), 3000);
  }

  const categories = [
    { id: "all" as const, label: "全部接口", icon: BookOpen },
    { id: "chat" as const, label: "文本与嵌入", icon: TerminalSquare },
    { id: "media" as const, label: "图像与视频", icon: FileCode2 },
    { id: "tasks" as const, label: "任务管理", icon: Globe },
  ];

  return (
    <ConsolePage
      eyebrow="Developer API"
      title="API 文档"
      description="按能力组织调用说明、鉴权规则和响应结构。"
      primaryAction={(
        <Button
          variant="secondary"
          icon={<Copy size={16} />}
          disabled={!videoEndpoint || !videoModel}
          onClick={() => void copyExample()}
        >
          复制示例
        </Button>
      )}
    >
      {copied ? <Alert tone={copied.includes("失败") ? "danger" : "success"}>{copied}</Alert> : null}
      {configError ? (
        <Alert tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{configError}</span>
            <Button variant="secondary" size="compact" onClick={retryConfig}>重试接口配置</Button>
          </div>
        </Alert>
      ) : null}
      {catalogError ? (
        <Alert tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>模型目录读取失败：{catalogError}</span>
            <Button variant="secondary" size="compact" onClick={retryCatalog}>重试模型目录</Button>
          </div>
        </Alert>
      ) : null}
      {catalogLoading || configLoading ? <Alert tone="info">正在读取当前工作区模型目录与接口配置。</Alert> : null}

      {/* Category Tabs */}
      <div className="developerDocCategories">
        {categories.map((cat) => {
          const CatIcon = cat.icon;
          return (
            <button
              key={cat.id}
              className={`developerDocCategoryTab ${activeCategory === cat.id ? "active" : ""}`}
              onClick={() => setActiveCategory(cat.id)}
            >
              <CatIcon size={14} />
              {cat.label}
            </button>
          );
        })}
      </div>

      {/* Quick Stats */}
      <div className="developerDocStats">
        <div className="developerDocStat">
          <span className="developerDocStatLabel">可用模型</span>
          <span className="developerDocStatValue">{catalogError ? "不可用" : catalog.summary.active}</span>
        </div>
        <div className="developerDocStat">
          <span className="developerDocStatLabel">视频模型</span>
          <span className="developerDocStatValue">{videoModel ? <Badge tone="success">{videoModel}</Badge> : <Badge tone="warning">待配置</Badge>}</span>
        </div>
        <div className="developerDocStat">
          <span className="developerDocStatLabel">图片模型</span>
          <span className="developerDocStatValue">{imageModel ? <Badge tone="success">{imageModel}</Badge> : <Badge tone="warning">待配置</Badge>}</span>
        </div>
        <div className="developerDocStat">
          <span className="developerDocStatLabel">API Base</span>
          <span className="developerDocStatValue developerDocStatMono">{apiBaseUrl || "未配置"}</span>
        </div>
      </div>

      {/* API Sections */}
      <Section title="接口文档" icon={BookOpen}>
        <div className="developerDocSectionList">
          {filteredSections.map((section) => (
            <DocSection
              key={section.id}
              section={section}
              isExpanded={expandedSections.has(section.id)}
              onToggle={() => toggleSection(section.id)}
            />
          ))}
        </div>
      </Section>

      {/* Quick Example */}
      <Section title="快速示例" icon={TerminalSquare}>
        <div className="developerDocExample">
          <div className="developerDocExampleHeader">
            <span>cURL</span>
            <Button variant="ghost" icon={<Copy size={14} />} onClick={() => void copyExample()}>
              复制
            </Button>
          </div>
          <CodeBlock language="shell">{apiExample}</CodeBlock>
        </div>
      </Section>
    </ConsolePage>
  );
}
