#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "third_party/dependencies");
const receiptPath = path.join(root, "PUBLIC_PLATFORM_REVIEW_RECEIPT.json");
if (fs.existsSync(receiptPath)) execFileSync(process.execPath, [path.join(root, "scripts/public-platform-verify.mjs"), "--tree", root], { stdio: "pipe" });
if (fs.existsSync(output)) throw Error("Dependency notices already exist; use a fresh candidate to regenerate");
fs.mkdirSync(output, { recursive: true });
const found = new Map();
function visit(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const target = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) { visit(target); continue; }
    const file = path.join(target, "package.json");
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    const id = `${pkg.name}@${pkg.version}`;
    let item = found.get(id);
    if (!item) {
      const texts = fs.readdirSync(target).filter(f => /^(?:licen[cs]e|copying|notice|copyright)(?:\.|$)/i.test(f) && fs.statSync(path.join(target, f)).isFile());
      const notices = [];
      for (const name of texts) {
        const bytes = fs.readFileSync(path.join(target, name));
        if (bytes.includes(0) || bytes.length > 512 * 1024) continue;
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        const filename = sha256 + ".txt";
        if (!fs.existsSync(path.join(output, filename))) fs.writeFileSync(path.join(output, filename), bytes);
        notices.push({ filename, originalName: name, sha256 });
      }
      item = { name: pkg.name, version: pkg.version, declaration: pkg.license || pkg.licenses || "UNKNOWN", notices, locations: [] };
      found.set(id, item);
    }
    item.locations.push(path.relative(root, target).split(path.sep).join("/"));
    visit(path.join(target, "node_modules"));
  }
}
for (const component of ["", "fanjin-new/fanjin-api", "fanjin-new/fanjin-v4"]) visit(path.join(root, component, "node_modules"));
const packages = [...found.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const report = { schema: "fanjin-installed-notices/v1", scope: "exact installed candidate dependencies, including development tools", packages };
fs.writeFileSync(path.join(output, "index.json"), JSON.stringify(report, null, 2) + "\n");
const sbom = { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { properties: [{ name: "fanjin:scope", value: "Installed source-development dependencies; host-specific optional binaries; not a production image SBOM" }, { name: "fanjin:platform", value: `${process.platform}-${process.arch}` }] }, components: packages.map(p => ({ type: "library", name: p.name, version: p.version, "bom-ref": `${p.name}@${p.version}`, purl: `pkg:npm/${p.name.replace("@", "%40")}@${p.version}`, ...(typeof p.declaration === "string" && p.declaration !== "UNKNOWN" ? { licenses: [{ license: { name: p.declaration } }] } : {}), properties: [{ name: "fanjin:locations", value: p.locations.join(",") }, { name: "fanjin:license-texts", value: p.notices.map(n => n.filename).join(",") }] })) };
fs.writeFileSync(path.join(output, "sbom.cdx.json"), JSON.stringify(sbom, null, 2) + "\n");
fs.writeFileSync(path.join(output, "README.md"), "# Installed dependency license texts\n\nGenerated from the locked candidate installation. index.json records package/version, metadata declarations, copied license/NOTICE text hashes and installation locations. sbom.cdx.json describes that exact installed host, including development tools and host-specific optional binaries; it does not claim coverage of other platforms or a production image. Metadata-only entries are identified; no license is invented. Native binaries and node_modules are not redistributed in this source tree. Before distributing compiled bundles or containers, include the notices and audit the dependencies installed for that target.\n");
if (fs.existsSync(receiptPath)) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.preparedCandidateSha256 = receipt.candidateSha256;
  for (const name of fs.readdirSync(output).sort()) {
    const relative = `third_party/dependencies/${name}`;
    if (receipt.files.some(f => f.path === relative)) throw Error("duplicate generated notice path");
    receipt.files.push({ path: relative, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(output, name))).digest("hex"), generated: "exact locked installed dependency license inventory" });
  }
  receipt.files.sort((a, b) => a.path.localeCompare(b.path));
  receipt.candidateSha256 = crypto.createHash("sha256").update(receipt.files.map(r => `${r.sha256} ${r.path}\n`).join("")).digest("hex");
  receipt.dependencyInventory = { packages: packages.length, platform: `${process.platform}-${process.arch}`, binariesRedistributed: false };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
}
process.stdout.write(JSON.stringify({ packages: packages.length, copiedTexts: fs.readdirSync(output).filter(f => f.endsWith(".txt")).length, metadataOnly: packages.filter(p => !p.notices.length).map(p => `${p.name}@${p.version}`), unknown: packages.filter(p => p.declaration === "UNKNOWN").map(p => ({ name: p.name, version: p.version, copiedTexts: p.notices.length })) }) + "\n");
