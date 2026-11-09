import { readFile, writeFile } from "fs/promises";
import type { DB } from "@/types/database";
import crypto from "crypto";
import { createDatabaseClient } from "@/lib/createDatabaseClient";
import {
  inspectRuntimeDatabaseMigrations,
  prepareDatabaseForRuntimeApplication,
} from "@/lib/runtimeDatabaseCompatibility";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";
import {
  prepareDatabaseForReleaseController,
  usesReleaseControllerDatabaseReadiness,
} from "@/release-controller/databaseReadiness";

type TableName = keyof DB & string;
type RowType<TName extends TableName> = DB[TName];

const db = createDatabaseClient();

export const dbReady = (async () => {
  if (usesReleaseControllerDatabaseReadiness()) {
    await prepareDatabaseForReleaseController(db);
  } else if (isRecoveryOnlyMode()) {
    const status = await inspectRuntimeDatabaseMigrations(db);
    if (!status.current) {
      throw new Error("RECOVERY_ONLY_DATABASE_MIGRATIONS_NOT_CURRENT");
    }
  } else {
    await prepareDatabaseForRuntimeApplication(db);
  }
  if (process.env.NODE_ENV == "dev") initKnexType(db);
})();

const testDatabaseLifecycles = (globalThis as any)[
  Symbol.for("fanjin.test.database-lifecycles")
] as Set<{ ready: Promise<unknown>; close: () => Promise<unknown> }> | undefined;
if (testDatabaseLifecycles) {
  testDatabaseLifecycles.add({
    ready: dbReady,
    // Knex destroy is idempotent, which keeps this compatible with legacy
    // suites that already close the application database themselves.
    close: () => db.destroy(),
  });
  // Attach a rejection observer immediately; the teardown hook still awaits
  // the original promise and reports the same error with the owning suite.
  void dbReady.catch(() => undefined);
}

const dbClient = Object.assign(<TName extends TableName>(table: TName) => db<RowType<TName>, RowType<TName>[]>(table), db);
// Knex keeps `client` as a non-enumerable property, so Object.assign does not
// copy it to the typed callable wrapper. Dialect-sensitive helpers must still
// see the real client or PostgreSQL inserts are mistaken for SQLite inserts.
Object.defineProperty(dbClient, "client", {
  value: db.client,
  enumerable: false,
  configurable: false,
  writable: false,
});
// Knex's schema property is a factory getter: each access must return a fresh
// builder. Copying its value retains the queued operations across requests,
// making hasTable() replay every earlier query and eventually return arrays
// instead of the boolean result for the current table.
Object.defineProperty(dbClient, "schema", {
  get: () => db.schema,
  enumerable: true,
  configurable: false,
});
export default dbClient;

export { db };

async function initKnexType(knexDb: any) {
  const { Client } = await import("@rmp135/sql-ts");
  const outFile = "src/types/database.d.ts";
  const dbClient = Client.fromConfig({
    interfaceNameFormat: "${table}",
    typeMap: {
      number: ["bigint"],
      string: ["text", "varchar", "char"],
    },
  }).fetchDatabase(knexDb);
  const declarations = await dbClient.toTypescript();
  const dbObject = await dbClient.toObject();
  const customHeader = `//该文件由脚本自动生成，请勿手动修改`;
  // 清除上次的注释头
  let declBody = declarations.replace(/\r\n?/g, "\n").replace(/^\/\*[\s\S]*?\*\/\s*/, "");
  declBody = declBody.replace(/(\n\s*)\/\*([^*][\s\S]*?)\*\//g, "$1/**$2*/");
  const tableInterfaces = dbObject.schemas.flatMap((schema) => schema.tables.map((table) => table.interfaceName));
  const aggregateTypes = `
export interface DB {
${tableInterfaces.map((name) => `  ${JSON.stringify(name)}: ${name};`).join("\n")}
}
`;
  // 哈希仅基于结构化信息，header和空格不算
  const hashSource = JSON.stringify({
    tableInterfaces,
    declBody,
  });
  const hash = crypto.createHash("md5").update(hashSource).digest("hex");
  // 文件内容
  const content = `// @db-hash ${hash}\n${customHeader}\n\n` + declBody + aggregateTypes;
  let needWrite = true;
  try {
    const current = await readFile(outFile, "utf8");
    // 文件头已存在相同 hash，不需要写
    const match = current.match(/^\/\/\s*@db-hash\s*([a-zA-Z0-9]+)\n/);
    const currentHash = match ? match[1] : null;
    if (currentHash === hash) {
      needWrite = false;
    }
  } catch (err) {
    needWrite = true;
  }
  if (needWrite) await writeFile(outFile, content, "utf8");
}
