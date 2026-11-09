#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--tree") throw Error("usage: --tree <candidate-directory>");
const root = fs.realpathSync(args[1]);
const receipt = JSON.parse(fs.readFileSync(path.join(root, "PUBLIC_PLATFORM_REVIEW_RECEIPT.json"), "utf8"));
const paths = new Set();
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
for (const item of receipt.files) {
  if (typeof item.path !== "string" || paths.has(item.path) || path.isAbsolute(item.path) || item.path.includes("\\") || item.path.split("/").some(p => ["", ".", "..", ".git"].includes(p)) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error("unsafe or duplicate receipt path");
  paths.add(item.path);
  const file = path.join(root, item.path);
  if (!fs.lstatSync(file).isFile() || sha(fs.readFileSync(file)) !== item.sha256) throw Error(`candidate bytes changed: ${item.path}`);
}
const digest = sha([...receipt.files].sort((a, b) => a.path.localeCompare(b.path)).map(r => `${r.sha256} ${r.path}\n`).join(""));
if (digest !== receipt.candidateSha256) throw Error("candidate digest mismatch");
const generatedDirectories = new Set(["node_modules", ".git", ".local-dev", ".fanjin-data", "fanjin-new/fanjin-api/node_modules", "fanjin-new/fanjin-api/build-public", "fanjin-new/fanjin-api/.test-data", "fanjin-new/fanjin-v4/node_modules", "fanjin-new/fanjin-v4/dist"]);
const metadata = new Set(["PUBLIC_PLATFORM_REVIEW_RECEIPT.json", "PUBLIC_REVIEW_ONLY.txt", "PUBLIC_PLATFORM_CERTIFICATE.json", "COMMUNITY_VALIDATION.json"]);
function inspect(directory, prefix = "") {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) {
      throw Error(`unexpected symlink: ${relative}`);
    } else if (entry.isDirectory()) {
      if (!generatedDirectories.has(relative)) inspect(path.join(directory, entry.name), relative + "/");
    } else if (!paths.has(relative) && !metadata.has(relative)) {
      throw Error(`unlisted candidate file: ${relative}`);
    }
  }
}
inspect(root);
process.stdout.write(JSON.stringify({ ok: true, files: paths.size, candidateSha256: digest, sourceCommit: receipt.sourceCommit, publishable: receipt.publishable }) + "\n");
