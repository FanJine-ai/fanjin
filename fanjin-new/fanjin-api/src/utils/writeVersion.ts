import path from "path";
import fs from "fs";
import getPath from "@/utils/getPath";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";

declare const __APP_VERSION__: string | undefined;

const APP_VERSION: string = (() => {
  if (typeof __APP_VERSION__ !== "undefined") {
    return __APP_VERSION__;
  }
  // 开发环境回退：从 package.json 读取
  const pkgPath = path.resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return pkg.version;
})();

export default async (version?: string) => {
  if (isRecoveryOnlyMode()) return;
  const versionFile = path.join(getPath(), "version.txt");
  if (!fs.existsSync(versionFile)) {
    fs.mkdirSync(path.dirname(versionFile), { recursive: true });
  }
  await fs.promises.writeFile(versionFile, version ?? APP_VERSION, "utf8");
};

export const getVersion = async () => {
  const versionFile = path.join(getPath(), "version.txt");
  if (fs.existsSync(versionFile)) {
    return fs.readFileSync(versionFile, "utf8");
  }
  if (isRecoveryOnlyMode()) return APP_VERSION;
  if (!fs.existsSync(versionFile)) {
    fs.mkdirSync(path.dirname(versionFile), { recursive: true });
  }
  await fs.promises.writeFile(versionFile, APP_VERSION, "utf8");
  return APP_VERSION;
};
