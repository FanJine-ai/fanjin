import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runLocalMedia, mediaCommands } from "../bin/local-media-tools.mjs";
import { runRelayMcp } from "../bin/relay-mcp-tools.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "fanjin-media-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, env: { FANJIN_UPLOAD_ROOTS: JSON.stringify([dir]), FANJIN_API_URL: "http://127.0.0.1:10592", FANJIN_API_KEY: "fixture-test-key" } };
}
test("media actions reject injected filters, mixed arguments and escaping symlinks", async t => {
  const { dir, env } = await fixture(t), outside = await fixture(t);
  assert.throws(() => mediaCommands({ file: "/x.png", action: "crop", x: "1;movie=/secret", y: 0, width: 10, height: 10 }, dir));
  assert.throws(() => mediaCommands({ file: "/x.png", action: "flip", direction: "horizontal", times: [0] }, dir));
  await writeFile(join(outside.dir, "secret.png"), "secret");
  await symlink(join(outside.dir, "secret.png"), join(dir, "escape.png"));
  await assert.rejects(runLocalMedia({ file: join(dir, "escape.png"), action: "flip", direction: "horizontal" }, env), { code: "FILE_OUTSIDE_UPLOAD_ROOTS" });
});
test("real ffmpeg crop, rotate, split and extraction preserve input and produce reusable files", async t => {
  const { dir, env } = await fixture(t), image = join(dir, "image.png"), video = join(dir, "video.mp4");
  // Synthetic sources only; this test never uses a model or network service.
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:d=1", "-frames:v", "1", image]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  const before = await readFile(image);
  for (const args of [
    { file: image, action: "crop", x: 0, y: 0, width: 32, height: 24 },
    { file: image, action: "rotate", degrees: 90 },
    { file: image, action: "flip", direction: "vertical" },
    { file: image, action: "grid_split", rows: 2, columns: 2 },
    { file: video, action: "extract_frames", times: [0, 0.5] },
  ]) {
    const result = await runLocalMedia(args, env);
    assert.equal(result.data.generationSubmitted, false);
    assert.equal(result.data.outputs.length, args.action === "grid_split" ? 4 : args.action === "extract_frames" ? 2 : 1);
    for (const output of result.data.outputs) assert.equal((await readFile(output.file)).subarray(1, 4).toString(), "PNG");
  }
  assert.deepEqual(await readFile(image), before);
});
test("transcription uses real multipart fields and validates media scope before networking", async t => {
  const { dir, env } = await fixture(t), file = join(dir, "voice.wav"); await writeFile(file, "synthetic audio");
  let calls = 0;
  const result = await runRelayMcp({ action: "transcription", file, body: { model: "whisper-fixture", language: "zh" }, idempotencyKey: "audio-123" }, env, async (url, init) => {
    calls++;
    assert.equal(url.pathname, "/v1/audio/transcriptions");
    assert.equal(init.headers["Content-Type"], undefined);
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get("file").name, "voice.wav");
    assert.equal(await init.body.get("file").text(), "synthetic audio");
    assert.equal(init.body.get("model"), "whisper-fixture");
    return Response.json({ text: "合成文字" });
  });
  assert.equal(result.data.response.text, "合成文字");
  assert.equal(calls, 1);
  await assert.rejects(runRelayMcp({ action: "transcription", file, body: { model: "x", response_format: "srt" }, idempotencyKey: "audio-123" }, env, () => { throw new Error("unexpected network"); }), { code: "INVALID_AUDIO_FILE" });
});
test("relay preserves compatible request fields, stores speech and never retries uncertain responses", async t => {
  const { dir, env } = await fixture(t);
  const body = { model: "fixture", messages: [{ role: "user", content: "synthetic" }], temperature: 0.4 };
  await runRelayMcp({ action: "chat", body, idempotencyKey: "chat-1234" }, env, async (url, init) => {
    assert.equal(url.pathname, "/v1/chat/completions"); assert.deepEqual(JSON.parse(init.body), body); return Response.json({ choices: [] });
  });
  const speech = await runRelayMcp({ action: "speech", body: { model: "fixture", input: "hello" }, outputDirectory: dir, idempotencyKey: "voice-1234" }, env,
    async () => new Response("audio-fixture", { headers: { "content-type": "audio/mpeg" } }));
  assert.equal(await readFile(speech.data.file, "utf8"), "audio-fixture");
  let calls = 0;
  await assert.rejects(runRelayMcp({ action: "chat", body, idempotencyKey: "chat-1234" }, env, async () => { calls++; throw new Error("uncertain response"); }));
  assert.equal(calls, 1);
});
