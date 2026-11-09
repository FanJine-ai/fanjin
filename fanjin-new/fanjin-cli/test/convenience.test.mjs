import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main, parseArgs } from "../bin/fanjin.mjs";
import { runLocalUpload, localUploadRoots } from "../bin/local-mcp-tools.mjs";
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function folder() { const dir = await mkdtemp(join(tmpdir(), "mcp-convenience-")); cleanup.push(() => rm(dir, { force: true, recursive: true })); return dir; }
const uuid = "11111111-1111-4111-8111-111111111111";
const ok = data => ({ apiVersion: "fanjin-tools/v1", ok: true, data });
const json = (res, body) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
async function start(handler) { const server = createServer(handler); await new Promise(r => server.listen(0, "127.0.0.1", r)); cleanup.push(() => new Promise(r => { server.close(r); server.closeAllConnections(); })); return `http://127.0.0.1:${server.address().port}`; }
async function invoke(args, env, messages) {
  let stdout = "", stderr = "";
  const code = await main(args, env, { stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } }, stdin: Readable.from(messages?.map(x => JSON.stringify(x) + "\n") || []) });
  return { code, stdout, stderr };
}
test("project binding is optional but explicit, and budget/tasks billing map to their contracts", () => {
  assert.deepEqual(parseArgs(["canvas", "get"], { FANJIN_PROJECT_ID: "7" }).input, { projectId: 7 });
  assert.equal(parseArgs(["assets", "list", "--project", "2"], { FANJIN_PROJECT_ID: "7" }).input.projectId, 2);
  assert.equal(parseArgs(["tasks", "billing", uuid]).tool, "fanjin_task_billing");
  assert.equal(parseArgs(["generate", "submit", "--quote", uuid, "--key", "submit-key", "--budget-gu", "5.12"]).input.budgetGu, "5.12");
  assert.throws(() => parseArgs(["assets", "list"], { FANJIN_PROJECT_ID: "invalid" }));
});
test("local upload is opt-in, limited to allowed directories including resolved symlinks", async () => {
  const allowed = await folder(), outside = await folder();
  const file = join(outside, "private.png"); await writeFile(file, "test"); await symlink(file, join(allowed, "escape.png"));
  const env = { FANJIN_UPLOAD_ROOTS: JSON.stringify([allowed]), FANJIN_PROJECT_ID: "1" };
  const upload = () => { throw new Error("must never upload"); };
  assert.deepEqual(localUploadRoots({}), []);
  await assert.rejects(runLocalUpload({ file }, {}, {}, {}, upload), { code: "LOCAL_UPLOAD_DISABLED" });
  await assert.rejects(runLocalUpload({ file: join(allowed, "escape.png") }, env, {}, {}, upload), { code: "FILE_OUTSIDE_UPLOAD_ROOTS" });
  await assert.rejects(runLocalUpload({ file: "relative.png" }, env, {}, {}, upload), { code: "INVALID_ARGUMENTS" });
});
test("upload classification failure preserves the saved asset and reports a precise next operation", async () => {
  const dir = await folder(), file = join(dir, "role.png"); await writeFile(file, "synthetic");
  const env = { FANJIN_UPLOAD_ROOTS: JSON.stringify([dir]), FANJIN_PROJECT_ID: "1" };
  const result = await runLocalUpload({ file, usage: "role" }, env, {}, {}, async () => ok({ assetId: 12, assetVersionId: 23 }), async request => {
    assert.deepEqual(request.input, { operation: "assets.classify", parameters: { projectId: 1, id: 12, usage: "role" } });
    throw new Error("temporary unavailable");
  });
  assert.equal(result.ok, true); assert.equal(result.data.assetVersionId, 23);
  assert.deepEqual(result.data.classification, { status: "pending", usage: "role", nextOperation: "assets.classify" });
});
test("classification accepts the canonical nested asset from completed and reused uploads", async () => {
  const dir = await folder(), file = join(dir, "scene.png"); await writeFile(file, "synthetic");
  const env = { FANJIN_UPLOAD_ROOTS: JSON.stringify([dir]), FANJIN_PROJECT_ID: "1" };
  const asset = { assetId: 12, assetVersionId: 23 };
  for (const succeeded of [true, false]) {
    const result = await runLocalUpload({ file, usage: "scene" }, env, {}, {}, async () => ok({ asset }), async request => {
      assert.deepEqual(request.input, { operation: "assets.classify", parameters: { projectId: 1, id: 12, usage: "scene" } });
      return { ok: succeeded };
    });
    assert.deepEqual(result.data.asset, asset);
    assert.equal(result.data.classification.status, succeeded ? "saved" : "pending");
  }
});
test("one MCP local upload sends bytes once then reuses the original completed upload, without forwarding local paths", async () => {
  const dir = await folder(), file = join(dir, "scene.png"), bytes = Buffer.from("\x89PNG\r\n\x1a\nfixture", "binary"); await writeFile(file, bytes);
  let uploads = 0, complete = false; const keys = [], forwarded = [];
  const url = await start(async (req, res) => {
    let chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
    const name = new URL(req.url, "http://localhost").pathname;
    if (req.method === "PUT") { uploads++; assert.deepEqual(body, bytes); return res.end(); }
    forwarded.push(body.toString()); const input = JSON.parse(body);
    if (name === "/api/mcp") return json(res, { jsonrpc: "2.0", id: input.id, result: { tools: ["fanjin_upload_prepare", "fanjin_upload_get", "fanjin_upload_complete", "fanjin_asset_get"].map(name => ({ name })) } });
    if (name.endsWith("fanjin_upload_prepare")) {
      assert.equal(input.projectId, 7); keys.push(input.idempotencyKey);
      return json(res, ok({ uploadId: uuid, uploadMode: "proxy", uploadMethod: "PUT", uploadUrl: `/api/tools/v1/uploads/${uuid}/content?projectId=7`, expiresAt: Date.now() + 60000 }));
    }
    if (name.endsWith("fanjin_upload_get")) return json(res, ok(complete ? { status: "completed", assetId: 1, assetVersionId: 2 } : { status: "prepared" }));
    if (name.endsWith("fanjin_upload_complete")) complete = true;
    return json(res, ok({ assetId: 1, assetVersionId: 2 }));
  });
  const env = { FANJIN_API_URL: url, FANJIN_API_KEY: "private-key", FANJIN_PROJECT_ID: "7", FANJIN_UPLOAD_ROOTS: JSON.stringify([dir]) };
  const call = id => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "fanjin_local_upload", arguments: { file } } });
  const result = await invoke(["mcp", "serve"], env, [{ jsonrpc: "2.0", id: 0, method: "tools/list" }, call(1), call(2)]);
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map(x => JSON.parse(x));
  for (const name of ["fanjin_local_upload", "fanjin_local_media_edit", "fanjin_relay_request"]) assert.ok(replies[0].result.tools.some(tool => tool.name === name));
  for (const reply of replies.slice(1)) { assert.equal(reply.result.isError, false, JSON.stringify(reply)); assert.equal(reply.result.structuredContent.data.assetVersionId, 2); }
  assert.equal(uploads, 1); assert.equal(keys[0], keys[1]); assert.ok(keys[0].startsWith("upload:"));
  assert.ok(forwarded.every(body => !body.includes(dir))); assert.doesNotMatch(result.stdout + result.stderr, /private-key/);
});
