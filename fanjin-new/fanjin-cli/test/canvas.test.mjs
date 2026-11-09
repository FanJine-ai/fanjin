import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { main } from "../bin/fanjin.mjs";

test("canvas commands preserve scoped request, revision and idempotency without generating", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fanjin-canvas-test-")), requests = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    requests.push({ url: req.url, input: JSON.parse(text) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ apiVersion: "fanjin-tools/v1", ok: true, data: { revision: 2, generationSubmitted: false } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [command, tool, fields] of [
      ["create-nodes", "fanjin_canvas_nodes_create", { nodes: [{ type: "video", prompt: "test" }] }],
      ["update-nodes", "fanjin_canvas_nodes_update", { updates: [{ nodeId: "n1", prompt: "updated" }] }],
      ["arrange", "fanjin_canvas_arrange", { nodeIds: ["n1"], mode: "grid" }],
    ]) {
      const file = join(dir, command + ".json");
      const input = { projectId: 1, canvasId: 2, expectedRevision: 1, ...fields };
      await writeFile(file, JSON.stringify(input));
      let stdout = "", stderr = "";
      const code = await main(["canvas", command, "--input", file, "--key", "canvas-test-key"], {
        FANJIN_API_URL: `http://127.0.0.1:${server.address().port}`, FANJIN_API_KEY: "test-only",
      }, { stdout: { write: s => stdout += s }, stderr: { write: s => stderr += s } });
      assert.equal(code, 0, stderr);
      assert.equal(JSON.parse(stdout).data.generationSubmitted, false);
      assert.deepEqual(requests.at(-1), { url: `/api/tools/v1/${tool}`, input: { ...input, idempotencyKey: "canvas-test-key" } });
    }
    assert.equal(requests.length, 3);
    const code = await main(["canvas", "get", "--project", "1", "--canvas", "2", "--include-content"], {
      FANJIN_API_URL: `http://127.0.0.1:${server.address().port}`, FANJIN_API_KEY: "test-only",
    }, { stdout: { write() {} }, stderr: { write() {} } });
    assert.equal(code, 0);
    assert.deepEqual(requests.at(-1), { url: "/api/tools/v1/fanjin_canvas_get", input: { projectId: 1, canvasId: 2, includeContent: true } });
  } finally {
    await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
