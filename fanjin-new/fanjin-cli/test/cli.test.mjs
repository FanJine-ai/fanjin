import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs, requestTool } from "../bin/fanjin.mjs";

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
});
async function start(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const success = (data = { workspaceId: "workspace-a" }) => ({ apiVersion: "fanjin-tools/v1", requestId: "request-a", ok: true, data });
const envFor = (url) => ({ FANJIN_API_URL: `${url}/api`, FANJIN_API_KEY: "fanjin_fixture_not_a_real_key" });
const reply = (res, body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
async function invoke(args, env) {
  let stdout = ""; let stderr = "";
  const code = await main(args, env, { stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } } });
  return { code, stdout, stderr };
}

test("maps all seven read-only commands without arbitrary tool execution", () => {
  const cases = [
    [["auth", "whoami"], "fanjin_context_get", {}],
    [["projects", "list", "--limit", "1", "--cursor", "cursor"], "fanjin_projects_list", { limit: 1, cursor: "cursor" }],
    [["projects", "get", "12"], "fanjin_project_get", { projectId: 12 }],
    [["models", "list", "--type", "video", "--available"], "fanjin_models_list", { type: "video", available: true }],
    [["models", "get", "image-a", "--type", "image"], "fanjin_model_get", { modelId: "image-a", type: "image" }],
    [["billing", "balance", "--json"], "fanjin_billing_balance", {}],
    [["canvas", "get", "--project", "1", "--canvas", "2"], "fanjin_canvas_get", { projectId: 1, canvasId: 2 }],
  ];
  for (const [args, tool, input] of cases) assert.deepEqual(parseArgs(args), { tool, input, timeoutMs: 30000 });
  assert.equal(parseArgs(["auth", "whoami", "--timeout-ms", "250"]).timeoutMs, 250);
});

test("rejects unknown, duplicate, unsafe and credential-bearing arguments", () => {
  for (const args of [
    ["generate", "video"], ["call", "fanjin_context_get"], ["auth", "whoami", "--api-key", "secret"],
    ["projects", "get", "-1"], ["projects", "get", "9007199254740992"], ["projects", "get", "1", "2"],
    ["projects", "list", "--limit", "101"], ["projects", "list", "--limit", "1.2"],
    ["projects", "list", "--limit", "1", "--limit", "2"], ["projects", "list", "--cursor"],
    ["models", "list", "--type", "text"], ["canvas", "get"],
    ["billing", "balance", "--timeout-ms", "249"], ["billing", "balance", "--timeout-ms", "120001"],
  ]) assert.throws(() => parseArgs(args), (error) => error.code === "INVALID_ARGUMENTS");
});

test("help requires neither a key nor a network request", async () => {
  const result = await invoke(["--help"], {});
  assert.equal(result.code, 0);
  assert.match(result.stdout, /creation and queries/);
  assert.match(result.stdout, /FANJIN_API_KEY/);
  assert.equal(result.stderr, "");
});

test("sends headers and exact arguments, returning machine-readable JSON only", async () => {
  let request;
  const url = await start(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    request = { method: req.method, path: req.url, key: req.headers["x-api-key"], body: JSON.parse(Buffer.concat(chunks).toString()) };
    reply(res, success({ balance: { guMicros: "1234567890", gu: "12.3456789" } }));
  });
  const result = await invoke(["billing", "balance"], envFor(url));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).data.balance.gu, "12.3456789");
  assert.deepEqual(request, { method: "POST", path: "/api/tools/v1/fanjin_billing_balance", key: envFor(url).FANJIN_API_KEY, body: {} });
  assert.ok(!result.stdout.includes(request.key));
});

test("rejects remote plaintext, embedded credentials, query secrets and incorrect API paths", async () => {
  for (const url of ["http://fanjin.top/api", "https://user:password@fanjin.top/api", "https://fanjin.top/api?key=secret", "https://fanjin.top/api#secret", "https://fanjin.top/api/tools", "not a URL"]) {
    const result = await invoke(["auth", "whoami"], { FANJIN_API_URL: url, FANJIN_API_KEY: "secret" });
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_ENDPOINT");
    assert.ok(!result.stderr.includes("secret"));
    assert.ok(!result.stderr.includes("password"));
  }
  const missing = await invoke(["auth", "whoami"], {});
  assert.equal(JSON.parse(missing.stderr).error.code, "KEY_REQUIRED");
});

test("does not forward credentials to redirects or retry the request", async () => {
  let targetHits = 0; let sourceHits = 0;
  const target = await start((_req, res) => { targetHits++; reply(res, success()); });
  const source = await start((_req, res) => { sourceHits++; res.writeHead(307, { Location: `${target}/stolen` }).end(); });
  const result = await invoke(["auth", "whoami"], envFor(source));
  assert.equal(JSON.parse(result.stderr).error.code, "NETWORK_ERROR");
  assert.equal(targetHits, 0);
  assert.equal(sourceHits, 1);
});

test("redacts authentication and upstream error bodies", async () => {
  for (const status of [401, 403, 429, 500]) {
    const url = await start((_req, res) => reply(res, { apiVersion: "fanjin-tools/v1", ok: false, error: { code: "TOOL_FAILED", message: "private-secret https://private-provider.example" } }, status));
    const result = await invoke(["auth", "whoami"], envFor(url));
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("private"));
    assert.ok(!result.stderr.includes(envFor(url).FANJIN_API_KEY));
  }
});

test("aborts a slow response without automatic retry", async () => {
  let requests = 0;
  const url = await start(() => { requests++; });
  const result = await invoke(["auth", "whoami", "--timeout-ms", "250"], envFor(url));
  assert.equal(JSON.parse(result.stderr).error.code, "TIMEOUT");
  assert.equal(requests, 1);
});

test("rejects both declared and streamed oversized bodies", async () => {
  for (const declared of [true, false]) {
    const url = await start((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", ...(declared ? { "Content-Length": 600000 } : {}) });
      res.end("x".repeat(600000));
    });
    await assert.rejects(requestTool(parseArgs(["auth", "whoami"]), envFor(url)), (error) => error.code === "RESPONSE_TOO_LARGE");
  }
});

test("rejects HTML, malformed JSON, wrong protocol and invalid tool data", async () => {
  const handlers = [
    (_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }).end("<p>private error</p>"); },
    (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }).end("not json"); },
    (_req, res) => reply(res, { ok: true, data: {} }),
    (_req, res) => reply(res, success([])),
  ];
  for (const handler of handlers) {
    const result = await invoke(["auth", "whoami"], envFor(await start(handler)));
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
    assert.ok(!result.stderr.includes("private"));
  }
});

test("the executable runs in a separate process and emits one JSON result", async () => {
  const url = await start((_req, res) => reply(res, success()));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/fanjin.mjs", import.meta.url)), "auth", "whoami"], { env: { ...process.env, ...envFor(url) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), success());
});

test("the installed command also runs through a bin symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fanjin-cli-test-"));
  try {
    const bin = join(directory, "fanjin");
    await symlink(fileURLToPath(new URL("../bin/fanjin.mjs", import.meta.url)), bin);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const packageInfo = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.ok(result.stdout.includes(`Fanjin CLI ${packageInfo.version}`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
