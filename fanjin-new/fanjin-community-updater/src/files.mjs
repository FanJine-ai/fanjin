import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensure } from "./manifest.mjs";

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  ensure(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
    && !(stat.mode & 0o022), "UNSAFE_DIRECTORY");
  return fs.realpathSync(directory);
}
export function atomicJson(file, value) {
  const temp = file + "." + randomUUID() + ".tmp";
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
export async function hashFile(file) {
  const hash = createHash("sha256"); let size = 0;
  const stream = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  for await (const chunk of stream) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest("hex"), size };
}
