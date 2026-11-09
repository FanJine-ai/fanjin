#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_PATTERNS = [
  { id: "private-key", pattern: /-----BEGIN (?:[A-Z0-9-]+ )*PRIVATE KEY-----/gu },
  { id: "volc-access-key", pattern: /\bAKLT[A-Za-z0-9]{16,}\b/gu },
  { id: "cloud-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  {
    id: "named-secret",
    pattern: /\b(?:[a-z0-9]+_)*(?:secret(?:_access)?_?key|api_?key|access_?token|client_?secret|password)\b["']?[^\S\r\n]*[:=][^\S\r\n]*(?:"([^"\r\n]{16,})"|'([^'\r\n]{16,})'|([A-Za-z0-9+/=_-]{24,}))/giu,
  },
];
const SAFE_MARKERS = /(?:change[_-]?me|example|fixture|placeholder|redacted|dummy|test[_-]?only|请输入|密码必须同时包含|\*{4,}|x{12,}|<[^>]+>|\$\{[^}]+\})/iu;

function runGit(args, { allowFailure = false, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer, shell: false });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(String(result.stderr || result.error?.message || `git exited ${result.status}`).trim());
  }
  return result.status === 0 ? String(result.stdout || "") : null;
}

function parseArguments(argv) {
  const options = { changedOnly: false, target: process.env.FANJIN_RELEASE_TARGET_COMMIT || "HEAD" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--changed-only") { options.changedOnly = true; continue; }
    if (!["--base", "--target"].includes(flag)) throw new Error(`unknown argument ${flag || "<missing>"}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    options[flag === "--base" ? "base" : "target"] = value;
    index += 1;
  }
  options.base ||= process.env.FANJIN_RELEASE_BASE_COMMIT || null;
  return options;
}

function pathsToScan(options) {
  if (options.base) {
    return runGit(["diff", "--name-only", "--diff-filter=ACMR", `${options.base}..${options.target}`, "--"])
      .split("\n").map((value) => value.trim()).filter(Boolean);
  }
  if (options.changedOnly) {
    const unstaged = runGit(["diff", "--name-only", "--diff-filter=ACMR", "--"]);
    const staged = runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--"]);
    const untracked = runGit(["ls-files", "--others", "--exclude-standard"]);
    return [...new Set(`${unstaged}\n${staged}\n${untracked}`.split("\n").map((value) => value.trim()).filter(Boolean))];
  }
  return runGit(["ls-files"]).split("\n").map((value) => value.trim()).filter(Boolean);
}

function contentAt(repositoryPath, options) {
  if (options.base) return runGit(["show", `${options.target}:${repositoryPath}`], { allowFailure: true, maxBuffer: 8 * 1024 * 1024 });
  const absolute = path.join(ROOT, repositoryPath);
  try {
    const metadata = fs.statSync(absolute);
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) return null;
    return fs.readFileSync(absolute, "utf8");
  } catch { return null; }
}

export function scanTextForSecrets(source) {
  const findings = [];
  for (const rule of SECRET_PATTERNS) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      const token = String(match[1] || match[2] || match[3] || match[0]);
      if (SAFE_MARKERS.test(token)) continue;
      const before = source.slice(0, match.index).split("\n").length;
      findings.push({ ruleId: rule.id, line: before });
    }
  }
  return findings;
}

export function runSecretScan(options) {
  const findings = [];
  const paths = pathsToScan(options);
  for (const repositoryPath of paths) {
    if (/(?:^|\/)(?:node_modules|dist|build|coverage|\.fanjin-release)(?:\/|$)/u.test(repositoryPath)) continue;
    if (/\.(?:pem|p12|pfx|key)$/iu.test(repositoryPath) && !/(?:example|fixture|public|\.pub\b)/iu.test(repositoryPath)) {
      findings.push({ path: repositoryPath, ruleId: "secret-file", line: 1 });
      continue;
    }
    const source = contentAt(repositoryPath, options);
    if (source === null || source.includes("\0")) continue;
    findings.push(...scanTextForSecrets(source).map((finding) => ({ path: repositoryPath, ...finding })));
  }
  const receipt = {
    ok: findings.length === 0,
    schema: "fanjin-release-secret-scan/v1",
    baseCommit: options.base,
    targetCommit: options.target,
    scannedFiles: paths.length,
    findings,
  };
  if (findings.length > 0) {
    const error = new Error(`secret scan found ${findings.length} high-confidence finding(s)`);
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const receipt = runSecretScan(parseArguments(argv));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(error.receipt || { ok: false, error: error.message })}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
