# Fanjin

Official source: [FanJine-ai/fanjin](https://github.com/FanJine-ai/fanjin), maintained by 北京繁境科技有限公司.

[简体中文](PUBLIC-README.zh-CN.md)

Fanjin is a self-hosted video creation workspace with quick creation, an infinite canvas, asset management and MCP/CLI. This local profile runs API and Worker together. Real generation requires your own provider configuration and budget; installation and synthetic tests need no model keys or paid calls.

Original source and development documentation use [MIT](../../LICENSE), copyright 北京繁境科技有限公司. Parts derive from Toonflow; preserve HBAI-Ltd and contributor credits. See [attribution](../../third_party/toonflow/README.md), [scope](../../LICENSE-SCOPE.md) and [notices](PUBLIC-NOTICES.md).

## Install

Use Node.js 24.22.0, npm, Corepack/Yarn 1.22.22 and FFmpeg/ffprobe on macOS or Linux. The local SQLite profile needs no production database, Redis or deployment tools. Native SQLite compilation may require local compiler tools.

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

Open `http://127.0.0.1:19692/`. First-login user: `root`. A random password is saved to `.fanjin-data/bootstrap.json` with owner-only permissions; change it after login. Never commit that file or your data directory. Alternatively inject `FANJIN_ROOT_PASSWORD` with at least 16 characters.

This is a single-machine local profile: loopback binding, separate SQLite, automatic initialization and background Worker. Implicit local environment-file and system credential-store loading are disabled. Production release/cluster orchestration is excluded. A production deployment needs its own database, backups, supervision, TLS and access boundaries; this profile does not certify those.

## Verify

```bash
npm run smoke
npm run test:cli
npm --prefix fanjin-new/fanjin-api run test:public
```

Smoke uses disposable data and random credentials, then cleans up. Configure real providers locally; never put keys in URLs or source control. Synthetic placeholder images replace private media.

CLI needs no npm dependencies:

```bash
node fanjin-new/fanjin-cli/bin/fanjin.mjs --help
```

For real connections explicitly set `FANJIN_API_URL=http://127.0.0.1:19692/api` and inject a workspace key created in the local UI. Remote MCP is `/api/mcp`; the CLI supplies the local stdio bridge.

See [security reporting](PUBLIC-SECURITY.md) and [contributions](PUBLIC-CONTRIBUTING.md). External code PRs are closed for the initial release.

Local file storage supports the UI and authenticated `/api/assets/uploadReference` endpoint. Resumable CLI/MCP upload requires a separately configured S3/TOS-compatible store; SQLite alone does not provide it. See [storage configuration and isolated multipart tests](local-storage.zh-CN.md). The smoke verifies persisted canvas data, a local asset upload and authenticated byte-identical download, MCP access to that same asset, and Worker heartbeat. External object storage and real model calls were not exercised.

[Contributors / 贡献者](../../CONTRIBUTORS.md)

## Managed local updates

See [local update setup and limits](community-updates.zh-CN.md). Managed installs use a separate updater, signed packages and an explicit HTTPS feed. Existing source-based installations are not automatically adopted. This first version supports same-schema SQLite updates only; the distribution service must be configured separately.

## Default official relay preset

The provider list recommends the separate official-protocol preset, with a configurable site root of `https://fanjin.top`. Text and text-to-image use `/v1`; video uses `/api/v3/contents/generations/tasks`. Enter the site root, not a `/v1` URL. The preset contains no key and does not enable itself or generate anything. Supply your own provider key and add actual model IDs from your account's `/v1/models` catalog. A local workspace MCP key is not a remote provider key.

Existing legacy Fanjin adapter settings are preserved, not silently migrated. The new video adapter returns the exact upstream URL without downloading the video or resubmitting because billing is pending. Video references require public URLs. The image preset currently supports text-to-image only; speech is unsupported. Protocol support does not imply support for every provider-specific model option.
