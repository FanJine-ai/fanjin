import path from "path";
import isPathInside from "is-path-inside";

const getPath = (fileName?: string[] | string) => {
  let basePath: string;
  if (process.env.FANJIN_DATA_DIR) {
    basePath = path.resolve(process.env.FANJIN_DATA_DIR);
  } else {
    basePath = path.join(process.cwd(), "data");
  }
  if (fileName) {
    let dbPath: string;
    if (Array.isArray(fileName)) {
      dbPath = path.resolve(basePath, ...fileName);
    } else {
      dbPath = path.resolve(basePath, fileName);
    }
    if (!isPathInside(dbPath, basePath) && dbPath !== basePath) {
      throw new Error("路径逃逸错误，路径必须在数据目录内");
    }
    return dbPath;
  }
  return basePath;
};

export default getPath;

/**
 * Web assets are release artifacts, not mutable application data. Containers
 * may mount FANJIN_DATA_DIR as a persistent volume, so production images can
 * keep the current frontend outside that volume and point to it explicitly.
 */
export function getWebPath(): string {
  const configured = String(process.env.FANJIN_WEB_DIR || "").trim();
  if (configured) return path.resolve(configured);
  return path.resolve(getPath("web"));
}
