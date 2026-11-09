import fs from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";
import getPath from "@/utils/getPath";

const DIRECT_SECRET_LOG = /^[ \t]*logger\(\s*vendor\.inputValues\.(?:ak|sk)\s*\);?[ \t]*(?:\r?\n|$)/gm;

export function removeVendorSecretLoggingFromSource(source: string): { source: string; removed: number } {
  let removed = 0;
  const next = source.replace(DIRECT_SECRET_LOG, () => {
    removed += 1;
    return "";
  });
  return { source: next, removed };
}

export async function scrubRuntimeVendorSecretLogging(
  targetPath = getPath(["vendor", "volcengineSd2.ts"]),
): Promise<{ changed: boolean; removed: number }> {
  let before: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    [before, stat] = await Promise.all([fs.readFile(targetPath, "utf8"), fs.stat(targetPath)]);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { changed: false, removed: 0 };
    throw error;
  }

  const result = removeVendorSecretLoggingFromSource(before);
  if (!result.removed) return { changed: false, removed: 0 };

  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.migration-${process.pid}-${Date.now()}`,
  );
  try {
    await fs.writeFile(temporaryPath, result.source, { encoding: "utf8", mode: stat.mode });
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { changed: true, removed: result.removed };
}

export async function upRemoveVendorSecretLogging(_trx: Knex.Transaction): Promise<void> {
  await scrubRuntimeVendorSecretLogging();
}

export async function downRemoveVendorSecretLogging(): Promise<void> {
  throw new Error("Migration remove_vendor_secret_logging is intentionally irreversible; restoring secret logging is forbidden.");
}
