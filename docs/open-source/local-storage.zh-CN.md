# 本地附件与断点上传

默认 `npm start` 使用 SQLite 和本地文件存储。登录后可在界面上传附件，或通过登录会话调用 `POST /api/assets/uploadReference`，传入 `projectId`、`name`、`type` 和 `base64Data`；附件上限 20 MiB。冒烟使用本机生成的纯文本，上传后通过工作区 API Key 读取、下载并逐字节比较，再用 MCP `tools/call` 读取同一个素材版本。没有使用客户素材或付费服务。

`fanjin_upload_prepare` / `fanjin_upload_complete` 和界面大文件断点上传使用对象存储分片能力。默认本地驱动会明确返回 `REFERENCE_UPLOAD_STORAGE_UNSUPPORTED`，不能把 SQLite 安装成功理解为这些接口已启用。

## 自建兼容存储的配置

可连接自行管理的 S3 兼容存储。存储部署、TLS 证书、桶和访问凭据由管理员先创建；本项目不会自动创建云账户、桶或外部资源。`npm start` 只转发以下显式配置，不加载已有生产环境文件：

| 环境变量 | 自建配置 |
| --- | --- |
| `FANJIN_OBJECT_STORAGE_PROVIDER` | `s3`，或实际使用的 `tos` |
| `FANJIN_OBJECT_STORAGE_ENDPOINT` | 存储的 HTTPS 服务地址，例如 `https://localhost:9000` |
| `FANJIN_OBJECT_STORAGE_BUCKET` | 预先创建的专用桶名 |
| `FANJIN_OBJECT_STORAGE_REGION` | 服务配置的区域，例如 `us-east-1` |
| `FANJIN_OBJECT_STORAGE_ACCESS_KEY` | 该桶专用的访问标识，通过环境注入 |
| `FANJIN_OBJECT_STORAGE_SECRET_KEY` | 对应密钥，通过环境注入，不写入仓库 |
| `FANJIN_OBJECT_STORAGE_FORCE_PATH_STYLE` | 自建路径式服务设为 `1` |
| `FANJIN_OBJECT_STORAGE_URL_MODE` | `signed` |
| `FANJIN_OBJECT_STORAGE_CORS_ORIGINS` | 本地界面地址 `http://127.0.0.1:19692` |
| `NODE_EXTRA_CA_CERTS` | 私有 CA 的本地 PEM 路径；系统已信任证书时省略 |

桶应启用版本管理；授予该桶对象读写、版本读取、分片发起/列举/完成/取消所需权限。浏览器直传的桶 CORS 需允许上述界面来源、PUT/GET/HEAD 和签名请求所需头，并暴露 ETag。保持 HTTPS 和证书校验；不要设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。上传后仍按平台流程核验大小、摘要、类型和归属，不绕过权限或审核。

配置后重启 `npm start`，在本地创建工作区 API Key，再通过 CLI 的上传命令或 MCP 的 `fanjin_upload_prepare` → 上传内容 → `fanjin_upload_complete` 验证。具体参数通过 `fanjin --help`、工具发现及返回的上传指引取得。切换存储前备份独立数据目录，既有本地对象不会自动迁移。

## 可重复的独立验证

```bash
npm --prefix fanjin-new/fanjin-api run test:public
```

其中 `tests/api/referenceMultipartUpload.test.ts` 使用隔离内存 SQLite、合成文件和注入的分片存储实现，验证会话恢复、授权范围、分片完成、对象版本和内容核验。该测试不连接外部存储，不能证明某一自建存储部署已通过验收。本轮已经运行本地文件上传/MCP 链路；真实 S3/TOS 部署和付费模型不在本轮验证范围。
