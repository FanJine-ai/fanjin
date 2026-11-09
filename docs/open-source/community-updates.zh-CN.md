# 本机版本与更新

适用范围：由社区更新器管理的单机安装，Node.js 24.22.0、macOS/Linux、SQLite。源码手动启动仍可使用；本功能不会接管或停止已有实例。当前只支持数据库版本不变的升级，不支持 Windows、外接 PostgreSQL、跨数据库版本迁移或更新器自身升级。

## 首次接入

维护者需要先提供已上线的 HTTPS 更新源地址、可信签名公钥及本机架构安装包。没有真实更新源时，下面的设置不能完成安装；不要把示例地址当成可用服务，也不要从下载包自动信任新公钥。签名私钥只由维护者保管，用户不需要公司云账号或发布凭据。

先准备仅自己可读的 JSON 配置模板，放在源码目录外：

```json
{
  "home": "/absolute/path/to/new-fanjin-install",
  "feedBaseUrl": "https://updates.example.invalid/community-updates/v1",
  "channel": "stable",
  "port": 19692,
  "appPort": 19693,
  "trustedKeys": [{ "keyId": "community-key-1", "publicKey": "维护者提供的完整 Ed25519 PEM 公钥" }],
  "storage": {}
}
```

`home` 必须是新目录。端口必须未被其它服务占用。不要填写正在使用的繁境目录或端口。需要 S3/TOS 时，将[存储配置](local-storage.zh-CN.md)中的 `FANJIN_OBJECT_STORAGE_*` 字符串放入 `storage`，勿写入 Git。现有源码安装需另外安排停机复制和接管验收，此版本不自动迁移旧安装。

公开导出的源码包含以下命令：

```bash
npm run update:setup -- /absolute/path/to/template.json
npm run start:managed -- /absolute/path/to/new-fanjin-install/install.json
# 另开一个本机终端，仅在本机查看带短时/本机凭证的入口，不转发或截图：
npm run update:url -- /absolute/path/to/new-fanjin-install/install.json
```

初始化生成 owner-only 的 `install.json`，包含随机首次 root 密码和本机更新密钥。首次通过本机入口选择“检查更新 → 立即更新”安装产品。启动终端需保持运行；本版本尚未自动安装开机服务。Node 和 FFmpeg/ffprobe 需预先安装，安装包不替你安装系统软件。

## 日常更新

登录 root → 后台版本页 → “检查本机更新”。沿用管理员敏感操作认证；已有规则要求 deployment scope 的 MFA，尚未启用时应先完成账号安全设置。本机入口令牌有效 15 分钟，不包含云发布权限。

检查后显示版本说明。点击“立即更新”，更新器下载并验证签名、架构、版本、有效期及全部文件摘要，然后暂停新请求、等待原进程退出、备份 SQLite、试启动新版本、恢复服务。下载期间可继续创作，切换期间访问会提示稍候。关闭更新网页不会中断任务，但停止整个更新器会停止其管理的繁境实例。

更新页和 CLI 共用同一条持久任务；重复点击不会并发执行。配置和素材独立保留。试启动阶段失败会恢复备份；新版本已经恢复业务写入后失败，只回退兼容程序，不恢复旧数据库，避免覆盖新账单或任务。生成是否继续、何时完成仍以任务真实状态为准，更新器不会创建新的生成请求。

若进程意外退出，重新运行 `start:managed` 会恢复更新记录。出现“恢复未完成”时使用页面“重试恢复原版本”，或在本机运行：

```bash
node fanjin-new/fanjin-community-updater/src/cli.mjs recover /absolute/path/to/new-fanjin-install/install.json
```

该操作不杀死其它进程。若端口已被另一服务占用，先确认占用者；不要直接删数据、改任务状态或强行重投生成。版本目录、备份和更新记录暂不自动清理，请保留足够磁盘空间。

## 当前发布边界

实现包含本机更新器和独立发布器的社区分发接口。源码中没有默认生产更新域名、公司签名私钥或已发布安装包；代码存在不等于线上源已经启用。数据库迁移、旧安装接管、Windows 和开机托管需各自验收后才能宣布支持。
