## 安装与适用版本 {#cli-install}

本文介绍随繁境产品版本交付的 **Fanjin CLI**，需要 **Node.js 22 或更高版本**。CLI 通过工具 HTTP API 操作工作区，与 MCP 共用项目、素材和任务数据。

> `@fanjin/cli` 是私有源码包，未发布到公共 npm。请使用与目标服务版本配套的发行包，或仓库中的 `fanjin-new/fanjin-cli`。工作区的 [MCP / CLI 连接页](#/workspace/connections)提供密钥创建、配置和连接检测。

在取得的源码包目录执行：

```bash
cd fanjin-cli
node --version
node bin/fanjin.mjs --help
npm link
fanjin --help
```

CLI 无额外运行依赖。`npm link` 用于在本机创建 `fanjin` 命令；不希望注册全局命令时，后续每个 `fanjin` 都可以替换为 `node /absolute/path/fanjin-cli/bin/fanjin.mjs`。

## 连接与身份检查 {#cli-auth}

| 环境变量 | 用途 |
| --- | --- |
| `FANJIN_API_URL` | 已开通工具服务的 API 根地址，接受站点根或以 `/api` 结尾的地址 |
| `FANJIN_API_KEY` | 绑定工作区和有效成员的 API Key，由安全环境注入 |

CLI 默认连接 `https://fanjin.top/api`；私有部署请设置实际站点地址：

```bash
export FANJIN_API_URL="https://your-fanjin.example/api"
# 通过终端或秘密管理工具安全注入 FANJIN_API_KEY。
fanjin auth whoami
fanjin projects list --limit 20
fanjin models list --type video --available
```

远程地址必须使用 HTTPS；本机回环地址允许 HTTP。Key 只能从环境变量读取，不支持 `--api-key` 参数，也不放进 URL 或配置文件。`--key` 表示操作幂等键，不是 API Key。

这些只读检查不提交生成。出现 404、HTML 或 `INVALID_RESPONSE` 时，先核对地址和服务版本；出现 `ACCESS_DENIED` 时检查 Key 与成员权限。权限列表见 [MCP 工具目录](#/docs/mcp#mcp-tools)；普通 CLI HTTP 调用不需要 `mcp:connect`，`mcp serve` 需要。

## 命令速查 {#cli-commands}

以下大写标识为占位符，需要替换成实际返回值。

| 命令 | 功能 |
| --- | --- |
| `auth whoami` | 当前工作区、身份和可用工具 |
| `projects list [--limit 20] [--cursor CURSOR]` | 项目分页列表 |
| `projects get PROJECT_ID` | 项目详情 |
| `projects create --name NAME --key KEY` | 创建项目和默认画布 |
| `models list [--type image\|video] [--available]` | 模型目录 |
| `models get MODEL_ID [--type image\|video]` | 模型输入能力 |
| `billing balance` | 工作区账本余额 |
| `canvas get --project ID [--canvas ID]` | 已保存画布摘要 |
| `assets list --project ID [--type image\|video\|audio\|text]` | 素材列表 |
| `assets get ID --project ID [--version ID]` | 素材 / 版本详情 |
| `assets upload FILE --project ID --key KEY` | 上传本地文件并登记素材 |
| `uploads start --input metadata.json --key KEY` | 准备分步上传 |
| `uploads status ID --project ID` | 查询上传会话 |
| `uploads complete ID --project ID` | 核验已上传字节并登记素材 |
| `generate quote --input request.json --key KEY` | 生成报价 |
| `approvals request QUOTE_ID --key KEY` | 获取网页预算确认入口 |
| `approvals confirm QUOTE_ID [--decision approved\|rejected] --key KEY` | 密钥所属用户直接确认或拒绝报价 |
| `approvals get APPROVAL_ID` | 查询确认结果 |
| `generate submit --quote ID [--approval ID] --key KEY` | 提交生成；省略批准编号时按密钥所属用户身份确认 |
| `tasks list --project ID` | 任务列表 |
| `tasks get TASK_ID` | 查询单个任务 |
| `tasks wait TASK_ID [--wait-ms 1800000]` | 等待原任务完成 |
| `tasks recover --key KEY` | 按原提交幂等键找回任务 |
| `tasks cancel TASK_ID` | 取消尚未派发的任务 |
| `assets download ID --project ID --output FILE [--version ID]` | 下载已保存作品 |
| `assets rename ID --project ID --name NAME --revision UPDATED_AT --key KEY` | 带并发版本检查的重命名 |
| `history list --project ID` | 当前 Key 的工具生成历史 |
| `mcp serve` | 将 stdio 桥接到远程 MCP 服务 |

列表可用 `--limit`、`--cursor` 分页，默认 20 条、最多 100 条。全局选项包括 `--json`（默认）、`--timeout-ms` 和 `--help`。请用返回的下一页 cursor，不要自己拼接。

## 用量、余额与导出 {#cli-analytics}

```bash
fanjin billing available
fanjin usage summary --scope workspace
fanjin usage list --execution-status failed --failure-category timeout --limit 20
fanjin usage get USAGE_ID
fanjin billing ledger
fanjin billing entry LEDGER_ID
fanjin account overview
fanjin account balance
fanjin account ledger
```

`billing balance` 保持工作区账本余额口径；`billing available` 查询当前工作区实际可用额度。账号钱包与团队调用成本是不同范围，不应相加。权限与筛选参数见 [MCP 用量查询](#/docs/mcp#mcp-analytics)。

后台导出适合较长的查询：

```bash
fanjin usage export-create --key export-usage-001 --kind usage --format csv
fanjin usage export-jobs
fanjin usage export-status JOB_ID
fanjin usage export-download JOB_ID --output ./usage.csv
# 需要停止尚未完成的导出时执行：
fanjin usage export-cancel JOB_ID
```

关闭终端不会取消后台任务。结果保留 24 小时，必须使用创建时的 Key 下载；网页会话创建的任务请在网页下载。`usage export --kind usage --format csv --output ./usage.csv` 可同步拉取全部分页。文件完成后才原子写入目标路径，不覆盖已有文件。

`--from` / `--to` 接受毫秒时间戳；`--status` 筛选结算状态，`--execution-status` 筛选执行状态。金额保留精确字符串；导出期间历史结算可能变化，不能当作数据库长事务快照。

## 创建项目与上传素材 {#cli-assets}

```bash
fanjin projects create --name '灯塔短片' --key project-lighthouse-001
# 将返回的项目 ID 赋给 FANJIN_PROJECT_ID。
fanjin assets upload ./reference.png \
  --project "$FANJIN_PROJECT_ID" \
  --key reference-lighthouse-001
```

上传命令传输实际文件字节，并校验大小、文件类型和 SHA-256。支持图片、视频、音频，文件不能超过 2 GiB，部署环境可能设置更小上限。保存返回的 `assetId` 与 `assetVersionId`，生成时引用明确版本。

`assets upload` 自动编排准备 → 传输 → 完成。需要自己控制传输时，使用 `uploads start`，元数据包含 `projectId`、`fileName`、`assetName`、`assetType`、`mimeType`、`sizeBytes` 和 `contentHash`，按返回指引传输字节后执行 `uploads complete`。不要把 `uploads start` 成功当作文件已经上传。

人物参考素材上传后由平台处理适用的审核，无需另配火山 AK/SK 或调用 `/api/v3/portrait-assets`。上传完成仅表示文件已保存；可查询同一版本的 `portraitAdmission`：

```bash
fanjin assets get ASSET_ID --project PROJECT_ID --version ASSET_VERSION_ID
```

人像预检不再要求等待 `ready` 才能生成：`blocking: false`、`canSubmitForProviderReview: true` 时可以用原版本 ID 报价并提交，检测和登记可后台继续。上游拒绝时查询任务中的原因，处理后再手动提交；不自动重投。`unavailable` 不能当作审核通过。详见[人物参考素材与审核](#/docs/mcp#mcp-portraits)。

已检测到人像，或已提交来源声明、等待同步的素材可以主动登记：

```bash
fanjin portrait register ASSET_VERSION_ID --project PROJECT_ID --key portrait-register-001
```

可选 `--revision REV` 防止覆盖已变化的状态。命令复用已有登记，不重复上传、不提交生成；重试同一请求保留原 `--key`。返回 `registration.status: "processing"` 后继续用 `assets get` 查询，`registered` 才表示已登记。

视频需要登记整段原片，图片人像资产不能代替视频登记。用户已经确认虚拟来源的视频，可在网页检测详情中直接点击“确认虚拟来源并登记视频”，也可通过 [MCP 声明入口](#/docs/mcp#mcp-portraits) 完成，无需等待抽帧检测；单独运行 `portrait register` 不会替用户作来源声明。

## 报价、确认与生成 {#cli-generate}

先读取模型能力，再填写请求。工具模型目录返回的 `modelId` 与 HTTP 中转使用的模型名称不应混用。

```bash
fanjin models list --type video --available
fanjin models get MODEL_ID --type video
```

将实际参数保存为 `request.json`，替换项目与模型 ID；时长、比例、分辨率、音频和素材角色必须符合模型能力：

```json
{
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
}
```

参考素材可写成 `{"assetVersionId":"456","role":"subject"}`。支持的角色包括 `subject`、`style`、`storyboard`、`first_frame`、`last_frame`，最终以模型能力为准。图片生成使用 `type: "image"`、`audio: false`，省略视频专用时长 / 模式字段，使用图片模型支持的分辨率。

```bash
fanjin generate quote --input request.json --key quote-lighthouse-001
fanjin approvals request QUOTE_ID --key approval-lighthouse-001
```

打开返回的 `confirmationPath`（拼接到站点地址），由 Key 所属用户登录，核对模型、提示词、素材版本、费用上限和有效期，再批准或拒绝。也可在用户授权预算后执行 `fanjin approvals confirm QUOTE_ID --key approval-lighthouse-001`，无需打开网页。报价本身不发起生成、不扣费。

```bash
fanjin approvals get APPROVAL_ID
# 仅在预算批准且确认有效后执行。
fanjin generate submit \
  --quote QUOTE_ID \
  --approval APPROVAL_ID \
  --key generate-lighthouse-001
fanjin tasks wait TASK_ID --wait-ms 1800000
```

报价有效期 15 分钟，一份报价与批准最多消费一次。价格或能力发生变化、报价过期时重新报价并确认。提交后保存任务 ID 和提交幂等键，后续查询都围绕原任务进行。

## 下载与结果校验 {#cli-download}

生成完成后还可能在保存作品，只有 `storageStatus: "ready"` 才能下载已归档的结果。

```bash
fanjin tasks get TASK_ID
fanjin assets list --project "$FANJIN_PROJECT_ID"
fanjin assets download ASSET_ID \
  --project "$FANJIN_PROJECT_ID" \
  --version VERSION_ID \
  --output ./lighthouse.mp4
```

CLI 校验下载字节数与 SHA-256，临时文件写完后才生成目标文件，并拒绝覆盖已有文件。需要另存版本时更换本地输出路径；不要把临时供应商链接当成持久作品 ID。

素材重命名的 `--revision` 使用 `assets get` 返回的 `updatedAt`。发生并发修改时先重新查询，再决定是否修改。

## 幂等、超时与恢复 {#cli-recovery}

显式幂等键接受 8–128 个字符，可用英文字母、数字、`.`、`_`、`:`、`-`。每个独立操作使用独立键；同一次操作重试保留原键及原参数。

```bash
# generate submit 超时后，用原提交键找回任务。
fanjin tasks recover --key generate-lighthouse-001
fanjin tasks get TASK_ID
fanjin tasks wait TASK_ID --wait-ms 1800000
```

- `--timeout-ms` 是单次请求超时，默认 30000，范围 250–120000 毫秒。
- `tasks wait --wait-ms` 是总等待时间，默认 1800000 毫秒。等待超时不会取消服务端任务。
- 上传中断后用 `uploads status` 和原上传会话 ID 查询；结果不确定时不要立即创建另一个上传。
- `needs_reconciliation` 表示供应商受理结果待核对，不应换键重新生成。
- `tasks cancel` 只取消尚未派发的工具任务；已派发任务不能通过此命令强制撤销或承诺退款。

余额返回的 `gu` 与 `guMicros` 是十进制字符串。`guMicros` 沿用账本单位，1 GU 对应 100000000 原始单位。工作区可用余额为 balance 减 frozen；授信单列，余额不包含个人钱包或赠送余额，也不等于预算已批准。

## 自动化脚本与退出码 {#cli-scripts}

成功结果是 stdout 上的 JSON，错误是 stderr 上的 JSON。脚本应同时检查进程退出码与错误 `code`，不要通过中文提示文本判断成功。

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令成功 |
| 1 | 网络、超时、响应格式或文件完整性等本地错误 |
| 2 | 命令参数或环境配置错误 |
| 3 | 权限或服务端拒绝、任务失败或待核对 |

```bash
if fanjin auth whoami > identity.json 2> error.json; then
  echo "连接检查成功，结果保存在 identity.json"
else
  fanjin_exit_code=$?
  cat error.json >&2
  exit "$fanjin_exit_code"
fi
```

自动化生成支持网页或 CLI 预算确认。`generate submit` 省略 `--approval` 时按密钥所属用户身份确认并提交，可能消耗 GU，须已有对应预算授权。将创建、报价、确认、提交和结果收集拆成可恢复步骤，持久化各阶段 ID 与幂等键。不要把提交失败处理成无限循环创建新任务。

## MCP 桥接与常见问题 {#cli-troubleshooting}

`fanjin mcp serve` 用于支持 stdio 的 MCP 客户端，配置方式见 [MCP 集成](#/docs/mcp#mcp-stdio)。它使用相同环境变量，并额外要求 `mcp:connect`。

| 问题 | 处理方法 |
| --- | --- |
| 找不到 `fanjin` 命令 | 在源码包执行 `npm link`，或直接通过 Node 运行脚本 |
| `KEY_REQUIRED` | 给执行进程注入 `FANJIN_API_KEY` |
| `INVALID_ENDPOINT` | 使用 HTTPS 根地址或 `/api`；不要填 `/v1`、工具全路径或带查询参数的地址 |
| `INVALID_RESPONSE` | 检查工具服务部署版本，避免连到普通网页或其他版本的部署环境 |
| `ACCESS_DENIED` | 检查 Key、成员身份和对应业务工具权限 |
| `INVALID_ARGUMENTS` | 运行 `--help`，核对数字 ID、UUID、参数和幂等键长度 |
| 等待超时 | 保留原任务 ID，稍后继续 `tasks get` / `tasks wait` |
| 已生成但下载失败 | 检查 `storageStatus`、素材版本和目标文件是否已存在 |

需要直接集成文本、图片、视频中转接口时，使用 [API 文档](#/docs/api)。CLI 工具链与 HTTP 中转属于不同接入方式，不能用中转权限替代工具权限。


## 视频样片与正式片

```bash
fanjin video draft --input draft-request.json --key draft-quote-001
fanjin video finalize --input final-request.json --key final-quote-001
```

两条命令均只创建报价，不直接生成。`draft-request.json` 使用普通视频请求（`type=video`、模型、提示词、画幅、时长、参考素材等），清晰度设为 `480p`；命令自动补充 `renderMode=draft`。

`final-request.json` 仅包含 `projectId`、`type: "video"` 和 `draftTaskId`（繁境样片任务 UUID）；命令补充 `renderMode=finalize`，正式片固定 1080p，继承样片参数。样片成功且仍在 7 天有效期内才能转正式片。

拿到每一步的报价后分别确认预算，再按常规 `generate submit` 流程提交。不要把前次样片授权用于正式片；超时用原幂等键恢复查询，不能换键自动重投。
