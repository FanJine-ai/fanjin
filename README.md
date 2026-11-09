# 繁境 Fanjin

官方开源仓库：[FanJine-ai/fanjin](https://github.com/FanJine-ai/fanjin)，由北京繁境科技有限公司维护。

[English](README.en.md)

繁境是自托管 AI 视频创作工作台，提供快速创作、无限画布、素材管理，以及 MCP/CLI。API 与 Worker 在本地配置中合并运行。模型调用需要自行配置供应商及预算，安装和合成测试不需要模型密钥，也不调用付费服务。

原创代码及开发文档采用 [MIT](LICENSE)，版权主体北京繁境科技有限公司。部分后端源自 Toonflow，保留 HBAI-Ltd 和贡献者署名；参见 [来源](third_party/toonflow/README.md)、[授权范围](LICENSE-SCOPE.md)和[第三方说明](THIRD_PARTY_NOTICES.md)。

## 安装

需要 Node.js 24.22.0、npm、Corepack/Yarn 1.22.22、FFmpeg/ffprobe。macOS 或 Linux 本地配置使用 SQLite，不需要生产数据库、Redis 或生产发布工具。首次编译原生 SQLite 模块可能需要本机编译工具。

```bash
git clone https://github.com/FanJine-ai/fanjin.git
cd fanjin-community
npm ci --ignore-scripts --no-audit --no-fund
corepack yarn --cwd fanjin-new/fanjin-api install --frozen-lockfile --ignore-scripts
npm --prefix fanjin-new/fanjin-api rebuild better-sqlite3
npm --prefix fanjin-new/fanjin-v4 ci --ignore-scripts --no-audit --no-fund
npm run build:api
npm run build:web
npm start
```

打开 `http://127.0.0.1:19692/`。首次本地管理员为 `root`，随机密码写入 `.fanjin-data/bootstrap.json`，权限为仅当前用户可读写；登录后修改密码。不要上传该文件或数据目录。也可显式注入至少 16 字符的 `FANJIN_ROOT_PASSWORD`。

该入口是单机本地自托管配置：只绑定回环地址、使用独立 SQLite，自动初始化并运行后台 Worker；禁用钥匙串和既有环境文件的隐式读取。API 上游生产发布、集群编排和签名发布系统不包含在此仓库。生产集群部署需另行设计数据库、备份、进程托管、TLS 与访问边界，本地配置不代表这些方案已验证。

## 验证

```bash
npm run smoke
npm run test:cli
npm --prefix fanjin-new/fanjin-api run test:public
```

冒烟脚本使用一次性数据库与随机凭据，测试健康、登录、画布持久化、本地素材上传与鉴权下载、同一素材的 MCP 读取及 Worker 心跳，测试结束后清理。普通测试不需要供应商账户。真实模型请在本地管理界面配置，不要把 Key 放入 URL、代码或版本控制。

本地文件存储支持界面及 `/api/assets/uploadReference` 的附件上传；CLI/MCP 的断点上传接口需要另配 S3/TOS 兼容对象存储，SQLite 本身不提供此能力。配置范围与独立合成测试见 [存储说明](docs/open-source/local-storage.zh-CN.md)。本轮没有验证外部对象存储或真实模型。

CLI 无额外 npm 依赖：

```bash
node fanjin-new/fanjin-cli/bin/fanjin.mjs --help
```

实际连接显式设置 `FANJIN_API_URL=http://127.0.0.1:19692/api`，通过环境提供在本地界面创建的工作区 API Key。远程 MCP 入口是该 API 的 `/api/mcp`，本地 stdio 桥由 CLI 提供。

安全反馈见 [SECURITY](SECURITY.md)。首发阶段只接受问题报告，外部代码 PR 暂不接收，见 [贡献说明](CONTRIBUTING.md)。演示图片为合成占位内容，不包含客户作品或生产素材。

[Contributors / 贡献者](CONTRIBUTORS.md)

## 本机更新

社区管理安装可从后台打开独立更新页面，流程及支持范围见[本机版本与更新](docs/open-source/community-updates.zh-CN.md)。需要维护者发布对应架构的签名安装包和更新源。现有源码手动启动继续保留，本版本不会自动接管旧安装或跨数据库版本升级。

## 默认官方中转预设

供应商列表优先显示“繁境官方协议（推荐）”，站点默认 `https://fanjin.top`，可自行更改。文本与文生图使用 `/v1`，视频使用 `/api/v3/contents/generations/tasks`；不要把 `/v1` 填入站点根地址。预设不含密钥，不自动启用或生成。请填入自己的 API Key，并按账户的 `/v1/models` 目录添加实际模型 ID；本地工作区 MCP Key 与远程供应商 Key 不可混用。

已有“Fanjin官方中转平台”旧适配器及配置保持不变，不会自动迁移。新预设的视频返回原始上游 URL、不下载视频，也不因账务待结算重新提交。参考视频必须使用公网 URL；当前图像预设仅支持文生图，语音接口未提供。官方协议端点可用不代表所有供应商/模型参数均兼容。
