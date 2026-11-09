// Length-delimited regular files: no tar links, devices, modes or extraction commands.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { ensure, relativeFile } from "./manifest.mjs";
import { hashFile } from "./files.mjs";

const MAGIC = Buffer.from("FANJIN-BUNDLE-1\n");
export async function inventory(root) {
  const files = [];
  async function walk(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, file = path.join(directory, entry.name);
      // npm executable shims are not needed by a prebuilt product.
      if (entry.name === ".bin") continue;
      relativeFile(name);
      ensure(!entry.isSymbolicLink(), "PACKAGE_LINK_FORBIDDEN");
      if (entry.isDirectory()) await walk(file, name + "/");
      else {
        ensure(entry.isFile(), "PACKAGE_SPECIAL_FILE");
        const stat = fs.statSync(file);
        files.push({ path: name, ...await hashFile(file), executable: !!(stat.mode & 0o111) });
      }
    }
  }
  await walk(root); return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function packBundle(root, output) {
  const files = await inventory(root);
  async function* chunks() {
    yield MAGIC;
    for (const file of files) {
      yield Buffer.from(JSON.stringify({ path: file.path, size: file.size }) + "\n");
      yield* fs.createReadStream(path.join(root, file.path));
    }
    yield Buffer.from("{}\n");
  }
  await pipeline(Readable.from(chunks()), createGzip(), fs.createWriteStream(output, { flags: "wx", mode: 0o600 }));
  return { files, package: await hashFile(output) };
}
export async function unpackBundle(archive, destination, manifest) {
  ensure(!fs.existsSync(destination), "DESTINATION_EXISTS");
  const actual = await hashFile(archive);
  ensure(actual.sha256 === manifest.package.sha256 && actual.size === manifest.package.size, "PACKAGE_HASH_MISMATCH");
  fs.mkdirSync(destination, { mode: 0o700 });
  const source = fs.createReadStream(archive);
  const stream = source.pipe(createGunzip());
  source.on("error", error => stream.destroy(error));
  let buffer = Buffer.alloc(0), file = null, fd = null, hash = null, remaining = 0, index = 0, magic = false, ended = false;
  try {
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!magic) {
          if (buffer.length < MAGIC.length) break;
          ensure(buffer.subarray(0, MAGIC.length).equals(MAGIC), "INVALID_BUNDLE");
          buffer = buffer.subarray(MAGIC.length); magic = true;
        }
        if (file) {
          const take = Math.min(remaining, buffer.length);
          if (take) {
            let offset = 0;
            while (offset < take) offset += fs.writeSync(fd, buffer, offset, take - offset);
            hash.update(buffer.subarray(0, take)); buffer = buffer.subarray(take); remaining -= take;
          }
          if (remaining) break;
          ensure(hash.digest("hex") === file.sha256, "FILE_HASH_MISMATCH");
          fs.fchmodSync(fd, file.executable ? 0o700 : 0o600); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
          file = null; index++;
        }
        if (ended) { ensure(buffer.length === 0, "BUNDLE_TRAILING_BYTES"); break; }
        const newline = buffer.indexOf(10);
        if (newline < 0) { ensure(buffer.length <= 2048, "BUNDLE_HEADER_TOO_LARGE"); break; }
        ensure(newline <= 2048, "BUNDLE_HEADER_TOO_LARGE");
        const header = JSON.parse(buffer.subarray(0, newline).toString("utf8")); buffer = buffer.subarray(newline + 1);
        if (Object.keys(header).length === 0) { ensure(index === manifest.files.length, "BUNDLE_INCOMPLETE"); ended = true; continue; }
        file = manifest.files[index];
        ensure(file && Object.keys(header).sort().join(",") === "path,size"
          && header.path === file.path && header.size === file.size, "BUNDLE_INVENTORY_MISMATCH");
        relativeFile(file.path);
        const target = path.join(destination, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fd = fs.openSync(target, "wx", 0o600); hash = createHash("sha256"); remaining = file.size;
      }
    }
    ensure(magic && ended && !file && buffer.length === 0, "BUNDLE_INCOMPLETE");
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    source.destroy(); stream.destroy();
    fs.rmSync(destination, { recursive: true, force: true }); throw error;
  }
}
