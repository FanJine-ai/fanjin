#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startUpdater } from "./server.mjs";
import { ensure } from "./manifest.mjs";
import { atomicJson, readJson, privateDirectory } from "./files.mjs";

export async function main(args) {
  const [command, configPath, action] = args;
  ensure(configPath && path.isAbsolute(configPath), "ABSOLUTE_CONFIG_PATH_REQUIRED");
  if (command === "init") {
    const template = readJson(configPath);
    ensure(path.isAbsolute(template.home) && !fs.existsSync(template.home), "NEW_INSTALL_DIRECTORY_REQUIRED");
    privateDirectory(template.home);
    const config = { ...template, schema: "fanjin-community-install/v1", platform: process.platform + "-" + process.arch,
      channel: template.channel || "stable", port: template.port || 19692, appPort: template.appPort || 19693,
      accessSecret: randomBytes(32).toString("hex"), rootPassword: randomBytes(24).toString("base64url") };
    ensure(typeof config.feedBaseUrl === "string" && Array.isArray(config.trustedKeys) && config.trustedKeys.length > 0, "INSTALL_SOURCE_REQUIRED");
    atomicJson(path.join(template.home, "install.json"), config);
    process.stdout.write("安装配置已保存。首次登录信息保存在安装目录 install.json，请仅在本机查看。\n"); return;
  }
  const stat = fs.lstatSync(configPath);
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o077), "PRIVATE_CONFIG_REQUIRED");
  const config = readJson(configPath);
  ensure(config.schema === "fanjin-community-install/v1" && fs.realpathSync(path.dirname(configPath)) === fs.realpathSync(config.home), "INVALID_INSTALL_CONFIG");
  if (command === "serve") {
    const runtime = await startUpdater(config);
    process.stdout.write("繁境地址：http://127.0.0.1:" + config.port + "/\n");
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return; shuttingDown = true;
      try { await runtime.close(); process.exitCode = 0; } catch { process.exitCode = 1; }
    };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown); return runtime;
  }
  if (command === "url") {
    // Explicit local-owner action; never place this capability in logs or Git.
    process.stdout.write("http://127.0.0.1:" + config.port + "/__fanjin_update/#token=" + config.accessSecret + "\n"); return;
  }
  ensure(["check", "status", "apply", "recover"].includes(command), "UNKNOWN_COMMAND");
  if (command === "apply") ensure(/^[a-f0-9]{64}$/.test(action), "EXPECTED_DIGEST_REQUIRED");
  const response = await fetch("http://127.0.0.1:" + config.port + "/__fanjin_update/" + command, {
    method: command === "status" ? "GET" : "POST",
    headers: { authorization: "Bearer " + config.accessSecret, "content-type": "application/json" },
    ...(command === "status" ? {} : { body: JSON.stringify(command === "apply" ? { expectedDigest: action } : {}) }),
    signal: AbortSignal.timeout(command === "recover" ? 180000 : 20000),
  });
  const result = await response.json();
  // CLI and UI use exactly the same persisted job. No paid request is made.
  process.stdout.write(JSON.stringify({ ok: response.ok, ...result }) + "\n");
  if (!response.ok) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write((error.code || "UPDATER_FAILED") + "\n"); process.exitCode = 1; });
}
