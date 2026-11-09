#!/usr/bin/env node
// Internal review copy only. This is deliberately separate from approved export.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanTextForSecrets } from "./release-secret-scan.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--output") throw Error("usage: --source <commit> --output <new-external-review-directory>");
const source = execFileSync("git", ["rev-parse", "--verify", `${args[1]}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const output = path.resolve(args[3]);
if (fs.existsSync(output) || output === root || output.startsWith(root + path.sep)) throw Error("output must be a new external directory");
const parent = fs.realpathSync(path.dirname(output));
if (parent === root || parent.startsWith(root + path.sep)) throw Error("output parent must resolve outside repository");
const read = file => execFileSync("git", ["show", `${source}:${file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const manifestBytes = read(".github/public-platform-manifest.json");
const manifest = JSON.parse(manifestBytes);
if (manifest.schema !== "fanjin-public-platform-review/v1" || manifest.status !== "proposed") throw Error("only the proposed internal-review manifest is supported");
let publicationTarget, publicationTargetSha256;
if (manifest.publicationTarget) {
  if (manifest.publicationTarget !== ".github/public-platform-target.json") throw Error("unexpected publication target source");
  const bytes = read(manifest.publicationTarget);
  publicationTarget = JSON.parse(bytes);
  publicationTargetSha256 = sha(bytes);
  if (publicationTarget.schema !== "fanjin-public-platform-target/v1" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(publicationTarget.repository) || publicationTarget.url !== `https://github.com/${publicationTarget.repository}` || !/^[a-f0-9]{40}$/.test(publicationTarget.initialCommit)) throw Error("invalid public repository target");
}
const tree = new Map(execFileSync("git", ["ls-tree", "-r", "-z", source], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean).map(line => {
  const [meta, file] = line.split("\t"); const [mode, type, id] = meta.split(" "); return [file, { mode, type, id }];
}));
if (!Array.isArray(manifest.files) || new Set(manifest.files).size !== manifest.files.length) throw Error("manifest must contain unique file paths");
const ids = manifest.files.map(file => {
  const entry = tree.get(file);
  if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw Error(`non-regular source: ${file}`);
  return entry.id;
});
const batch = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: ids.join("\n") + "\n", maxBuffer: 128 * 1024 * 1024 });
let offset = 0;
const blobs = ids.map(id => {
  const newline = batch.indexOf(10, offset);
  const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(batch.subarray(offset, newline).toString("ascii"));
  if (!match || match[1] !== id) throw Error("unexpected Git batch response");
  const start = newline + 1, end = start + Number(match[2]);
  if (batch[end] !== 10) throw Error("truncated Git blob");
  offset = end + 1;
  return batch.subarray(start, end);
});
const stage = fs.mkdtempSync(path.join(parent, ".fanjin-platform-review-"));
const records = [], findings = [], triaged = [];
try {
  for (const [index, file] of manifest.files.entries()) {
    if (typeof file !== "string" || file.startsWith("/") || file.includes("\\") || file.split("/").some(s => ["", ".", "..", ".git", "node_modules"].includes(s) || s === ".env" || s.startsWith(".env.")) || /^(?:artifacts|ops|deploy|data)\//.test(file) || /^fanjin-new\/fanjin-api\/(?:data|deploy)\//.test(file) || /\.(?:pem|key|pfx|p12|sqlite|db|png|webp|jpg|mp4|woff2?)$/i.test(file)) throw Error(`unsafe manifest entry: ${file}`);
    let bytes = blobs[index];
    if (bytes.includes(0) || bytes.length > 2 * 1024 * 1024) throw Error(`non-text or oversized source: ${file}`);
    const originalSha256 = sha(bytes);
    let text = bytes.toString("utf8");
    if (file === "package.json" || file === "fanjin-new/fanjin-api/package.json" || file === "fanjin-new/fanjin-v4/package.json") {
      const pkg = JSON.parse(text);
      if (publicationTarget) {
        pkg.repository = { type: "git", url: `git+${publicationTarget.url}.git`, ...(file === "package.json" ? {} : { directory: path.posix.dirname(file) }) };
        pkg.bugs = { url: `${publicationTarget.url}/issues` };
        pkg.homepage = `${publicationTarget.url}#readme`;
      }
      if (file === "package.json") pkg.scripts = {
        "build:api": "node scripts/public-platform-build.mjs",
        "build:web": "npm --prefix fanjin-new/fanjin-v4 run build",
        "smoke": "node scripts/public-platform-smoke.mjs",
        "start": "node scripts/public-platform-server.mjs",
        "update:setup": "node fanjin-new/fanjin-community-updater/src/cli.mjs init",
        "start:managed": "node fanjin-new/fanjin-community-updater/src/cli.mjs serve",
        "update:url": "node fanjin-new/fanjin-community-updater/src/cli.mjs url",
        "update:check": "node fanjin-new/fanjin-community-updater/src/cli.mjs check",
        "test:updater": "node --test fanjin-new/fanjin-community-updater/tests/*.test.mjs",
        "test:cli": "node --test fanjin-new/fanjin-cli/test/*.test.mjs",
      };
      if (file.endsWith("fanjin-api/package.json")) {
        pkg.scripts = { dev: "tsx watch src/app.ts", check: "tsc --noEmit", "test:public": "vitest run tests/unit/fanjinToolsCreation.test.ts tests/unit/fanjinToolsTransport.test.ts tests/unit/mcpProtocol.test.ts tests/api/referenceMultipartUpload.test.ts" };
        delete pkg.fanjinModelConfiguration;
        delete pkg.dependencies["@ai-sdk/devtools"];
        delete pkg.devDependencies["license-checker"];
        delete pkg.devDependencies["@types/license-checker"];
      }
      if (file.endsWith("fanjin-v4/package.json")) pkg.scripts = {
        build: "tsc -b && vite build", dev: "vite --host 127.0.0.1", preview: "vite preview --host 127.0.0.1",
      };
      text = JSON.stringify(pkg, null, 2) + "\n";
    }
    if (file === "fanjin-new/fanjin-api/src/env.ts") {
      text = 'import dotenv from "dotenv";\n// Public profile: no system credential-store integration.\nif (process.env.FANJIN_LOAD_LOCAL_ENV === "1") dotenv.config();\nprocess.env.NODE_ENV ||= "prod";\n';
    }
    if (file === "fanjin-new/fanjin-api/src/utils/ai.ts") {
      text = text.replace('import { devToolsMiddleware } from "@ai-sdk/devtools";', 'const devToolsMiddleware = (): never => { throw new Error("AI debug server is excluded from the public profile"); };');
      text = text.replace('switchAiDevTool?.value === "1"', 'false');
    }
    if (file.startsWith("fanjin-new/fanjin-v4/src/")) {
      text = text.replace(/(?:jimeng|doubao|luma|future-city-preview|storyboard-terrain|backend-reference|workbench-reference)\.(?:png|webp)/g, "public-placeholder.svg");
    }
    if (file === "fanjin-new/fanjin-v4/src/features/showcase/catalog.ts") {
      text = text.replace('import arkSources from "./ark-source.json";', 'const arkSources: Record<string, ArkSource> = {};');
      text = text.replace('import jimeng from "./jimeng-cases.json";', 'const jimeng: InspirationCase[] = [{ id: "synthetic-canvas-example", title: "Canvas example", source: "Synthetic local example", author: "Fanjin", category: "Example", kind: "skill", description: "Organize your own media in the canvas", videos: [], template: { inputs: ["Your own media"], steps: ["Describe your goal", "Arrange canvas nodes"], notes: ["No automatic paid generation"] } }];');
      text = text.replace('import { arkTemplates, arkWork, windTemplates, windWork } from "./ark-templates";', 'const arkTemplates: Array<{ number: number; title: string; description: string; timecode: string }> = []; const windTemplates: typeof arkTemplates = []; const arkWork = { source: "Synthetic", author: "Fanjin", title: "Example" }; const windWork = arkWork;');
    }
    if (file === "fanjin-new/fanjin-cli/README.md") text = text.replace("[共享协议](../../docs/features/account-workspace-analytics.md)", "共享协议（参见 API 工具发现返回的参数说明）");
    if (file === "fanjin-new/fanjin-api/NOTICES.txt") text = "Historical dependency metadata has been replaced by THIRD_PARTY_NOTICES.md and the exact installed license texts in third_party/dependencies/index.json. Original Toonflow attribution and historical terms remain in third_party/toonflow/.\n";
    for (const hit of scanTextForSecrets(text)) {
      const reviewed = manifest.falsePositives.find(r => r.path === file && r.sha256 === originalSha256 && r.line === hit.line && r.ruleId === hit.ruleId);
      (reviewed ? triaged : findings).push({ path: file, ...hit, ...(reviewed ? { reason: reviewed.reason } : {}) });
    }
    bytes = Buffer.from(text);
    const target = path.join(stage, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: "wx" });
    records.push({ path: file, originalSha256, sha256: sha(bytes), transformed: originalSha256 !== sha(bytes) });
  }
  if (findings.length) throw Error(`untriaged credential patterns in review copy: ${JSON.stringify(findings)}`);
  for (const [destination, input] of Object.entries({
    "README.md": "docs/open-source/PUBLIC-README.zh-CN.md",
    "README.en.md": "docs/open-source/PUBLIC-README.md",
    "SECURITY.md": "docs/open-source/PUBLIC-SECURITY.md",
    "CONTRIBUTING.md": "docs/open-source/PUBLIC-CONTRIBUTING.md",
    "THIRD_PARTY_NOTICES.md": "docs/open-source/PUBLIC-NOTICES.md",
  })) {
    if (!manifest.files.includes(input)) continue;
    const aliases = { "PUBLIC-README.zh-CN.md": "README.md", "PUBLIC-README.md": "README.en.md", "PUBLIC-SECURITY.md": "SECURITY.md", "PUBLIC-CONTRIBUTING.md": "CONTRIBUTING.md", "PUBLIC-NOTICES.md": "THIRD_PARTY_NOTICES.md", "local-storage.zh-CN.md": "docs/open-source/local-storage.zh-CN.md", "community-updates.zh-CN.md": "docs/open-source/community-updates.zh-CN.md" };
    let text = fs.readFileSync(path.join(stage, input), "utf8").replace(/\]\(\.\.\/\.\.\//g, "](");
    for (const [from, to] of Object.entries(aliases)) text = text.replaceAll(`](${from})`, `](${to})`);
    const bytes = Buffer.from(text);
    fs.writeFileSync(path.join(stage, destination), bytes, { flag: "wx" });
    records.push({ path: destination, sha256: sha(bytes), source: input });
  }
  fs.appendFileSync(path.join(stage, ".gitignore"), "\n.fanjin-data/\n.local-dev/\n**/build-public/\n**/dist/\nnode_modules/\n");
  const ignoreRecord = records.find(r => r.path === ".gitignore");
  if (ignoreRecord) { ignoreRecord.sha256 = sha(fs.readFileSync(path.join(stage, ".gitignore"))); ignoreRecord.transformed = true; }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="144" viewBox="0 0 256 144"><rect width="256" height="144" fill="#e5e7eb"/><path d="M80 100V44h88v12H94v16h64v12H94v16z" fill="#64748b"/></svg>\n';
  for (const file of ["fanjin-new/fanjin-v4/src/assets/public-placeholder.svg", "fanjin-new/fanjin-v4/src/assets/fanjin-logo-fj.svg"]) {
    fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
    fs.writeFileSync(path.join(stage, file), svg, { flag: "wx" });
    records.push({ path: file, sha256: sha(svg), generated: "synthetic neutral vector; no original media copied" });
  }
  let typeSupportSha256;
  if (manifest.typeSupport) {
    if (manifest.typeSupport !== ".github/public-platform-type-support.json") throw Error("unexpected type support source");
    const supportBytes = read(manifest.typeSupport);
    typeSupportSha256 = sha(supportBytes);
    const support = JSON.parse(supportBytes);
    if (support.schema !== "fanjin-public-type-support/v1") throw Error("invalid type support schema");
    for (const item of support.entries) {
      if (!/^fanjin-new\/fanjin-api\/scripts\/(?:lib\/)?[a-z0-9-]+\.d\.ts$/.test(item.path) || sha(read(item.source)) !== item.sourceSha256) throw Error("invalid or stale type declaration");
      fs.mkdirSync(path.dirname(path.join(stage, item.path)), { recursive: true });
      fs.writeFileSync(path.join(stage, item.path), item.declaration, { flag: "wx" });
      records.push({ path: item.path, sha256: sha(item.declaration), originalSha256: item.sourceSha256, generated: `TypeScript ${support.compiler} declaration only; excluded production operator implementation`, source: item.source });
    }
  }
  fs.writeFileSync(path.join(stage, "PUBLIC_REVIEW_ONLY.txt"), publicationTarget
    ? `LOCAL REVIEW CANDIDATE. Product source has not been uploaded. Target: ${publicationTarget.url}. Import must preserve initial commit ${publicationTarget.initialCommit}. This marker does not authorize pushing or production deployment.\n`
    : "INTERNAL REVIEW ONLY. NOT APPROVED FOR PUBLICATION. Engineering verification and target repository selection are required before publication.\n");
  const paths = records.map(r => r.path);
  if (new Set(paths).size !== paths.length) throw Error("duplicate output path in candidate");
  for (const record of records) {
    record.sha256 = sha(fs.readFileSync(path.join(stage, record.path)));
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  const candidateSha256 = sha(records.map(r => `${r.sha256} ${r.path}\n`).join(""));
  const receipt = { schema: manifest.schema, internalReviewOnly: true, publishable: false, sourceCommit: source, manifestSha256: sha(manifestBytes), typeSupportSha256, publicationTargetSha256, ...(publicationTarget ? { publicationTarget: { repository: publicationTarget.repository, url: publicationTarget.url, initialCommit: publicationTarget.initialCommit } } : {}), candidateSha256, files: records, falsePositives: triaged, mediaCopied: 0, privateHistoryCopied: false };
  fs.writeFileSync(path.join(stage, "PUBLIC_PLATFORM_REVIEW_RECEIPT.json"), JSON.stringify(receipt, null, 2) + "\n");
  fs.renameSync(stage, output);
  process.stdout.write(JSON.stringify({ ok: true, internalReviewOnly: true, publishable: false, sourceCommit: source, files: records.length, mediaCopied: 0, falsePositives: triaged.length }) + "\n");
} catch (error) {
  fs.rmSync(stage, { recursive: true, force: true });
  throw error;
}
