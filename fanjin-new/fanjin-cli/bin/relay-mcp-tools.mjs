import { mkdtemp, realpath, open, unlink, stat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep, basename } from "node:path";
import { endpoint, CliError, readJson } from "./fanjin.mjs";
import { localUploadRoots } from "./local-mcp-tools.mjs";
const paths = { chat: "/v1/chat/completions", responses: "/v1/responses", embeddings: "/v1/embeddings", rerank: "/v1/rerank", speech: "/v1/audio/speech", transcription: "/v1/audio/transcriptions" };
export const relayMcpTool = {
  name: "fanjin_relay_request", title: "调用 API 中转模型",
  description: "调用与网页 API 测试台相同的官方格式接口，使用当前密钥的真实权限、限额与模型范围。可能产生模型费用，不会自动重试。action 可选 chat/responses/embeddings/rerank/speech/transcription，body 保留兼容接口原字段，禁止 stream=true；speech 必须指定允许素材目录内的 outputDirectory，返回音频文件供上传入库。",
  inputSchema: { type: "object", additionalProperties: false, required: ["action", "body", "idempotencyKey"], properties: {
    action: { enum: Object.keys(paths) }, body: { type: "object", additionalProperties: true },
    idempotencyKey: { type: "string", minLength: 8, maxLength: 128 }, outputDirectory: { type: "string" }, file: { type: "string", description: "transcription 专用：允许素材目录内的绝对路径，最大 25 MiB；body.response_format 使用 json 或 verbose_json" },
  } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};
export async function runRelayMcp(args, env, fetcher = fetch) {
  if (!args || typeof args !== "object" || Object.keys(args).some(k => !["action", "body", "idempotencyKey", "outputDirectory", "file"].includes(k))
    || !Object.hasOwn(paths, args.action) || !args.body || typeof args.body !== "object" || Array.isArray(args.body)
    || args.body.stream === true || typeof args.body.model !== "string" || !args.body.model.trim()
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(args.idempotencyKey || "")) throw new CliError("INVALID_ARGUMENTS", "Provide a supported action, non-streaming model request and an idempotency key.", 2);
  let body = JSON.stringify(args.body);
  if (Buffer.byteLength(body) > 512 * 1024) throw new CliError("PAYLOAD_TOO_LARGE", "Use asset URLs for large media references.", 2);
  if (args.action === "transcription") {
    if (typeof args.file !== "string" || !isAbsolute(args.file) || "file" in args.body || ![undefined, "json", "verbose_json"].includes(args.body.response_format)) throw new CliError("INVALID_AUDIO_FILE", "Provide a local audio file and a JSON transcription format.", 2);
    const file = await realpath(args.file);
    const allowed = await Promise.all(localUploadRoots(env).map(async root => { const rel = relative(await realpath(root), file); return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }));
    const info = await stat(file);
    if (!allowed.some(Boolean)) throw new CliError("FILE_OUTSIDE_UPLOAD_ROOTS", "Choose a file inside an allowed media directory.", 2);
    if (!info.isFile() || info.size < 1 || info.size > 25 * 1024 ** 2) throw new CliError("INVALID_AUDIO_FILE", "Audio must be a regular file up to 25 MiB.", 2);
    body = new FormData();
    for (const [name, value] of Object.entries(args.body)) {
      if (!["string", "number", "boolean"].includes(typeof value)) throw new CliError("INVALID_ARGUMENTS", "Transcription fields must be simple values.", 2);
      body.set(name, String(value));
    }
    body.set("file", new Blob([await readFile(file)]), basename(file));
  } else if (args.file !== undefined) throw new CliError("INVALID_ARGUMENTS", "file is only used for transcription.", 2);
  const key = env.FANJIN_API_KEY?.trim(); if (!key || /[\r\n]/.test(key)) throw new CliError("KEY_REQUIRED", "Configure the Fanjin API key.", 2);
  const url = endpoint(env.FANJIN_API_URL, "placeholder"); url.pathname = paths[args.action]; url.search = "";
  let output;
  if (args.action === "speech") {
    if (typeof args.outputDirectory !== "string" || !isAbsolute(args.outputDirectory)) throw new CliError("OUTPUT_DIRECTORY_REQUIRED", "Choose an allowed local media directory for the audio.", 2);
    const directory = await realpath(args.outputDirectory);
    const allowed = await Promise.all(localUploadRoots(env).map(async root => { const rel = relative(await realpath(root), directory); return !rel || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }));
    if (!allowed.some(Boolean)) throw new CliError("FILE_OUTSIDE_UPLOAD_ROOTS", "Choose an allowed local media directory.", 2);
    const format = args.body.response_format || "mp3";
    if (!["mp3", "opus", "aac", "flac", "wav"].includes(format)) throw new CliError("INVALID_AUDIO_FORMAT", "Choose a supported speech format.", 2);
    output = join(await mkdtemp(join(directory, "fanjin-speech-")), `speech.${format}`);
  } else if (args.outputDirectory !== undefined) throw new CliError("INVALID_ARGUMENTS", "outputDirectory is only used for speech.", 2);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetcher(url, { method: "POST", redirect: "error", signal: controller.signal,
      headers: { ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }), "X-API-Key": key, "Idempotency-Key": args.idempotencyKey }, body });
    if (!response.ok) { await response.body?.cancel(); throw new CliError("RELAY_REQUEST_FAILED", `The relay returned HTTP ${response.status}. Inspect developer.logs with the same request key before retrying.`, 3); }
    if (!output) return { apiVersion: "fanjin-tools/v1", ok: true, data: { action: args.action, response: await readJson(response) } };
    if (!response.body || !response.headers.get("content-type")?.startsWith("audio/")) throw new CliError("INVALID_AUDIO_RESPONSE", "The relay did not return audio.", 3);
    const handle = await open(output, "wx", 0o600); let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw new CliError("RESPONSE_TOO_LARGE", "Audio exceeds the 64 MiB limit.", 3);
        let offset = 0; while (offset < chunk.length) { const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset); if (!bytesWritten) throw new Error("No file progress"); offset += bytesWritten; }
      }
      if (!bytes) throw new CliError("EMPTY_AUDIO", "The relay returned empty audio.", 3);
      await handle.sync();
      return { apiVersion: "fanjin-tools/v1", ok: true, data: { file: output, sizeBytes: bytes, nextTool: "fanjin_local_upload" } };
    } catch (error) { await unlink(output).catch(() => {}); throw error; }
    finally { await handle.close(); }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("RELAY_RESULT_UNKNOWN", "The request did not return. Query developer.logs before retrying; no automatic retry was made.", 3);
  } finally { clearTimeout(timer); }
}
