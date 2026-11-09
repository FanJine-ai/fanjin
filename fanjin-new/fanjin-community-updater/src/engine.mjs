import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { ensure, verifyEnvelope, digest, compareVersions } from "./manifest.mjs";
import { privateDirectory, atomicJson, readJson } from "./files.mjs";
import { unpackBundle, inventory } from "./bundle.mjs";

export const UPDATER_VERSION = "0.1.0";
const terminal = new Set(["succeeded", "failed", "rolled_back"]);
function safeUrl(value, allowLoopback) {
  const url = new URL(value);
  ensure(!url.username && !url.password && !url.hash && !url.search
    && (url.protocol === "https:" || (allowLoopback && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))), "UNSAFE_FEED_URL");
  return url;
}
export class UpdateEngine {
  constructor(config, runtime) {
    this.config = config; this.runtime = runtime;
    this.home = privateDirectory(config.home);
    this.data = privateDirectory(path.join(this.home, "data"));
    this.versions = privateDirectory(path.join(this.home, "versions"));
    this.downloads = privateDirectory(path.join(this.home, "downloads"));
    this.backups = privateDirectory(path.join(this.home, "backups"));
    this.base = safeUrl(config.feedBaseUrl, config.allowLoopbackFeed === true).href.replace(/\/$/, "");
    ensure(["stable", "preview"].includes(config.channel), "INVALID_CHANNEL");
    ensure(config.platform === process.platform + "-" + process.arch, "WRONG_HOST_PLATFORM");
    this.db = new DatabaseSync(path.join(this.home, "updates.sqlite"));
    fs.chmodSync(path.join(this.home, "updates.sqlite"), 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.busy = false;
  }
  get(key) { const row = this.db.prepare("SELECT value FROM state WHERE key=?").get(key); return row ? JSON.parse(row.value) : null; }
  put(key, value) { this.db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }
  status() {
    const current = this.get("current"), available = this.get("available"), job = this.get("job");
    return {
      current: current ? { version: current.version, digest: current.digest, databaseSchema: current.databaseSchema } : null,
      available: available ? { version: available.manifest.version, notes: available.manifest.notes, size: available.manifest.package.size } : null,
      availableDigest: available ? digest(available) : null,
      startupError: this.get("startupError"),
      job: job ? { id: job.id, state: job.state, error: job.error, startedAt: job.startedAt, version: job.target.version } : null,
      updaterVersion: UPDATER_VERSION,
    };
  }
  async fetchFeed() {
    const url = this.base + "/" + this.config.channel + "/" + this.config.platform + ".json";
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000), cache: "no-store" });
    ensure(response.ok, response.status === 410 ? "RELEASE_WITHDRAWN" : "FEED_UNAVAILABLE");
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; ensure(size <= 32 * 1024 ** 2, "FEED_TOO_LARGE"); chunks.push(chunk); }
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const m = verifyEnvelope(envelope, this.config.trustedKeys);
    ensure(m.channel === this.config.channel && m.platform === this.config.platform, "FEED_TARGET_MISMATCH");
    const seen = this.get("highest");
    ensure(!seen || m.sequence > seen.sequence || (m.sequence === seen.sequence && digest(envelope) === seen.digest), "FEED_ROLLBACK");
    return envelope;
  }
  async check() {
    const envelope = await this.fetchFeed(), m = envelope.manifest, current = this.get("current");
    this.put("highest", { sequence: m.sequence, digest: digest(envelope) });
    this.put("available", !current || compareVersions(m.version, current.version) > 0 ? envelope : null);
    return this.status();
  }
  validateTarget(m, current) {
    ensure(compareVersions(UPDATER_VERSION, m.minimumUpdaterVersion) >= 0, "UPDATER_TOO_OLD");
    if (current) {
      ensure(compareVersions(m.version, current.version) > 0, "VERSION_NOT_NEWER");
      ensure(compareVersions(current.version, m.minimumVersion) >= 0, "INTERMEDIATE_VERSION_REQUIRED");
      // Initial release intentionally accepts only database-compatible updates.
      // Cross-schema upgrades need a reviewed migration/restore adapter.
      ensure(m.databaseSchema === current.databaseSchema, "DATABASE_UPGRADE_ADAPTER_REQUIRED");
    }
  }
  async request(expectedDigest) {
    ensure(!this.busy, "UPDATE_IN_PROGRESS");
    ensure(!this.get("startupError"), "RECOVERY_REQUIRED");
    const envelope = this.get("available");
    ensure(envelope && digest(envelope) === expectedDigest, "UPDATE_SELECTION_CHANGED");
    const m = verifyEnvelope(envelope, this.config.trustedKeys), current = this.get("current");
    this.validateTarget(m, current);
    const space = fs.statfsSync(this.home);
    const expanded = m.files.reduce((sum, file) => sum + file.size, 0);
    const database = path.join(this.data, "db2.sqlite");
    const dbSize = fs.existsSync(database) ? fs.statSync(database).size : 0;
    ensure(space.bavail * space.bsize >= m.package.size + expanded + dbSize * 2 + 256 * 1024 ** 2, "INSUFFICIENT_DISK");
    const job = { id: randomUUID(), state: "downloading", old: current, target: m,
      envelope, selection: expectedDigest, backup: null, error: null, startedAt: new Date().toISOString() };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.get("job");
      ensure(!previous || terminal.has(previous.state), "UPDATE_IN_PROGRESS");
      this.put("job", job); this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.busy = true;
    this.running = this.execute(job).finally(() => { this.busy = false; });
    return this.status();
  }
  phase(job, state) { job.state = state; this.put("job", job); }
  async download(job) {
    const m = job.target, destination = path.join(this.downloads, job.id + ".fjb");
    const response = await fetch(this.base + "/packages/" + m.package.sha256 + ".fjb",
      { redirect: "error", signal: AbortSignal.timeout(30 * 60 * 1000) });
    ensure(response.ok, "DOWNLOAD_FAILED");
    const fd = fs.openSync(destination, "wx", 0o600); let size = 0; const hash = createHash("sha256");
    try {
      for await (const chunk of response.body) {
        size += chunk.length; ensure(size <= m.package.size, "PACKAGE_TOO_LARGE");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
      }
      ensure(size === m.package.size && hash.digest("hex") === m.package.sha256, "PACKAGE_HASH_MISMATCH");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return destination;
  }
  async execute(job) {
    let stopped = false;
    try {
      const archive = await this.download(job);
      this.phase(job, "verifying_package");
      const staging = path.join(this.versions, "." + job.id);
      await unpackBundle(archive, staging, job.target);
      const destination = path.join(this.versions, job.selection);
      if (fs.existsSync(destination)) {
        // A previous attempt may have failed after extraction. Reuse only the
        // exact verified bytes, never overwrite a version another job used.
        ensure(digest(readJson(path.join(destination, "release.json"))) === job.selection, "VERSION_DIRECTORY_CHANGED");
        const files = (await inventory(destination)).filter(file => file.path !== "release.json");
        ensure(digest(files) === digest(job.target.files), "VERSION_DIRECTORY_CHANGED");
        fs.rmSync(staging, { recursive: true, force: true });
      } else {
        atomicJson(path.join(staging, "release.json"), job.envelope);
        fs.renameSync(staging, destination);
      }
      ensure(digest(await this.fetchFeed()) === job.selection, "RELEASE_CHANGED_BEFORE_SWITCH");
      this.phase(job, "waiting_tasks");
      stopped = true; await this.runtime.stop();
      this.phase(job, "backing_up");
      job.backup = await this.runtime.backup(path.join(this.backups, job.id));
      this.phase(job, "switching");
      await this.runtime.start(destination, job.target, { probe: true });
      await this.runtime.health(job.target);
      await this.runtime.stop();
      this.phase(job, "activating");
      // Once workers may write, never restore the older database snapshot.
      this.put("current", { ...job.target, digest: job.selection });
      await this.runtime.start(destination, job.target, { probe: false });
      await this.runtime.health(job.target);
      this.put("available", null);
      this.phase(job, "succeeded");
      this.runtime.open();
    } catch (error) {
      job.error = typeof error.code === "string" ? error.code : "UPDATE_FAILED";
      try {
        if (stopped) {
          await this.runtime.stop({ requireClean: false });
          if (job.state !== "activating" && job.backup) await this.runtime.restore(job.backup);
          // Same-schema compatibility is mandatory; after activation roll back
          // binaries only, preserving any newly written tasks and balances.
          if (job.old) {
            await this.runtime.start(path.join(this.versions, job.old.digest), job.old, { probe: false });
            await this.runtime.health(job.old);
            this.put("current", job.old);
            this.phase(job, "rolled_back"); this.runtime.open();
          } else { this.put("current", null); this.phase(job, "failed"); }
        } else { this.phase(job, "failed"); this.runtime.open(); }
      } catch (recoveryError) {
        job.recoveryError = typeof recoveryError.code === "string" ? recoveryError.code : "RECOVERY_FAILED";
        this.phase(job, "recovery_required");
      }
    }
  }
  async recover() {
    const job = this.get("job");
    if (job && !terminal.has(job.state)) {
      // The daemon owns both listeners. A prior runtime must exit before this
      // is called; start-up never kills a PID found in a file.
      ensure(await this.runtime.isStopped(), "PREVIOUS_RUNTIME_STILL_RUNNING");
      if (["switching", "backing_up"].includes(job.state) && job.backup) await this.runtime.restore(job.backup);
      if (["activating", "recovery_required"].includes(job.state)) {
        // Activation may already have resumed writes. Preserve the database.
        this.put("current", job.old);
      }
      job.error = "UPDATE_INTERRUPTED";
      // Do not declare recovery complete until the previous runtime is healthy.
    }
    const current = this.get("current");
    if (current) {
      await this.runtime.start(path.join(this.versions, current.digest), current, { probe: false });
      await this.runtime.health(current); this.runtime.open();
    }
    if (job && !terminal.has(job.state)) this.phase(job, job.old ? "rolled_back" : "failed");
    this.put("startupError", null);
    return this.status();
  }
  close() { this.db.close(); }
}
