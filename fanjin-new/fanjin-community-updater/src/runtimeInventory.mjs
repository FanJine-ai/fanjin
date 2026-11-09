import path from "node:path";
import { inventory } from "./bundle.mjs";
export async function runtimeInventory(source) {
  const files = [];
  for (const part of ["fanjin-new/fanjin-api/build-public", "fanjin-new/fanjin-api/node_modules", "fanjin-new/fanjin-v4/dist", "third_party"]) {
    for (const file of await inventory(path.join(source, part))) files.push({ ...file, path: "app/" + part + "/" + file.path });
  }
  const { hashFile } = await import("./files.mjs");
  for (const part of ["fanjin-new/fanjin-api/package.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) files.push({
    path: "app/" + part, ...await hashFile(path.join(source, part)), executable: false,
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
