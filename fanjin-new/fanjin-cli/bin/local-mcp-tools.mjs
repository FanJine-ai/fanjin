import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { CliError } from "./fanjin.mjs";
const usages = ["role", "scene", "tool", "action", "audio", "camera", "style", "composition", "other"];

export function localUploadRoots(env) {
  if (!env.FANJIN_UPLOAD_ROOTS) return [];
  let roots;
  try { roots = JSON.parse(env.FANJIN_UPLOAD_ROOTS); } catch { /* validated below */ }
  if (!Array.isArray(roots) || !roots.length || roots.some(root => typeof root !== "string" || !isAbsolute(root))) {
    throw new CliError("INVALID_UPLOAD_ROOTS", "FANJIN_UPLOAD_ROOTS must be a JSON array of absolute media directories.", 2);
  }
  return roots;
}

export const localUploadTool = {
  name: "fanjin_local_upload", title: "一键上传本地素材",
  description: "仅本地桥接可用。传入允许目录中的图片、视频、音频或 PDF/TXT/Markdown 文档路径（文档最大 20MB），自动计算校验值、上传并入库，返回可复用的资产版本；同一项目同文件和名称使用稳定请求键。远程服务不会读取本机路径。不生成、不扣生成费。",
  inputSchema: { type: "object", additionalProperties: false, required: ["file"], properties: {
    file: { type: "string", description: "允许素材目录中的绝对路径" }, projectId: { type: "integer", minimum: 1 },
    name: { type: "string", maxLength: 255 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
    usage: { enum: usages, description: "上传后设置素材用途；不会据此声明真人或虚构人物" },
  } },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export async function runLocalUpload(args, env, parsed, io, upload, classify) {
  if (!args || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).some(k => !["file", "projectId", "name", "idempotencyKey", "usage"].includes(k))
    || args.usage !== undefined && !usages.includes(args.usage)
    || typeof args.file !== "string" || !isAbsolute(args.file)
    || args.name !== undefined && (typeof args.name !== "string" || !args.name.trim() || args.name.length > 255)
    || args.idempotencyKey !== undefined && (typeof args.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(args.idempotencyKey))) throw new CliError("INVALID_ARGUMENTS", "Provide an absolute media file path and valid upload options.", 2);
  const roots = localUploadRoots(env);
  if (!roots.length) throw new CliError("LOCAL_UPLOAD_DISABLED", "Configure allowed media directories with FANJIN_UPLOAD_ROOTS.", 2);
  const path = await realpath(args.file);
  const allowed = await Promise.all(roots.map(async root => {
    const rel = relative(await realpath(root), path);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }));
  if (!allowed.some(Boolean)) throw new CliError("FILE_OUTSIDE_UPLOAD_ROOTS", "Select a file inside an allowed media directory.", 2);
  const projectId = args.projectId ?? Number(env.FANJIN_PROJECT_ID);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new CliError("PROJECT_REQUIRED", "Select a projectId or configure FANJIN_PROJECT_ID.", 2);
  const result = await upload({ ...parsed, file: path, input: { projectId, ...(args.name ? { name: args.name } : {}), ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}) } }, env, io);
  const asset = result.data?.asset ?? result.data;
  if (args.usage && result.ok && asset?.assetId) {
    // An interrupted classification must not turn a successful upload into a
    // failed upload or encourage another copy of the media.
    try {
      const classified = await classify?.({ ...parsed, tool: "fanjin_studio_execute", input: { operation: "assets.classify", parameters: { projectId, id: asset.assetId, usage: args.usage } } }, env);
      result.data.classification = classified?.ok ? { status: "saved", usage: args.usage } : { status: "pending", usage: args.usage, nextOperation: "assets.classify" };
    } catch { result.data.classification = { status: "pending", usage: args.usage, nextOperation: "assets.classify" }; }
  }
  return result;
}
