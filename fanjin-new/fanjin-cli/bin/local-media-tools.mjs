import { spawn } from "node:child_process";
import { mkdtemp, realpath, stat, chmod } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { CliError } from "./fanjin.mjs";
import { localUploadRoots } from "./local-mcp-tools.mjs";

export const localMediaTool = {
  name: "fanjin_local_media_edit", title: "裁剪、旋转、翻转、拆图与视频抽帧",
  description: "在允许的本地素材目录生成新文件，保留原片。不调用生成模型。action=crop 时提供 x/y/width/height；rotate 提供 90/180/270；flip 提供 horizontal/vertical；grid_split 提供 rows/columns；extract_frames 提供秒数 times。结果可用 fanjin_local_upload 入库。",
  inputSchema: { type: "object", additionalProperties: false, required: ["file", "action"], properties: {
    file: { type: "string" }, action: { enum: ["crop", "rotate", "flip", "grid_split", "extract_frames"] },
    x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 },
    width: { type: "integer", minimum: 1, maximum: 16384 }, height: { type: "integer", minimum: 1, maximum: 16384 },
    degrees: { enum: [90, 180, 270] }, direction: { enum: ["horizontal", "vertical"] },
    rows: { type: "integer", minimum: 1, maximum: 4 }, columns: { type: "integer", minimum: 1, maximum: 4 },
    times: { type: "array", minItems: 1, maxItems: 16, items: { type: "number", minimum: 0, maximum: 21600 } },
  } },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
const invalid = () => { throw new CliError("INVALID_ARGUMENTS", "Provide the fields required by the chosen media action.", 2); };
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
export function mediaCommands(args, outputDir) {
  if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.file !== "string" || !isAbsolute(args.file)) invalid();
  const fields = { crop: ["x", "y", "width", "height"], rotate: ["degrees"], flip: ["direction"], grid_split: ["rows", "columns"], extract_frames: ["times"] };
  if (!fields[args.action] || Object.keys(args).some(k => !["file", "action", ...fields[args.action]].includes(k))) invalid();
  const video = [".mp4", ".mov", ".webm"].includes(extname(args.file).toLowerCase());
  if (!video && ![".png", ".jpg", ".jpeg", ".webp"].includes(extname(args.file).toLowerCase())) invalid();
  if (args.action === "grid_split" && video || args.action === "extract_frames" && !video) invalid();
  let filters = [], times;
  if (args.action === "crop") {
    if (!integer(args.x, 0, 16384) || !integer(args.y, 0, 16384) || !integer(args.width, 1, 16384) || !integer(args.height, 1, 16384)) invalid();
    filters = [`crop=${args.width}:${args.height}:${args.x}:${args.y}`];
  } else if (args.action === "rotate") {
    if (![90, 180, 270].includes(args.degrees)) invalid();
    filters = [args.degrees === 90 ? "transpose=1" : args.degrees === 270 ? "transpose=2" : "hflip,vflip"];
  } else if (args.action === "flip") {
    if (!["horizontal", "vertical"].includes(args.direction)) invalid();
    filters = [args.direction === "horizontal" ? "hflip" : "vflip"];
  } else if (args.action === "grid_split") {
    if (!integer(args.rows, 1, 4) || !integer(args.columns, 1, 4)) invalid();
    for (let row = 0; row < args.rows; row++) for (let col = 0; col < args.columns; col++) {
      filters.push(`crop=floor(iw/${args.columns}):floor(ih/${args.rows}):floor(iw*${col}/${args.columns}):floor(ih*${row}/${args.rows})`);
    }
  } else {
    if (!Array.isArray(args.times) || !args.times.length || args.times.length > 16 || args.times.some(t => !Number.isFinite(t) || t < 0 || t > 21600)) invalid();
    times = args.times; filters = args.times.map(() => "null");
  }
  return filters.map((filter, i) => {
    const still = !video || args.action === "extract_frames", output = join(outputDir, `${String(i + 1).padStart(2, "0")}.${still ? "png" : "mp4"}`);
    return { output, args: ["-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,png_pipe,jpeg_pipe,webp_pipe,image2", "-threads", "2",
      ...(times ? ["-ss", String(times[i])] : []), "-i", args.file, "-vf", filter, "-map", "0:v:0",
      ...(still ? ["-frames:v", "1"] : ["-map", "0:a?", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]),
      "-map_metadata", "-1", "-fs", String(2 * 1024 ** 3), output] };
  });
}
async function executeFfmpeg(binary, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 120_000);
    child.stderr.resume(); // Never send paths, embedded metadata or tool output to logs.
    child.on("error", () => { clearTimeout(timer); reject(new CliError("FFMPEG_UNAVAILABLE", "Install ffmpeg, or set FANJIN_FFMPEG_PATH to its absolute path.", 2)); });
    child.on("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new CliError(timedOut ? "MEDIA_TIMEOUT" : "MEDIA_EDIT_FAILED", "Media processing did not finish. The source file is unchanged.", 3)); });
  });
}
export async function runLocalMedia(args, env, execute = executeFfmpeg) {
  mediaCommands(args, "/validation-only");
  const roots = localUploadRoots(env), file = await realpath(args.file);
  const allowed = await Promise.all(roots.map(async root => {
    const rel = relative(await realpath(root), file);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }));
  if (!allowed.some(Boolean)) throw new CliError("FILE_OUTSIDE_UPLOAD_ROOTS", "Select a file inside an allowed media directory.", 2);
  const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > 2 * 1024 ** 3) throw new CliError("INVALID_FILE", "Select a regular media file up to 2 GiB.", 2);
  if (env.FANJIN_FFMPEG_PATH && !isAbsolute(env.FANJIN_FFMPEG_PATH)) throw new CliError("INVALID_FFMPEG_PATH", "FANJIN_FFMPEG_PATH must be absolute.", 2);
  const directory = await mkdtemp(join(dirname(file), "fanjin-derived-")); await chmod(directory, 0o700);
  const commands = mediaCommands({ ...args, file }, directory), outputs = [];
  for (const command of commands) {
    await execute(env.FANJIN_FFMPEG_PATH || "ffmpeg", command.args);
    const result = await stat(command.output);
    if (!result.isFile() || result.size < 1) throw new CliError("EMPTY_MEDIA_OUTPUT", "No frame was produced at the requested time.", 3);
    if (result.size >= 2 * 1024 ** 3 - 1024 * 1024) throw new CliError("MEDIA_OUTPUT_TOO_LARGE", "Output reached the size limit; split the source before retrying.", 3);
    await chmod(command.output, 0o600); outputs.push({ file: command.output, sizeBytes: result.size });
  }
  return { apiVersion: "fanjin-tools/v1", ok: true, data: { action: args.action, outputs, generationSubmitted: false, nextTool: "fanjin_local_upload" } };
}
