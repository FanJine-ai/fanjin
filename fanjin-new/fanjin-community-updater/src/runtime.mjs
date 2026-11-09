import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fork } from "node:child_process";
import { DatabaseSync, backup } from "node:sqlite";
import { ensure } from "./manifest.mjs";
import { hashFile, atomicJson, readJson } from "./files.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class NativeRuntime {
  constructor(config) {
    this.config = config; this.child = null; this.maintenance = true;
    this.data = path.join(config.home, "data");
  }
  open() { this.maintenance = false; }
  async isStopped() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return false;
    return new Promise(resolve => {
      const socket = net.connect({ host: "127.0.0.1", port: this.config.appPort });
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => resolve(true)); socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
  }
  async stop({ requireClean = true } = {}) {
    this.maintenance = true;
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const child = this.child;
    const completed = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.send({ type: "stop" });
    let timer;
    try {
      const result = await Promise.race([completed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("DRAIN_TIMEOUT"), { code: "DRAIN_TIMEOUT" })), 65000);
      })]);
      ensure(!requireClean || (result.code === 0 && !result.signal), "UNCLEAN_SHUTDOWN");
    } finally { clearTimeout(timer); }
  }
  async start(directory, manifest, { probe }) {
    ensure(await this.isStopped(), "RUNTIME_PORT_BUSY");
    const actual = readJson(path.join(directory, "release.json")).manifest;
    ensure(actual.version === manifest.version && actual.package.sha256 === manifest.package.sha256, "RUNTIME_IDENTITY_MISMATCH");
    const log = fs.openSync(path.join(this.config.home, "runtime.log"), "a", 0o600);
    this.child = fork(new URL("./runtimeChild.mjs", import.meta.url), [], {
      stdio: ["ignore", log, log, "ipc"],
      env: { PATH: process.env.PATH || "", FANJIN_MANAGED_RUNTIME: JSON.stringify({
        directory, data: this.data, port: this.config.appPort, probe, token: this.config.accessSecret,
        rootPassword: this.config.rootPassword, storage: this.config.storage || {},
      }) },
    });
    fs.closeSync(log);
    this.child.on("error", () => {});
  }
  async health(manifest) {
    const deadline = Date.now() + (this.config.healthTimeoutMs || 60000);
    while (Date.now() < deadline) {
      ensure(this.child && this.child.exitCode === null && this.child.signalCode === null, "RUNTIME_EXITED");
      try {
        const base = "http://127.0.0.1:" + this.config.appPort;
        const [health, ready, page] = await Promise.all(["/api/health", "/api/ready", "/"].map(url => fetch(base + url,
          { redirect: "error", signal: AbortSignal.timeout(1500) })));
        if (health.ok && ready.ok && page.ok && (await health.json()).version === manifest.version) {
          const db = new DatabaseSync(path.join(this.data, "db2.sqlite"), { readOnly: true });
          try {
            ensure(db.prepare("SELECT MAX(version) AS version FROM o_schema_migration").get().version === manifest.databaseSchema,
              "DATABASE_SCHEMA_MISMATCH");
            ensure(db.prepare("PRAGMA quick_check").get().quick_check === "ok", "DATABASE_CORRUPT");
          } finally { db.close(); }
          return;
        }
      } catch (error) {
        if (["DATABASE_SCHEMA_MISMATCH", "DATABASE_CORRUPT"].includes(error.code)) throw error;
      }
      await sleep(300);
    }
    throw Object.assign(new Error("RUNTIME_NOT_READY"), { code: "RUNTIME_NOT_READY" });
  }
  async backup(directory) {
    ensure(await this.isStopped(), "BACKUP_RUNTIME_ACTIVE");
    fs.mkdirSync(directory, { mode: 0o700 });
    const source = path.join(this.data, "db2.sqlite");
    if (!fs.existsSync(source)) return { directory, empty: true };
    const db = new DatabaseSync(source, { readOnly: true });
    try { await backup(db, path.join(directory, "db2.sqlite")); } finally { db.close(); }
    fs.chmodSync(path.join(directory, "db2.sqlite"), 0o600);
    const receipt = { directory, empty: false, ...await hashFile(path.join(directory, "db2.sqlite")) };
    atomicJson(path.join(directory, "backup.json"), receipt);
    return receipt;
  }
  async restore(receipt) {
    ensure(await this.isStopped(), "RESTORE_RUNTIME_ACTIVE");
    const expectedRoot = path.join(this.config.home, "backups") + path.sep;
    ensure(receipt.directory.startsWith(expectedRoot), "INVALID_BACKUP_PATH");
    const source = path.join(receipt.directory, "db2.sqlite");
    if (!receipt.empty) ensure((await hashFile(source)).sha256 === receipt.sha256, "BACKUP_HASH_MISMATCH");
    const database = path.join(this.data, "db2.sqlite");
    // All writers are stopped. Never restore config, user media or a live DB.
    for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(database + suffix, { force: true });
    if (receipt.empty) fs.rmSync(database, { force: true });
    else {
      fs.copyFileSync(source, database + ".restore");
      fs.chmodSync(database + ".restore", 0o600);
      const fd = fs.openSync(database + ".restore", "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(database + ".restore", database);
    }
  }
}
