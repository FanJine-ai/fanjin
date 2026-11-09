import { relayMcpTool, runRelayMcp } from "./relay-mcp-tools.mjs";
import { localMediaTool, runLocalMedia } from "./local-media-tools.mjs";
import { localUploadRoots, localUploadTool, runLocalUpload } from "./local-mcp-tools.mjs";
import { open, readFile, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, resolve, dirname, join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CliError, endpoint, readJson, requestTool } from "./fanjin.mjs";
import { createMcpPresence } from "./mcp-presence.mjs";
const mimeTypes = { ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4" };
function apiKey(env) { const k = env.FANJIN_API_KEY?.trim(); if (!k || /[\r\n]/.test(k)) throw new CliError("KEY_REQUIRED", "Set FANJIN_API_KEY.", 2); return k; }
function sameOriginPath(path, env, pattern) {
  const base = endpoint(env.FANJIN_API_URL, "placeholder"), target = new URL(path, base);
  if (target.origin !== base.origin || !pattern.test(target.pathname) || target.username || target.password || target.hash) throw new CliError("UNTRUSTED_TRANSFER_URL", "Server returned an invalid transfer destination.");
  return target;
}
async function transfer(url, init, timeoutMs, consume) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetch(url, { ...init, signal: controller.signal, redirect: "error" }); if (!response.ok) { await response.body?.cancel(); throw new CliError("TRANSFER_FAILED", "File transfer failed; query the original upload or asset before retrying.", 3); } return await consume(response); }
  catch (e) { if (e instanceof CliError) throw e; throw new CliError(controller.signal.aborted ? "TIMEOUT" : "TRANSFER_FAILED", "File transfer did not complete. No automatic retry was made."); }
  finally { clearTimeout(timer); }
}
async function upload(parsed, env, io) {
  const file = await open(parsed.file, "r");
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size < 1 || stat.size > 2 * 1024 ** 3) throw new CliError("INVALID_FILE", "Select a regular file from 1 byte to 2 GiB.", 2);
    const mime = parsed.mime || mimeTypes[extname(parsed.file).toLowerCase()];
    if (!Object.values(mimeTypes).includes(mime)) throw new CliError("UNSUPPORTED_FILE", "Provide a supported image, video, audio, PDF, TXT or Markdown file.", 2);
    const document = ["application/pdf", "text/plain", "text/markdown"].includes(mime);
    if (document && stat.size > 20 * 1024 ** 2) throw new CliError("FILE_TOO_LARGE", "Documents must be at most 20 MiB.", 2);
    const hash = createHash("sha256"); for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
    const { name, ...input } = parsed.input;
    const contentHash = hash.digest("hex");
    input.idempotencyKey ||= `upload:${createHash("sha256").update(JSON.stringify([input.projectId, contentHash, basename(parsed.file), name || basename(parsed.file), mime])).digest("hex")}`;
    const prepared = await requestTool({ ...parsed, tool: "fanjin_upload_prepare", input: { ...input, fileName: basename(parsed.file), assetName: name || basename(parsed.file), assetType: document ? "document" : mime.split("/")[0], mimeType: mime, sizeBytes: stat.size, contentHash } }, env);
    const session = prepared.data;
    io.stderr.write(`${JSON.stringify({ event: "upload_prepared", uploadId: session.uploadId, projectId: input.projectId, idempotencyKey: input.idempotencyKey })}\n`);
    const status = (await requestTool({ ...parsed, tool: "fanjin_upload_get", input: { projectId: input.projectId, uploadId: session.uploadId } }, env)).data;
    if (status.assetId && status.assetVersionId) return requestTool({ ...parsed, tool: "fanjin_asset_get", input: { projectId: input.projectId, assetId: status.assetId, assetVersionId: status.assetVersionId } }, env);
    if (status.status === "uploaded") return requestTool({ ...parsed, tool: "fanjin_upload_complete", input: { projectId: input.projectId, uploadId: session.uploadId } }, env);
    let url, headers = { "Content-Type": mime, "Content-Length": String(stat.size) };
    if (session.uploadMode === "proxy") { url = sameOriginPath(session.uploadUrl, env, /^\/api\/tools\/v1\/uploads\/[0-9a-f-]+\/content$/); headers["X-API-Key"] = apiKey(env); }
    else if (session.uploadMode === "direct") {
      url = new URL(session.uploadUrl); if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new CliError("UNTRUSTED_TRANSFER_URL", "Direct upload requires HTTPS.");
      // Never forward Fanjin credentials to object storage, even if headers are suggested by a response.
    } else throw new CliError("INVALID_RESPONSE", "Unsupported upload mode.");
    if (session.uploadMethod !== "PUT" || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) throw new CliError("UPLOAD_EXPIRED", "Upload instruction is invalid or expired.", 3);
    let sent = 0, last = 0;
    const meter = new Transform({ transform(chunk, _encoding, cb) { sent += chunk.length; if (sent > stat.size) return cb(new Error("file grew")); if (Date.now() - last > 1000 || sent === stat.size) { last = Date.now(); io.stderr.write(`${JSON.stringify({ event: "upload_progress", bytesSent: sent, totalBytes: stat.size })}\n`); } cb(null, chunk); } });
    const stream = file.createReadStream({ start: 0, autoClose: false }); stream.on("error", e => meter.destroy(e)); stream.pipe(meter);
    try { await transfer(url, { method: "PUT", headers, body: meter, duplex: "half" }, parsed.timeoutMs, async response => { await response.body?.cancel(); }); }
    finally { stream.destroy(); meter.destroy(); }
    return await requestTool({ ...parsed, tool: "fanjin_upload_complete", input: { projectId: input.projectId, uploadId: session.uploadId } }, env);
  } finally { await file.close(); }
}
async function download(parsed, env) {
  const result = await requestTool(parsed, env), info = result.data;
  const url = sameOriginPath(info.downloadPath, env, /^\/api\/tools\/v1\/assets\/\d+\/versions\/\d+\/content$/);
  const destination = resolve(parsed.file), temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.part`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    let size = 0; const hash = createHash("sha256");
    await transfer(url, { headers: { "X-API-Key": apiKey(env) } }, parsed.timeoutMs, async response => {
      const declared = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(declared) || declared < 1 || declared > 5 * 1024 ** 3 || info.sizeBytes != null && declared !== info.sizeBytes || !response.body) throw new CliError("INVALID_FILE_SIZE", "Server file size did not match the asset.");
      const meter = new Transform({ transform(chunk, _encoding, cb) { size += chunk.length; if (size > declared) return cb(new Error("file too large")); hash.update(chunk); cb(null, chunk); } });
      const writer = new Writable({ write(chunk, _encoding, callback) {
        (async () => { let offset = 0; while (offset < chunk.length) { const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset); if (!bytesWritten) throw new Error("No file progress"); offset += bytesWritten; } })().then(() => callback(), callback);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, writer);
      if (size !== declared) throw new CliError("INCOMPLETE_DOWNLOAD", "Download ended before the complete file arrived.");
    });
    const contentHash = hash.digest("hex"); if (info.contentHash && contentHash !== info.contentHash) throw new CliError("HASH_MISMATCH", "Downloaded file failed SHA-256 verification.");
    await handle.sync(); await handle.close();
    try { await link(temporary, destination); } catch (e) { if (e.code === "EEXIST") throw new CliError("OUTPUT_EXISTS", "Output already exists; choose a new filename.", 2); throw e; }
    return { ...result, data: { assetId: info.assetId, assetVersionId: info.assetVersionId, file: destination, sizeBytes: size, contentHash } };
  } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
async function waitTask(parsed, env, io) {
  const deadline = Date.now() + parsed.waitMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now()), waitBound = remaining <= parsed.timeoutMs;
    let result;
    try { result = await requestTool({ ...parsed, timeoutMs: Math.min(parsed.timeoutMs, remaining) }, env); }
    catch (error) {
      // The final read may exhaust the overall wait budget inside fetch rather
      // than between polls. Report the same resumable wait outcome in both
      // cases; an independent request timeout or server error remains intact.
      if (waitBound && error instanceof CliError && error.code === "TIMEOUT" && error.exitCode === 1) break;
      throw error;
    }
    const task = result.data;
    if (task.executionStatus === "succeeded" && task.storageStatus === "ready") return result;
    if (["failed", "cancelled"].includes(task.executionStatus)) throw new CliError(task.executionStatus.toUpperCase(), "Task stopped; inspect it with tasks get. It was not resubmitted.", 3);
    io.stderr.write(`${JSON.stringify({ event: "task_progress", taskId: task.taskId, executionStatus: task.executionStatus, storageStatus: task.storageStatus })}\n`);
    const interval = Math.max(1000, Math.min(30000, Number(task.pollAfterMs) || 2000));
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
  throw new CliError("WAIT_TIMEOUT", "Task is still recorded on the server. Use tasks get or tasks wait with the same task ID.");
}
async function mcpBridge(parsed, env, io) {
  const url = endpoint(env.FANJIN_API_URL, "mcp"); url.pathname = "/api/mcp";
  const key = apiKey(env); let protocolVersion;
  for (const [parameter, variable] of [["projectId", "FANJIN_PROJECT_ID"], ["canvasId", "FANJIN_CANVAS_ID"]]) {
    if (env[variable]) {
      if (!/^[1-9]\d*$/.test(env[variable]) || !Number.isSafeInteger(Number(env[variable]))) throw new CliError("INVALID_CONTEXT", `Set a positive ${variable}.`, 2);
      url.searchParams.set(parameter, env[variable]);
    }
  }
  if (env.FANJIN_CANVAS_ID && !env.FANJIN_PROJECT_ID) throw new CliError("INVALID_CONTEXT", "FANJIN_CANVAS_ID requires FANJIN_PROJECT_ID.", 2);
  const uploadEnabled = localUploadRoots(env).length > 0;
  const presence = createMcpPresence({ url, key });
  const input = io.stdin || process.stdin;
  let closing = false;
  const onSignal = () => { closing = true; void presence.stop(); input.destroy(); };
  const ownsProcessInput = input === process.stdin;
  if (ownsProcessInput) { process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal); }
  try {
  // Bound the line before parsing; readline alone would accumulate an unbounded stdin line.
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      if (line.length > 512 * 1024) throw new CliError("PAYLOAD_TOO_LARGE", "MCP input exceeds 512 KiB.");
      if (!line.toString().trim()) continue;
      let rpc; try { rpc = JSON.parse(line); } catch { io.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }) + "\n"); continue; }
      if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") { io.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32600, message: "Invalid request" } }) + "\n"); continue; }
      try {
        if (rpc.method === "tools/call" && [localUploadTool.name, localMediaTool.name, relayMcpTool.name].includes(rpc.params?.name)) {
          let body;
          try { body = rpc.params.name === relayMcpTool.name ? await runRelayMcp(rpc.params.arguments, env) : rpc.params.name === localMediaTool.name ? await runLocalMedia(rpc.params.arguments, env) : await runLocalUpload(rpc.params.arguments, env, parsed, io, upload, requestTool); }
          catch (error) { body = { apiVersion: "fanjin-tools/v1", ok: false, error: { code: error instanceof CliError ? error.code : "LOCAL_OPERATION_FAILED", message: error instanceof CliError ? error.message : "Local operation did not finish. Inspect the result before retrying." } }; }
          if (rpc.id !== undefined) io.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: !body.ok } }) + "\n");
          continue;
        }
        const response = await transfer(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": key, ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}) }, body: JSON.stringify(rpc) }, parsed.timeoutMs, async response => {
          if (response.status === 202 || response.status === 204) return [];
          if (response.headers.get("content-type")?.includes("application/json")) return [await readJson(response)];
          const reader = response.body.getReader(); let bytes = 0, text = ""; const decoder = new TextDecoder();
          try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 512 * 1024) throw new CliError("RESPONSE_TOO_LARGE", "MCP response exceeded 512 KiB."); text += decoder.decode(next.value, { stream: true }); } text += decoder.decode(); }
          finally { await reader.cancel().catch(() => {}); }
          return text.replace(/\r\n/g, "\n").split("\n\n").filter(x => x.split("\n").some(l => l.startsWith("data:"))).map(event => JSON.parse(event.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n")));
        });
        for (const reply of response) {
          if (uploadEnabled && rpc.method === "tools/list" && Array.isArray(reply.result?.tools)
            && ["fanjin_upload_prepare", "fanjin_upload_complete", "fanjin_asset_get", "fanjin_upload_get"].every(name => reply.result.tools.some(tool => tool.name === name))) reply.result.tools.push(localUploadTool, localMediaTool);
          if (rpc.method === "tools/list" && Array.isArray(reply.result?.tools)) reply.result.tools.push(relayMcpTool);
          if (rpc.method === "initialize" && reply.result?.protocolVersion) { protocolVersion = reply.result.protocolVersion; presence.start(); }
          if (rpc.method === "server/discover" && reply.result?.supportedVersions) presence.start();
          io.stdout.write(JSON.stringify(reply) + "\n");
        }
      } catch { if (rpc.id !== undefined) io.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "Remote MCP request failed. No automatic retry was made." } }) + "\n"); }
    }
    if (buffer.length > 512 * 1024) throw new CliError("PAYLOAD_TOO_LARGE", "MCP input exceeds 512 KiB.");
  }
  if (buffer.toString().trim()) throw new CliError("INCOMPLETE_MESSAGE", "MCP input must end with a newline.");
  } catch (error) { if (!closing) throw error; }
  finally {
    if (ownsProcessInput) { process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal); }
    await presence.stop();
  }
}
export async function executeLocal(parsed, env, io) {
  if (parsed.local === "analytics-download") {
    const target = resolve(parsed.file), temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.partial`);
    const handle = await open(temporary, "wx", 0o600); let part = 0, pages = 0, rows = 0, format;
    try {
      do {
        const { data } = await requestTool({ ...parsed, input: { ...parsed.input, part } }, env);
        if (typeof data.content !== "string" || !["csv", "json"].includes(data.format) || (data.nextPart !== null && (!Number.isInteger(data.nextPart) || data.nextPart <= part))) throw new CliError("INVALID_RESPONSE", "Invalid export artifact page.");
        format ||= data.format;
        if (format !== data.format) throw new CliError("INVALID_RESPONSE", "Export format changed.");
        if (format === "json") {
          if (!pages) await handle.write("[");
          const chunk = JSON.parse(data.content); if (!Array.isArray(chunk)) throw new CliError("INVALID_RESPONSE", "Export JSON must be an array.");
          if (chunk.length) { await handle.write(`${rows ? "," : ""}${JSON.stringify(chunk).slice(1, -1)}`); rows += chunk.length; }
        } else await handle.write(data.content);
        pages++; part = data.nextPart;
      } while (part !== null);
      if (format === "json") await handle.write("]\n");
      await handle.sync(); await handle.close();
      try { await link(temporary, target); } catch (error) { if (error.code === "EEXIST") throw new CliError("FILE_EXISTS", "Choose a new output path; existing files are never overwritten.", 2); throw error; }
      return { ok: true, data: { file: target, pages, complete: true } };
    } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  }
  if (parsed.local === "analytics-export") {
    const target = resolve(parsed.file), temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.partial`);
    const handle = await open(temporary, "wx", 0o600); let pages = 0, rows = 0, cursor = parsed.input.cursor;
    const format = parsed.input.format || "csv", seen = new Set();
    try {
      if (format === "json") await handle.write("[");
      else if (format !== "csv") throw new CliError("INVALID_ARGUMENTS", "Export format must be csv or json.", 2);
      do {
        const response = await requestTool({ ...parsed, input: { ...parsed.input, limit: 100, cursor } }, env), data = response.data;
        if (typeof data.content !== "string" || !(data.nextCursor === null || typeof data.nextCursor === "string")) throw new CliError("INVALID_RESPONSE", "Export chunk is invalid.");
        if (format === "json") {
          const chunk = JSON.parse(data.content); if (!Array.isArray(chunk)) throw new CliError("INVALID_RESPONSE", "Export JSON must contain an array.");
          if (chunk.length) { await handle.write(`${rows ? "," : ""}${JSON.stringify(chunk).slice(1, -1)}`); rows += chunk.length; }
        } else await handle.write(data.content);
        pages++; cursor = data.nextCursor;
        if (cursor && seen.has(cursor)) throw new CliError("INVALID_RESPONSE", "Export cursor did not advance.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (format === "json") await handle.write("]\n");
      await handle.sync(); await handle.close();
      try { await link(temporary, target); } catch (error) { if (error.code === "EEXIST") throw new CliError("FILE_EXISTS", "Choose a new output path; existing files are never overwritten.", 2); throw error; }
      return { ok: true, data: { file: target, pages, complete: true } };
    } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  }

  if (parsed.local === "mcp") return mcpBridge(parsed, env, io);
  if (parsed.local === "upload") return upload(parsed, env, io);
  if (parsed.local === "download") return download(parsed, env);
  if (parsed.local === "wait") return waitTask(parsed, env, io);
  if (parsed.local === "input") {
    const handle = await open(parsed.file, "r"); let bytes;
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 512 * 1024) throw new CliError("INPUT_TOO_LARGE", "Input must be a JSON file up to 512 KiB.", 2); bytes = await handle.readFile(); if (bytes.length > 512 * 1024) throw new CliError("INPUT_TOO_LARGE", "Input exceeds 512 KiB.", 2); } finally { await handle.close(); }
    let input; try { input = JSON.parse(bytes); } catch { throw new CliError("INVALID_JSON", "Input file is not valid JSON.", 2); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CliError("INVALID_JSON", "Input must be a JSON object.", 2);
    if (Object.hasOwn(input, "idempotencyKey")) throw new CliError("INVALID_ARGUMENTS", "Use --key outside the input document.", 2);
    const request = parsed.tool === "fanjin_generation_quote"
      ? { ...input, ...(parsed.videoOperation ? { operation: parsed.videoOperation } : {}), ...(parsed.videoRenderMode ? { renderMode: parsed.videoRenderMode } : {}) }
      : input;
    return requestTool({
      ...parsed,
      input: parsed.tool === "fanjin_generation_quote"
        ? { request, ...parsed.input }
        : { ...input, ...parsed.input },
    }, env);
  }
  throw new CliError("INVALID_ARGUMENTS", "Unknown local operation.", 2);
}
