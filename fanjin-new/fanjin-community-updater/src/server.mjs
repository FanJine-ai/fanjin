import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual, createHmac } from "node:crypto";
import { ensure, compareVersions } from "./manifest.mjs";
import { UpdateEngine } from "./engine.mjs";
import { NativeRuntime } from "./runtime.mjs";
import { privateDirectory } from "./files.mjs";

function same(a, b) { return typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export function authorized(token, secret, now = Date.now()) {
  if (same(token, secret)) return true;
  if (typeof token !== "string" || token.length > 1024) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!same(signature, expected)) return false;
  try { const value = JSON.parse(Buffer.from(payload, "base64url")); return value.scope === "local-update" && value.expiresAt > now && value.expiresAt <= now + 1800000; } catch { return false; }
}
export async function startUpdater(config, options = {}) {
  ensure(Number(process.versions.node.split(".")[0]) === 24 && compareVersions(process.versions.node, "24.22.0") >= 0, "NODE_24_REQUIRED");
  ensure(Number.isInteger(config.port) && config.port > 1024 && config.port < 65536
    && Number.isInteger(config.appPort) && config.appPort > 1024 && config.appPort < 65536
    && config.appPort !== config.port && /^[a-f0-9]{64}$/.test(config.accessSecret), "INVALID_INSTALL_CONFIG");
  config = { ...config, home: privateDirectory(config.home) };
  // OS-released SQLite lock survives daemon crashes without trusting stale PIDs.
  const owner = new DatabaseSync(path.join(config.home, "daemon-lock.sqlite"));
  fs.chmodSync(path.join(config.home, "daemon-lock.sqlite"), 0o600);
  try { owner.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
  catch { owner.close(); ensure(false, "UPDATER_ALREADY_RUNNING"); }
  const runtime = options.runtime || new NativeRuntime(config);
  let engine;
  try { engine = new UpdateEngine(config, runtime); }
  catch (error) { owner.close(); throw error; }
  const origin = "http://127.0.0.1:" + config.port;
  const send = (res, status, data) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    try {
      ensure(req.headers.host === "127.0.0.1:" + config.port, "INVALID_HOST");
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith("/__fanjin_update/")) {
        ensure(!req.headers.origin || req.headers.origin === origin, "CROSS_ORIGIN_DENIED");
        const name = url.pathname.slice("/__fanjin_update/".length);
        if (req.method === "GET" && ["", "app.js", "style.css"].includes(name)) {
          const file = name || "index.html";
          res.writeHead(200, {
            "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".css") ? "text/css" : "text/javascript",
            "cache-control": "no-store", "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
            "referrer-policy": "no-referrer",
          });
          res.end(fs.readFileSync(new URL("../web/" + file, import.meta.url))); return;
        }
        ensure(authorized(req.headers.authorization?.replace(/^Bearer /, ""), config.accessSecret), "LOCAL_UPDATE_AUTH_REQUIRED");
        if (req.method === "GET" && name === "status") { send(res, 200, engine.status()); return; }
        ensure(req.method === "POST" && req.headers["content-type"] === "application/json", "INVALID_REQUEST");
        let body = "";
        for await (const chunk of req) { body += chunk; ensure(Buffer.byteLength(body) <= 2048, "REQUEST_TOO_LARGE"); }
        const input = JSON.parse(body || "{}");
        if (name === "check") { send(res, 200, await engine.check()); return; }
        if (name === "recover") {
          ensure(!engine.busy, "UPDATE_IN_PROGRESS");
          ensure(engine.get("startupError") || engine.get("job")?.state === "recovery_required", "RECOVERY_NOT_NEEDED");
          engine.busy = true;
          try {
            await runtime.stop({ requireClean:false });
            send(res, 200, await engine.recover());
          } finally { engine.busy = false; }
          return;
        }
        if (name === "apply") {
          ensure(Object.keys(input).join(",") === "expectedDigest", "INVALID_UPDATE_REQUEST");
          send(res, 202, await engine.request(input.expectedDigest)); return;
        }
        throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
      }
      if (runtime.maintenance) { send(res, 503, { code: "LOCAL_UPDATE_IN_PROGRESS", message: "正在更新，请稍后重试。", updates: "/__fanjin_update/" }); return; }
      const upstream = http.request({ host: "127.0.0.1", port: config.appPort, method: req.method, path: req.url,
        headers: { ...req.headers, host: "127.0.0.1:" + config.appPort } }, response => {
        res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) send(res, 502, { code: "LOCAL_RUNTIME_UNAVAILABLE" }); else res.destroy(); });
      req.on("aborted", () => upstream.destroy()); res.on("close", () => upstream.destroy()); req.pipe(upstream);
    } catch (error) {
      const code = typeof error.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : "UPDATE_REQUEST_FAILED";
      send(res, code === "LOCAL_UPDATE_AUTH_REQUIRED" ? 401 : code === "CROSS_ORIGIN_DENIED" || code === "INVALID_HOST" ? 403 : 409, { code });
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (runtime.maintenance || req.headers.host !== "127.0.0.1:" + config.port
      || (req.headers.origin && req.headers.origin !== origin)) { socket.destroy(); return; }
    const upstream = net.connect(config.appPort, "127.0.0.1", () => {
      const headers = { ...req.headers, host: "127.0.0.1:" + config.appPort };
      upstream.write(req.method + " " + req.url + " HTTP/1.1\r\n" + Object.entries(headers).map(([k,v]) => k + ": " + v).join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
  });
  // Bind the stable port first: a second updater cannot touch the running app.
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve); });
  } catch (error) { engine.close(); owner.close(); throw error; }
  try {
    for (let attempt = 0; attempt < 65 && !await runtime.isStopped(); attempt++) await new Promise(r => setTimeout(r, 1000));
    await engine.recover();
  } catch (error) {
    engine.put("startupError", typeof error.code === "string" ? error.code : "RECOVERY_FAILED");
    // Keep the independent update UI available for inspection/recovery.
  }
  return { server, engine, runtime, async close() {
    await engine.running;
    await runtime.stop();
    await new Promise(resolve => server.close(resolve));
    engine.close();
    owner.close();
  } };
}
