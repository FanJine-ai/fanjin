import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { main, parseArgs } from "../bin/fanjin.mjs";
const resources = [];
afterEach(async () => { for (const clean of resources.splice(0)) await clean(); });
const uuid = "11111111-1111-4111-8111-111111111111";
const ok = data => ({ apiVersion: "fanjin-tools/v1", requestId: "request", ok: true, data });
const json = (res, body) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
async function start(handler) { const s = createServer(handler); await new Promise(r => s.listen(0, "127.0.0.1", r)); resources.push(() => new Promise(r => { s.close(r); s.closeAllConnections(); })); return `http://127.0.0.1:${s.address().port}`; }
async function dir() { const d = await mkdtemp(join(tmpdir(), "fanjin-cli-test-")); resources.push(() => rm(d, { recursive: true, force: true })); return d; }
async function invoke(args, url, input) { let stdout = "", stderr = ""; const code = await main(args, { FANJIN_API_URL: url, FANJIN_API_KEY: "fixture-private-test-key" }, { stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } }, stdin: input }); return { code, stdout, stderr }; }
test("proactively registers the existing asset version with its revision and idempotency key", async () => {
  const url = await start(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    assert.equal(req.url, "/api/tools/v1/fanjin_portrait_asset_register");
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { projectId: 1, assetVersionId: 12, expectedRevision: 3, idempotencyKey: "register-test-12" });
    json(res, ok({ registration: { status: "processing", pollAfterMs: 3000 } }));
  });
  const result = await invoke(["portrait", "register", "12", "--project", "1", "--revision", "3", "--key", "register-test-12"], url);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.registration.status, "processing");
  assert.throws(() => parseArgs(["portrait", "register", "12", "--project", "1"]));
});
test("maps explicit creation commands and rejects unapproved or keyless writes", () => {
  assert.equal(parseArgs(["generate", "submit", "--quote", uuid, "--approval", uuid, "--key", "submit-key"]).tool, "fanjin_generation_submit");
  assert.equal(parseArgs(["assets", "upload", "file.mp4", "--project", "1", "--key", "upload-key"]).local, "upload");
  assert.equal(parseArgs(["tasks", "wait", uuid]).local, "wait");
  assert.equal(parseArgs(["mcp", "serve"]).local, "mcp");
  assert.equal(parseArgs(["generate", "submit", "--quote", uuid, "--key", "submit-key"]).tool, "fanjin_generation_submit");
  assert.throws(() => parseArgs(["projects", "create", "--name", "new"]));
  assert.throws(() => parseArgs(["assets", "download", "1", "--output", "video.mp4"]));
  assert.throws(() => parseArgs(["generate", "submit", "--yes"]));
});
test("uploads actual file bytes, verifies digest and completes the original session", async () => {
  const folder = await dir(), file = join(folder, "sample.png"), bytes = Buffer.from("\x89PNG\r\n\x1a\nbytes", "binary"); await writeFile(file, bytes);
  const seen = [];
  const url = await start(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks); seen.push(req.url);
    assert.equal(req.headers["x-api-key"], "fixture-private-test-key");
    if (req.url.endsWith("fanjin_upload_prepare")) { const x = JSON.parse(body); assert.equal(x.contentHash, createHash("sha256").update(bytes).digest("hex")); assert.equal(x.sizeBytes, bytes.length); json(res, ok({ uploadId: uuid, uploadMethod: "PUT", uploadMode: "proxy", uploadUrl: `/api/tools/v1/uploads/${uuid}/content?projectId=1`, expiresAt: Date.now() + 60000 })); }
    else if (req.method === "PUT") { assert.deepEqual(body, bytes); res.end(); }
    else { assert.equal(JSON.parse(body).uploadId, uuid); json(res, ok({ asset: { assetId: 10, assetVersionId: 12 } })); }
  });
  const result = await invoke(["assets", "upload", file, "--project", "1", "--key", "upload-key"], url); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).data.asset.assetId, 10); assert.equal(seen.length, 4); assert.match(result.stderr, /bytesSent/); assert.doesNotMatch(result.stderr, /fixture-private-test-key/);
});
test("downloads exact file bytes with SHA-256, refuses overwrite and cleans temporary files", async () => {
  const folder = await dir(), file = join(folder, "video.mp4"), bytes = Buffer.from("video-content");
  const url = await start(async (req, res) => {
    assert.equal(req.headers["x-api-key"], "fixture-private-test-key");
    if (req.method === "POST") json(res, ok({ assetId: 10, assetVersionId: 12, sizeBytes: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex"), downloadPath: "/api/tools/v1/assets/10/versions/12/content?projectId=1" }));
    else { res.writeHead(200, { "Content-Length": bytes.length, "Content-Type": "video/mp4" }); res.end(bytes); }
  });
  const args = ["assets", "download", "10", "--project", "1", "--output", file]; const r = await invoke(args, url); assert.equal(r.code, 0, r.stderr); assert.deepEqual(await readFile(file), bytes);
  const twice = await invoke(args, url); assert.equal(twice.code, 2); assert.match(twice.stderr, /OUTPUT_EXISTS/); assert.deepEqual(await readdir(folder), ["video.mp4"]);
});
test("removes corrupt downloads and never leaves a successful output", async () => {
  const folder = await dir(), output = join(folder, "bad.png");
  const url = await start((req, res) => { if (req.method === "POST") json(res, ok({ assetId: 1, sizeBytes: 3, contentHash: "0".repeat(64), downloadPath: "/api/tools/v1/assets/1/versions/1/content?projectId=1" })); else { res.writeHead(200, { "Content-Length": 3 }); res.end("abc"); } });
  const result = await invoke(["assets", "download", "1", "--project", "1", "--output", output], url); assert.equal(result.code, 1); assert.match(result.stderr, /HASH_MISMATCH/); assert.deepEqual(await readdir(folder), []);
});
test("does not forward keys to foreign download or proxy-upload destinations", async () => {
  let foreignCalls = 0; const foreign = await start((_q, r) => { foreignCalls++; r.end(); });
  const url = await start((_q, r) => json(r, ok({ downloadPath: foreign + "/api/tools/v1/assets/1/versions/1/content" })));
  const result = await invoke(["assets", "download", "1", "--project", "1", "--output", join(await dir(), "x")], url); assert.equal(result.code, 1); assert.equal(foreignCalls, 0); assert.match(result.stderr, /UNTRUSTED_TRANSFER_URL/);
});
test("task wait respects the overall deadline and never submits another generation", async () => {
  const paths = []; const url = await start((req, res) => { paths.push(req.url); json(res, ok({ taskId: uuid, executionStatus: "running", storageStatus: "pending", pollAfterMs: 2000 })); });
  const result = await invoke(["tasks", "wait", uuid, "--wait-ms", "20"], url); assert.equal(result.code, 1); assert.match(result.stderr, /WAIT_TIMEOUT/); assert.ok(paths.every(p => p.endsWith("fanjin_task_get")));
});
test("legacy reconciliation does not stop waiting or resubmit", async () => {
  const url = await start((_q, r) => json(r, ok({ taskId: uuid, executionStatus: "needs_reconciliation", storageStatus: "pending" })));
  const result = await invoke(["tasks", "wait", uuid, "--wait-ms", "20"], url); assert.equal(result.code, 1); assert.match(result.stderr, /WAIT_TIMEOUT/);
});
test("overall wait expiration during a pending read stays resumable without resubmitting", async () => {
  const paths = []; const url = await start((req, res) => { paths.push(req.url); });
  const result = await invoke(["tasks", "wait", uuid, "--wait-ms", "50"], url);
  assert.equal(result.code, 1); assert.match(result.stderr, /WAIT_TIMEOUT/);
  assert.equal(paths.length, 1); assert.ok(paths.every(p => p.endsWith("fanjin_task_get")));
});
test("an independent request timeout remains TIMEOUT before the overall wait budget", async () => {
  const paths = []; const url = await start((req, res) => { paths.push(req.url); });
  const result = await invoke(["tasks", "wait", uuid, "--wait-ms", "5000", "--timeout-ms", "250"], url);
  assert.equal(result.code, 1); assert.match(result.stderr, /"code":"TIMEOUT"/);
  assert.equal(paths.length, 1);
});
test("loads full request JSON without accepting a hidden idempotency key", async () => {
  const file = join(await dir(), "request.json"); await writeFile(file, JSON.stringify({ prompt: "test", idempotencyKey: "hidden-key" }));
  const result = await invoke(["generate", "quote", "--input", file, "--key", "explicit-key"], "http://127.0.0.1:1"); assert.equal(result.code, 2); assert.match(result.stderr, /INVALID_ARGUMENTS/);
});
test("stdio bridge forwards initialization and calls without protocol contamination", async () => {
  const methods = [], presence = []; const url = await start(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c; const rpc = JSON.parse(raw);
    if (req.url === "/api/mcp/presence") { presence.push(rpc); assert.equal(req.headers["x-api-key"], "fixture-private-test-key"); return json(res, { ok: true }); }
    methods.push(rpc.method);
    assert.equal(req.url, "/api/mcp"); assert.equal(req.headers["x-api-key"], "fixture-private-test-key");
    if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); }
    else if (rpc.method === "initialize") json(res, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
    else { assert.equal(req.headers["mcp-protocol-version"], "2025-11-25"); res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [] } })}\n\n`); }
  });
  const messages = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }];
  const result = await invoke(["mcp", "serve"], url, Readable.from(messages.map(x => JSON.stringify(x) + "\n")));
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ""); const replies = result.stdout.trim().split("\n").map(JSON.parse); assert.deepEqual(replies.map(x => x.id), [1, 2]); assert.equal(methods.length, 3); assert.deepEqual(presence.map(x => x.action), ["heartbeat", "disconnect"]); assert.equal(presence[0].connectionId, presence[1].connectionId); assert.equal(presence[0].transport, "stdio"); assert.doesNotMatch(result.stdout, /fixture-private-test-key/);
});

test("failed MCP initialization never advertises a local connection", async () => {
  const paths = [];
  const url = await start((req, res) => { paths.push(req.url); json(res, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Denied" } }); });
  const result = await invoke(["mcp", "serve"], url, Readable.from([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n"]));
  assert.deepEqual(paths, ["/api/mcp"]); assert.equal(result.code, 0); assert.match(result.stdout, /Denied/);
});

for (const mode of ['draft', 'finalize']) test(`video ${mode} only quotes the selected stage and never submits`, async () => {
  const file = join(await dir(), 'request.json');
  const request = mode === 'finalize' ? { projectId: 1, type: 'video', draftTaskId: uuid, outputFormat: 'mov' } : { projectId: 1, type: 'video', modelId: 'doubao-seedance-2-5-260628', prompt: 'glass sphere', resolution: '480p', aspectRatio: '16:9', duration: 5 };
  await writeFile(file, JSON.stringify(request)); const paths = [];
  const url = await start(async (req, res) => { paths.push(req.url); let raw = ''; for await (const chunk of req) raw += chunk;
    assert.equal(req.url, '/api/tools/v1/fanjin_generation_quote'); assert.deepEqual(JSON.parse(raw), { request: { ...request, renderMode: mode }, idempotencyKey: `quote-${mode}-test` }); json(res, ok({ quoteId: uuid })); });
  const result = await invoke(['video', mode, '--input', file, '--key', `quote-${mode}-test`], url);
  assert.equal(result.code, 0, result.stderr); assert.equal(paths.length, 1);
});

for (const operation of ["edit", "extend"]) test(`overseas video ${operation} preserves official parameters and only quotes`, async () => {
  const file = join(await dir(), "overseas-request.json");
  const request = { projectId: 1, type: "video", modelId: "dreamina-seedance-2-5-260628", operation,
    prompt: "Use the source motion and the supplied soundtrack", aspectRatio: "adaptive", resolution: "1080p",
    duration: operation === "edit" ? -1 : 30, audio: true, outputFormat: "mov", sourceAssetVersionId: "1",
    references: [{ assetVersionId: "1", role: "source_video" }, ...Array.from({ length: 49 }, (_, i) => ({ assetVersionId: String(i + 2), role: "subject" }))] };
  await writeFile(file, JSON.stringify(request)); const paths = [];
  const url = await start(async (req, res) => { paths.push(req.url); let body = ""; for await (const chunk of req) body += chunk;
    assert.equal(req.url, "/api/tools/v1/fanjin_generation_quote");
    assert.deepEqual(JSON.parse(body).request, request); json(res, ok({ quoteId: uuid })); });
  const result = await invoke(["generate", "quote", "--input", file, "--key", `overseas-${operation}-quote`], url);
  assert.equal(result.code, 0, result.stderr); assert.equal(paths.length, 1);
});

test("document uploads preserve media type and enforce the 20 MiB ceiling before networking", async () => {
  for (const [ext, mime] of [["txt", "text/plain"], ["md", "text/markdown"], ["pdf", "application/pdf"]]) {
    const file = join(await dir(), `fixture.${ext}`), bytes = Buffer.from("synthetic document"); await writeFile(file, bytes);
    const url = await start(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
      if (req.url.endsWith("fanjin_upload_prepare")) {
        const x = JSON.parse(body); assert.equal(x.assetType, "document"); assert.equal(x.mimeType, mime);
        return json(res, ok({ uploadId: uuid, uploadMethod: "PUT", uploadMode: "proxy", uploadUrl: `/api/tools/v1/uploads/${uuid}/content?projectId=1`, expiresAt: Date.now() + 60000 }));
      }
      if (req.method === "PUT") { assert.deepEqual(body, bytes); return res.end(); }
      json(res, ok({ asset: { assetId: 10, assetVersionId: 12, type: "document" } }));
    });
    const r = await invoke(["assets", "upload", file, "--project", "1", "--key", `doc-${ext}-test`], url);
    assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).data.asset.type, "document");
  }
  const file = join(await dir(), "large.txt"); await writeFile(file, Buffer.alloc(20 * 1024 * 1024 + 1));
  let calls = 0; const url = await start((_req, res) => { calls++; res.end(); });
  const r = await invoke(["assets", "upload", file, "--project", "1", "--key", "large-doc"], url);
  assert.notEqual(r.code, 0); assert.equal(calls, 0);
});
