#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";

const API_VERSION = "fanjin-tools/v1";
const MAX_BYTES = 512 * 1024;
const CLI_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const HELP = `Fanjin CLI ${CLI_VERSION} (creation and queries, Node.js >= 22)

Commands:
  auth whoami
  projects list [--limit 20] [--cursor CURSOR]
  projects get PROJECT_ID
  models list [--type image|video] [--available] [--limit 20] [--cursor CURSOR]
  models get MODEL_ID [--type image|video]
  billing balance
  billing available
  usage export-create --key REQUEST_ID [--kind usage|ledger] [--scope workspace|account]
  usage export-jobs
  usage export-status|export-cancel JOB_ID
  usage export-download JOB_ID --output FILE
  usage summary|list|get|export [ID] [--scope workspace|account] [--from EPOCH_MS] [--to EPOCH_MS] [--model MODEL] [--project ID] [--member ID] [--key-id ID] [--source web|api|mcp|cli|unknown] [--status STATUS] [--execution-status STATUS] [--failure-category CATEGORY] [--query ID] [--limit 100] [--cursor CURSOR]
  billing ledger|entry [ID] [--scope workspace|account] [--from EPOCH_MS] [--to EPOCH_MS] [--limit 100] [--cursor CURSOR]
  account overview|balance|ledger [--from EPOCH_MS] [--to EPOCH_MS]
  usage export --output usage.csv [--format csv|json] writes all pages atomically; without --output returns one cursor chunk.
  canvas get --project PROJECT_ID [--canvas CANVAS_ID] [--include-content]

Creation commands:
  projects create --name NAME --key IDEMPOTENCY_KEY
  assets list --project ID [--type image|video|audio|text]
  assets get ID --project ID [--version ID]
  assets upload FILE --project ID --key KEY [--mime MIME] [--name NAME]
  uploads start --input metadata.json --key KEY
  uploads status UPLOAD_ID --project ID
  uploads complete UPLOAD_ID --project ID
  generate quote --input request.json --key KEY
  video extend --input request.json --key KEY
  video edit --input request.json --key KEY
  video draft --input request.json --key KEY
  video finalize --input request.json --key KEY
  approvals request QUOTE_ID --key KEY
  approvals confirm QUOTE_ID [--decision approved|rejected] --key KEY
  approvals get APPROVAL_ID
  generate submit --quote QUOTE_ID [--approval APPROVAL_ID] [--budget-gu MAX_GU] --key KEY
  tasks list --project ID
  tasks billing TASK_ID
  canvas attach --input target.json --key KEY
  canvas create-nodes --input nodes.json --key KEY
  canvas update-nodes --input changes.json --key KEY
  canvas arrange --input layout.json --key KEY
  tasks get TASK_ID
  tasks wait TASK_ID [--wait-ms 1800000]
  tasks recover --key KEY
  tasks cancel TASK_ID
  assets download ID --project ID --output FILE [--version ID]
  assets rename ID --project ID --name NAME --revision UPDATED_AT --key KEY
  portrait retry ASSET_VERSION_ID --project ID [--revision REV] --key KEY
  portrait register ASSET_VERSION_ID --project ID [--revision REV] --key KEY
  portrait declare ASSET_VERSION_ID --project ID --choice ordinary_no_person|real_person_with_rights|fully_virtual_person [--revision REV] --key KEY
  portrait authorize ASSET_VERSION_ID --project ID --label IDENTITY [--revision REV] --key KEY
  history list --project ID
  mcp serve

Options: --json (default), --timeout-ms 30000, --help
Environment: FANJIN_API_KEY, FANJIN_API_URL (default https://fanjin.top/api)
Optional: FANJIN_PROJECT_ID, FANJIN_CANVAS_ID; local bridge upload roots: FANJIN_UPLOAD_ROOTS (JSON array).
Credentials are accepted only through the environment, never command arguments.
Success is JSON on stdout. Errors are JSON on stderr with a nonzero exit code.
Generation quote + submit runs end-to-end from MCP/CLI; omit --approval for key-owner direct pass.
Writes require an explicit idempotency key; never change it after a timeout.
mcp serve bridges stdio to the same remote MCP server; logs never use stdout.
`;

export class CliError extends Error {
  constructor(code, message, exitCode = 1) { super(message); this.code = code; this.exitCode = exitCode; }
}
const invalid = () => new CliError("INVALID_ARGUMENTS", "Invalid command or option. Run fanjin --help.", 2);
const integer = (value, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw invalid();
  return Number(value);
};

export function parseArgs(args, env = {}) {
  if (!args.length || (args.length === 1 && args[0] === "--help")) return { help: true };
  const analyticsFlags = ["scope", "from", "to", "model", "project", "member", "key-id", "source", "status", "execution-status", "failure-category", "query", "limit", "cursor", "format", "kind", "output", "key"];
  const analyticsCommands = { "usage summary": "summary", "usage list": "usage", "usage get": "usage-detail", "usage export": "export", "usage export-create": "export-create", "usage export-jobs": "export-jobs", "usage export-status": "export-status", "usage export-cancel": "export-cancel", "usage export-download": "export-part", "billing available": "balance", "billing ledger": "ledger", "billing entry": "ledger-detail", "account overview": "summary", "account balance": "balance", "account ledger": "ledger" };
  const commands = {
    ...Object.fromEntries(Object.keys(analyticsCommands).map(name => [name, ["fanjin_analytics_query", analyticsFlags, ["usage get", "billing entry", "usage export-status", "usage export-cancel", "usage export-download"].includes(name) ? 1 : 0]])),
    "projects create": ["fanjin_project_create", ["name", "key"], 0],
    "assets list": ["fanjin_assets_list", ["project", "type", "limit", "cursor"], 0],
    "assets get": ["fanjin_asset_get", ["project", "version"], 1],
    "assets upload": ["fanjin_upload_prepare", ["project", "key", "mime", "name"], 1],
    "assets download": ["fanjin_asset_download", ["project", "version", "output"], 1],
    "assets rename": ["fanjin_asset_rename", ["project", "name", "revision", "key"], 1],
    "portrait retry": ["fanjin_portrait_admission_retry", ["project", "revision", "key"], 1],
    "portrait register": ["fanjin_portrait_asset_register", ["project", "revision", "key"], 1],
    "portrait declare": ["fanjin_portrait_admission_declare", ["project", "choice", "revision", "key"], 1],
    "portrait authorize": ["fanjin_portrait_admission_authorize", ["project", "label", "revision", "key"], 1],
    "uploads start": ["fanjin_upload_prepare", ["input", "key"], 0],
    "uploads status": ["fanjin_upload_get", ["project"], 1],
    "uploads complete": ["fanjin_upload_complete", ["project"], 1],
    "generate quote": ["fanjin_generation_quote", ["input", "key"], 0],
    "video extend": ["fanjin_generation_quote", ["input", "key"], 0],
    "video edit": ["fanjin_generation_quote", ["input", "key"], 0],
    "video draft": ["fanjin_generation_quote", ["input", "key"], 0],
    "video finalize": ["fanjin_generation_quote", ["input", "key"], 0],
    "approvals request": ["fanjin_approval_request", ["key"], 1],
    "approvals confirm": ["fanjin_approval_confirm", ["key", "decision"], 1],
    "approvals get": ["fanjin_approval_get", [], 1],
    "generate submit": ["fanjin_generation_submit", ["quote", "approval", "budget-gu", "key"], 0],
    "tasks get": ["fanjin_task_get", [], 1],
    "tasks billing": ["fanjin_task_billing", [], 1],
    "canvas attach": ["fanjin_canvas_attach", ["input", "key"], 0],
    "canvas create-nodes": ["fanjin_canvas_nodes_create", ["input", "key"], 0],
    "canvas update-nodes": ["fanjin_canvas_nodes_update", ["input", "key"], 0],
    "canvas arrange": ["fanjin_canvas_arrange", ["input", "key"], 0],
    "tasks wait": ["fanjin_task_get", ["wait-ms"], 1],
    "tasks recover": ["fanjin_task_recover", ["key"], 0],
    "tasks cancel": ["fanjin_task_cancel", [], 1],
    "tasks list": ["fanjin_tasks_list", ["project", "limit", "cursor"], 0],
    "history list": ["fanjin_history_list", ["project", "limit", "cursor"], 0],
    "mcp serve": ["mcp", [], 0],
    "auth whoami": ["fanjin_context_get", [], 0],
    "projects list": ["fanjin_projects_list", ["limit", "cursor"], 0],
    "projects get": ["fanjin_project_get", [], 1],
    "models list": ["fanjin_models_list", ["type", "available", "limit", "cursor"], 0],
    "models get": ["fanjin_model_get", ["type"], 1],
    "billing balance": ["fanjin_billing_balance", [], 0],
    "canvas get": ["fanjin_canvas_get", ["project", "canvas", "include-content"], 0],
  };
  const command = commands[args.slice(0, 2).join(" ")];
  if (!command) throw invalid();
  const [tool, flags, count] = command;
  const options = new Map(); const positional = [];
  for (let i = 2; i < args.length; i++) {
    const value = args[i];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const flag = value.slice(2);
    if (![...flags, "json", "timeout-ms", "help"].includes(flag) || options.has(flag)) throw invalid();
    if (["available", "include-content", "json", "help"].includes(flag)) options.set(flag, true);
    else {
      const argument = args[++i];
      if (!argument || argument.startsWith("--")) throw invalid();
      options.set(flag, argument);
    }
  }
  if (options.has("help")) return { help: true };
  if (positional.length !== count) throw invalid();
  const input = {};
  const commandName = args.slice(0, 2).join(" ");
  if (tool === "fanjin_project_get") input.projectId = integer(positional[0]);
  if (tool === "fanjin_model_get") {
    if (!positional[0] || positional[0].length > 200) throw invalid();
    input.modelId = positional[0];
  }
  for (const [flag, value] of options) {
    if (flag === "limit") input.limit = integer(value, 100);
    if (flag === "cursor") { if (value.length > 4096) throw invalid(); input.cursor = value; }
    if (flag === "type") { if (!(commandName === "assets list" ? ["image", "video", "audio", "text"] : ["image", "video"]).includes(value)) throw invalid(); input.type = value; }
    if (flag === "available") input.available = true;
    if (flag === "project") input.projectId = integer(value);
    if (flag === "canvas") input.canvasId = integer(value);
    if (flag === "include-content") input.includeContent = true;
    if (flag === "version") input.assetVersionId = integer(value);
    if (flag === "revision" && !commandName.startsWith("portrait ")) input.expectedUpdatedAt = integer(value);
    if (flag === "name") { if (value.length > 200) throw invalid(); input.name = value; }
    if (flag === "key") { if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw invalid(); input.idempotencyKey = value; }
    if (flag === "quote") input.quoteId = value;
    if (flag === "approval") input.approvalId = value;
  }
  if (tool === "fanjin_analytics_query") {
    input.action = analyticsCommands[commandName];
    input.scope = commandName.startsWith("account ") ? "account" : options.get("scope") || "workspace";
    for (const flag of ["from", "to", "member"]) if (options.has(flag)) input[flag === "member" ? "memberId" : flag] = integer(options.get(flag));
    for (const flag of ["model", "source", "status", "query", "format", "kind"]) if (options.has(flag)) input[flag] = options.get(flag);
    if (options.has("execution-status")) input.executionStatus = options.get("execution-status");
    if (options.has("failure-category")) input.failureCategory = options.get("failure-category");
    if (options.has("key-id")) input.apiKeyId = options.get("key-id");
    if (positional[0]) input.id = positional[0];
    if (!["account", "workspace"].includes(input.scope)) throw invalid();
  }
  if (tool !== "fanjin_analytics_query" && flags.includes("project") && !input.projectId && env.FANJIN_PROJECT_ID) input.projectId = integer(env.FANJIN_PROJECT_ID);
  if (tool === "fanjin_canvas_get" && !input.projectId) throw invalid();
  const timeoutMs = options.has("timeout-ms") ? integer(options.get("timeout-ms"), 120000) : 30000;
  if (timeoutMs < 250) throw invalid();
  if (commandName.startsWith("assets ") && !["assets list", "assets upload"].includes(commandName)) input.assetId = integer(positional[0]);
  if (commandName.startsWith("uploads ") && commandName !== "uploads start") input.uploadId = positional[0];
  if (["tasks get", "tasks wait", "tasks cancel", "tasks billing"].includes(commandName)) input.taskId = positional[0];
  if (options.has("budget-gu")) {
    if (!/^\d+(?:\.\d{1,8})?$/.test(options.get("budget-gu"))) throw invalid();
    input.budgetGu = options.get("budget-gu");
  }
  if (commandName === "approvals request") input.quoteId = positional[0];
  if (commandName === "approvals confirm") {
    input.quoteId = positional[0];
    input.decision = options.get("decision") || "approved";
    if (input.decision !== "approved" && input.decision !== "rejected") throw invalid();
  }
  if (commandName === "approvals get") input.approvalId = positional[0];
  if (commandName.startsWith("portrait ")) {
    input.assetVersionId = integer(positional[0]);
    if (commandName === "portrait declare") {
      const choice = options.get("choice");
      if (choice !== "real_person_with_rights" && choice !== "fully_virtual_person" && choice !== "ordinary_no_person") throw invalid();
      input.choice = choice;
      input.termsAccepted = true;
    }
    if (commandName === "portrait authorize") {
      const label = options.get("label");
      if (!label || !label.trim()) throw invalid();
      input.identityLabel = label.trim();
      input.rightsConfirmed = true;
    }
    if (options.has("revision")) input.expectedRevision = integer(options.get("revision"));
    input.idempotencyKey = options.get("key") || `portrait-${commandName.split(" ")[1]}-${positional[0]}`;
    if (!options.has("key")) throw invalid();
  }
  for (const field of ["taskId", "quoteId", "approvalId", "uploadId"]) if (input[field] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input[field])) throw invalid();
  if (tool !== "fanjin_analytics_query" && flags.includes("project") && !input.projectId) throw invalid();
  for (const required of ["key", "name", "input", "quote", "approval", "output", "revision"]) {
    if (tool !== "fanjin_analytics_query" && flags.includes(required) && !(commandName === "assets upload" && ["name", "key"].includes(required)) && !options.has(required)) {
      // portrait revision is an optional concurrency guard, not a required input
      if (required === "revision" && commandName.startsWith("portrait ")) continue;
      // generate submit auto-passes with key-owner identity when approval is omitted
      if (required === "approval" && commandName === "generate submit") continue;
      throw invalid();
    }
  }
  if (commandName === "usage export-create" && !options.has("key")) throw invalid();
  const parsed = { tool, input, timeoutMs };
  if (commandName === "usage export-download") { if (!options.has("output")) throw invalid(); return { ...parsed, local: "analytics-download", file: options.get("output") }; }
  if (tool === "fanjin_analytics_query" && options.has("output")) { if (commandName !== "usage export") throw invalid(); return { ...parsed, local: "analytics-export", file: options.get("output") }; }
  if (commandName === "assets upload") return { ...parsed, local: "upload", file: positional[0], mime: options.get("mime") };
  if (commandName === "assets download") return { ...parsed, local: "download", file: options.get("output") };
  if (commandName === "tasks wait") return { ...parsed, local: "wait", waitMs: options.has("wait-ms") ? integer(options.get("wait-ms"), 86400000) : 1800000 };
  if (commandName === "mcp serve") return { ...parsed, local: "mcp" };
  if (options.has("input")) {
    const videoOperation = commandName === "video extend" ? "extend" : commandName === "video edit" ? "edit" : undefined;
    return { ...parsed, local: "input", file: options.get("input"), videoOperation, videoRenderMode: commandName === "video draft" ? "draft" : commandName === "video finalize" ? "finalize" : undefined };
  }
  return parsed;
}

export function endpoint(raw, tool) {
  let url;
  try { url = new URL(raw || "https://fanjin.top/api"); } catch { throw new CliError("INVALID_ENDPOINT", "FANJIN_API_URL must be an HTTPS API URL.", 2); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new CliError("INVALID_ENDPOINT", "Use HTTPS (HTTP is allowed only on loopback), without credentials or query parameters.", 2);
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path && path !== "/api") throw new CliError("INVALID_ENDPOINT", "FANJIN_API_URL must end at /api or the site root.", 2);
  url.pathname = `/api/tools/v1/${tool}`;
  return url;
}

export async function readJson(response) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    await response.body?.cancel();
    throw new CliError("INVALID_RESPONSE", "The server did not return tool JSON. Check the server version and API URL.");
  }
  if (Number(response.headers.get("content-length") || 0) > MAX_BYTES) {
    await response.body?.cancel();
    throw new CliError("RESPONSE_TOO_LARGE", "Tool response exceeds 512 KiB.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CliError("INVALID_RESPONSE", "The server returned an empty response.");
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new CliError("RESPONSE_TOO_LARGE", "Tool response exceeds 512 KiB.");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new CliError("INVALID_RESPONSE", "The server returned invalid JSON."); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function requestTool(parsed, env = process.env) {
  const url = endpoint(env.FANJIN_API_URL, parsed.tool);
  for (const [parameter, variable] of [["projectId", "FANJIN_PROJECT_ID"], ["canvasId", "FANJIN_CANVAS_ID"]]) {
    if (env[variable]) {
      if (!/^[1-9]\d*$/.test(env[variable]) || !Number.isSafeInteger(Number(env[variable]))) throw new CliError("INVALID_CONTEXT", `Set a positive ${variable}.`, 2);
      url.searchParams.set(parameter, env[variable]);
    }
  }
  const key = env.FANJIN_API_KEY?.trim();
  if (!key || /[\r\n]/.test(key)) throw new CliError("KEY_REQUIRED", "Set FANJIN_API_KEY to a workspace API key.", 2);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), parsed.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal: abort.signal,
      headers: { "User-Agent": "fanjin-cli/0.3.2", "Content-Type": "application/json", Accept: "application/json", "X-API-Key": key },
      body: JSON.stringify(parsed.input),
    });
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      throw new CliError("ACCESS_DENIED", "Check the API key, workspace membership and tool permissions.", 3);
    }
    if (response.status === 429) { await response.body?.cancel(); throw new CliError("RATE_LIMITED", "Rate limit reached. Retry later.", 3); }
    const body = await readJson(response);
    if (body?.apiVersion !== API_VERSION || typeof body.ok !== "boolean") throw new CliError("INVALID_RESPONSE", "The server does not expose a compatible Fanjin tool API.");
    if (!response.ok || !body.ok) {
      const code = typeof body.error?.code === "string" && /^[A-Z_]{1,64}$/.test(body.error.code) ? body.error.code : "TOOL_FAILED";
      // Do not echo an upstream error body, which can contain URLs or credentials.
      const fields = Array.isArray(body.error?.details?.fields) ? body.error.details.fields
        .map(f => f.field).filter(f => typeof f === "string" && /^[A-Za-z0-9_.-]{1,160}$/.test(f)).slice(0, 8) : [];
      throw new CliError(code, fields.length ? `Check these fields: ${fields.join(", ")}.` : "The tool could not complete this operation. Check its scope and parameters.", 3);
    }
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new CliError("INVALID_RESPONSE", "The server returned invalid tool data.");
    return body;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(abort.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR", abort.signal.aborted ? "Tool request timed out; no automatic retry was made." : "Unable to reach the API. Redirects are not followed.");
  } finally { clearTimeout(timer); }
}

export async function main(args = process.argv.slice(2), env = process.env, io = process) {
  try {
    const parsed = parseArgs(args, env);
    if (parsed.help) io.stdout.write(HELP);
    else {
      const result = parsed.local ? await (await import("./operations.mjs")).executeLocal(parsed, env, io) : await requestTool(parsed, env);
      if (result !== undefined) io.stdout.write(`${JSON.stringify(result)}\n`);
    }
    return 0;
  } catch (error) {
    const safe = error instanceof CliError ? error : new CliError("INTERNAL_ERROR", "CLI request failed.");
    io.stderr.write(`${JSON.stringify({ ok: false, error: { code: safe.code, message: safe.message } })}\n`);
    return safe.exitCode;
  }
}

function isEntrypoint(path) {
  try { return Boolean(path) && import.meta.url === pathToFileURL(realpathSync(path)).href; }
  catch { return false; }
}

// Finish module evaluation before operations.mjs imports these shared helpers.
// Awaiting main here deadlocks that circular import for every local command.
if (isEntrypoint(process.argv[1])) void main().then(code => { process.exitCode = code; });
