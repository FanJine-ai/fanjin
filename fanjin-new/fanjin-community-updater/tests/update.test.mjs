import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { generateKeyPairSync, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { seal, verifyEnvelope, digest, sha256 } from "../src/manifest.mjs";
import { packBundle, unpackBundle } from "../src/bundle.mjs";
import { UpdateEngine } from "../src/engine.mjs";
import { authorized, startUpdater } from "../src/server.mjs";
import { NativeRuntime } from "../src/runtime.mjs";
import { atomicJson } from "../src/files.mjs";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = [{ keyId: "test-only", publicKey: publicKey.export({ type: "spki", format: "pem" }) }];
const platform = process.platform + "-" + process.arch;
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "fanjin-update-test-"));
async function fixture(root, version = "0.3.14", sequence = 1, options = {}) {
  const app = path.join(root, version); fs.mkdirSync(app, { recursive: true });
  const apiPath = "app/fanjin-new/fanjin-api/build-public";
  fs.mkdirSync(path.join(app, apiPath), { recursive: true });
  fs.mkdirSync(path.join(app, "app/fanjin-new/fanjin-v4/dist"), { recursive: true });
  fs.writeFileSync(path.join(app, apiPath, "app.cjs"), options.code || "synthetic fixture only");
  fs.writeFileSync(path.join(app, "app/fanjin-new/fanjin-v4/dist/index.html"), "<!doctype html><title>Fixture</title>");
  fs.writeFileSync(path.join(app, "zero"), "");
  const archive = path.join(root, version + ".fjb"), packed = await packBundle(app, archive);
  const manifest = { schema: "fanjin-community-update/v1", product: "fanjin-community", version,
    sourceCommit: "a".repeat(40), sourceDigest: "b".repeat(64), channel: "stable", sequence, platform,
    createdAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    minimumVersion: "0.3.13", minimumUpdaterVersion: "0.1.0", databaseSchema: 61, notes: "Synthetic update",
    ...packed, ...options.manifest };
  return { envelope: seal(manifest, "test-only", privateKey), archive };
}
async function feedServer(initial) {
  let current = initial, corrupt = false, withdrawn = false;
  const server = http.createServer((req, res) => {
    if (withdrawn) { res.writeHead(410); res.end(); }
    else if (req.url.endsWith(".json")) { res.end(JSON.stringify(current.envelope)); }
    else if (corrupt) res.end("invalid bytes");
    else fs.createReadStream(current.archive).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { base: "http://127.0.0.1:" + server.address().port, set(value) { current = value; },
    corrupt() { corrupt = true; }, withdraw() { withdrawn = true; }, close: () => new Promise(r => server.close(r)) };
}
function fakeRuntime() {
  return {
    events: [], maintenance: false, fail: false, active: null,
    async stop() { this.events.push("stop"); this.active = null; this.maintenance = true; },
    async start(dir, m, options) { this.events.push(options.probe ? "probe" : "start"); this.active = m.version; if (this.fail && m.version === "0.3.15") throw Error("fixture failure"); },
    async health() { this.events.push("health"); },
    async backup(dir) { this.events.push("backup"); return { directory: dir }; },
    async restore() { this.events.push("restore"); },
    open() { this.events.push("open"); this.maintenance = false; },
    async isStopped() { return this.active === null; },
  };
}
function config(root, base) { return { home: path.join(root, "install"), feedBaseUrl: base, channel: "stable", platform,
  trustedKeys: keys, allowLoopbackFeed: true, port: 19682, appPort: 19683, accessSecret: "a".repeat(64), rootPassword: "synthetic-password-only" }; }

test("signature pins, expiry, product boundaries and unsafe paths fail before installation", async t => {
  const root = temporary(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { envelope } = await fixture(root);
  assert.equal(verifyEnvelope(envelope, keys).version, "0.3.14");
  const changed = structuredClone(envelope); changed.manifest.version = "0.3.15";
  assert.throws(() => verifyEnvelope(changed, keys), /UNTRUSTED_SIGNATURE/);
  assert.throws(() => verifyEnvelope(envelope, []), /UNTRUSTED_SIGNATURE/);
  assert.throws(() => verifyEnvelope(envelope, keys, Date.now() + 2 * 86400000), /EXPIRED_MANIFEST/);
  for (const file of ["../escape", "/tmp/escape", "app/.env", "app\\outside", "app/x:stream"]) {
    const bad = structuredClone(envelope.manifest); bad.files[0].path = file;
    assert.throws(() => seal(bad, "test-only", privateKey), /INVALID_PACKAGE_PATH|INCOMPLETE_RUNTIME/);
  }
  assert.throws(() => seal({ ...envelope.manifest, product: "fanjin-production" }, "test-only", privateKey), /WRONG_PRODUCT/);
});

test("streamed package extracts only signed regular files and rejects traversal/truncation", async t => {
  const root = temporary(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { envelope, archive } = await fixture(root);
  const destination = path.join(root, "expanded");
  await unpackBundle(archive, destination, envelope.manifest);
  assert.equal(fs.readFileSync(path.join(destination, "zero"), "utf8"), "");
  const bytes = gzipSync(Buffer.from('FANJIN-BUNDLE-1\n{"path":"../escape","size":0}\n{}\n'));
  const attack = path.join(root, "attack.fjb"); fs.writeFileSync(attack, bytes);
  const manipulated = { ...envelope.manifest, package: { sha256: sha256(bytes), size: bytes.length } };
  await assert.rejects(unpackBundle(attack, path.join(root, "rejected"), manipulated), /BUNDLE_INVENTORY_MISMATCH/);
  assert.equal(fs.existsSync(path.join(root, "escape")), false);
  assert.equal(fs.existsSync(path.join(root, "rejected")), false);
  await assert.rejects(unpackBundle(attack, path.join(root, "bad-hash"), envelope.manifest), /PACKAGE_HASH_MISMATCH/);
});

test("download, update and compatible rollback retain data and never repeat provider requests", async t => {
  const root = temporary(); const old = await fixture(root);
  const feed = await feedServer(old); const runtime = fakeRuntime();
  const engine = new UpdateEngine(config(root, feed.base), runtime);
  t.after(async () => { engine.close(); await feed.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(engine.data, "user-media"), "preserve me");
  await engine.check(); await engine.request(digest(old.envelope)); await engine.running;
  assert.equal(engine.status().job.state, "succeeded");
  assert.equal(engine.status().current.version, "0.3.14");
  assert.deepEqual(runtime.events.slice(0, 6), ["stop", "backup", "probe", "health", "stop", "start"]);
  const next = await fixture(root, "0.3.15", 2); feed.set(next); runtime.fail = true;
  await engine.check(); await engine.request(digest(next.envelope)); await engine.running;
  assert.equal(engine.status().job.state, "rolled_back");
  assert.equal(engine.status().current.version, "0.3.14");
  assert.equal(fs.readFileSync(path.join(engine.data, "user-media"), "utf8"), "preserve me");
  assert.ok(runtime.events.includes("restore"));
  assert.equal(runtime.active, "0.3.14");
});

test("bad downloads, withdrawn releases, double clicks and incompatible schemas do not stop working runtime", async t => {
  const root = temporary(), current = await fixture(root), feed = await feedServer(current), runtime = fakeRuntime();
  const engine = new UpdateEngine(config(root, feed.base), runtime);
  t.after(async () => { engine.close(); await feed.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await engine.check(); feed.corrupt();
  await engine.request(digest(current.envelope));
  await assert.rejects(engine.request(digest(current.envelope)), /UPDATE_IN_PROGRESS/);
  await engine.running;
  assert.equal(engine.status().job.state, "failed");
  assert.equal(runtime.events.includes("stop"), false);
  feed.withdraw(); await assert.rejects(engine.check(), /RELEASE_WITHDRAWN/);
  engine.put("current", { ...current.envelope.manifest, digest: digest(current.envelope) });
  const incompatible = await fixture(root, "0.3.15", 2, { manifest: { databaseSchema: 62 } });
  engine.put("available", incompatible.envelope);
  await assert.rejects(engine.request(digest(incompatible.envelope)), /DATABASE_UPGRADE_ADAPTER_REQUIRED/);
});

test("feed rollback/equivocation and interrupted jobs are detected across restarts", async t => {
  const root = temporary(), first = await fixture(root), next = await fixture(root, "0.3.15", 2);
  const feed = await feedServer(next), runtime = fakeRuntime(), cfg = config(root, feed.base);
  let engine = new UpdateEngine(cfg, runtime);
  t.after(async () => { engine.close(); await feed.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await engine.check(); feed.set(first); await assert.rejects(engine.check(), /FEED_ROLLBACK/);
  engine.put("current", { ...first.envelope.manifest, digest: digest(first.envelope) });
  engine.put("job", { id: "interrupted", state: "activating", old: engine.get("current"), target: next.envelope.manifest, backup: { directory: "old" } });
  engine.close(); engine = new UpdateEngine(cfg, runtime);
  await engine.recover();
  assert.equal(engine.status().job.state, "rolled_back");
  assert.equal(runtime.events.includes("restore"), false, "activation may have written new tasks; no DB rewind");
  assert.equal(runtime.active, "0.3.14");
});

test("local update capabilities expire and are not valid for a different installation", () => {
  const payload = Buffer.from(JSON.stringify({ scope: "local-update", expiresAt: Date.now() + 10000 })).toString("base64url");
  const secret = "a".repeat(64), token = payload + "." + createHmac("sha256", secret).update(payload).digest("base64url");
  assert.ok(authorized(token, secret));
  assert.equal(authorized(token, "b".repeat(64)), false);
  assert.equal(authorized(token, secret, Date.now() + 20000), false);
  assert.equal(authorized(token + ".extra", secret), false);
});

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function runtimeCode(version, failure = "") {
  return `
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const data = process.env.FANJIN_DATA_DIR;
const db = new DatabaseSync(path.join(data, "db2.sqlite"));
db.exec("CREATE TABLE IF NOT EXISTS o_schema_migration(version INTEGER); INSERT INTO o_schema_migration SELECT 61 WHERE NOT EXISTS(SELECT 1 FROM o_schema_migration); CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY)");
const probe = process.env.FANJIN_PROCESS_ROLE === "api";
if (${JSON.stringify(failure)} === "probe" && probe && fs.existsSync(path.join(data, "fail-probe"))) {
  db.exec("INSERT OR IGNORE INTO ledger VALUES('probe-only')");
  process.exit(1);
}
if (${JSON.stringify(failure)} === "activation" && !probe) {
  db.exec("INSERT OR IGNORE INTO ledger VALUES('new-bill')");
  process.exit(1);
}
const server = http.createServer((req,res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ version: ${JSON.stringify(version)}, ok:true }));
}).listen(Number(process.env.FANJIN_APP_PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => { db.close(); process.exit(0); }));
`;
}
test("real updater HTTP, runtime drain, SQLite restore, retry and post-activation billing preservation", { timeout: 30000 }, async t => {
  const root = temporary(), first = await fixture(root, "0.3.14", 1, { code: runtimeCode("0.3.14") });
  const feed = await feedServer(first), cfg = { ...config(root, feed.base), port: await freePort(), appPort: await freePort(), healthTimeoutMs: 4000 };
  const updater = await startUpdater(cfg);
  t.after(async () => { await updater.close(); await feed.close(); fs.rmSync(root, { recursive:true, force:true }); });
  const base = "http://127.0.0.1:" + cfg.port;
  const api = (name, body) => fetch(base + "/__fanjin_update/" + name, { method: body ? "POST" : "GET",
    headers: { authorization:"Bearer " + cfg.accessSecret, "content-type":"application/json" }, ...(body ? { body:JSON.stringify(body) } : {}) });
  assert.equal((await fetch(base + "/__fanjin_update/status")).status, 401);
  assert.equal((await fetch(base + "/__fanjin_update/status", { headers: { authorization:"Bearer " + cfg.accessSecret, origin:"https://invalid.example" } })).status, 403);
  assert.equal((await fetch(base + "/__fanjin_update/")).status, 200);
  await assert.rejects(startUpdater({ ...cfg, port:await freePort() }), error => error.code === "UPDATER_ALREADY_RUNNING");
  const apply = async next => {
    feed.set(next);
    assert.equal((await api("check", {})).status, 200);
    assert.equal((await api("apply", { expectedDigest:digest(next.envelope) })).status, 202);
    await updater.engine.running;
    return updater.engine.status();
  };
  assert.equal((await apply(first)).job.state, "succeeded");
  assert.equal((await fetch(base + "/api/health")).status, 200);
  fs.writeFileSync(path.join(cfg.home, "data", "user-media"), "keep-original");
  fs.writeFileSync(path.join(cfg.home, "data", "fail-probe"), "synthetic fault");
  const second = await fixture(root, "0.3.15", 2, { code:runtimeCode("0.3.15", "probe") });
  assert.equal((await apply(second)).job.state, "rolled_back", JSON.stringify(updater.engine.get("job")?.recoveryError));
  let db = new DatabaseSync(path.join(cfg.home, "data", "db2.sqlite"), { readOnly:true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM ledger WHERE id='probe-only'").get().n, 0); db.close();
  fs.rmSync(path.join(cfg.home, "data", "fail-probe"));
  assert.equal((await apply(second)).job.state, "succeeded", "retry reuses the exact verified version directory");
  const third = await fixture(root, "0.3.16", 3, { code:runtimeCode("0.3.16", "activation") });
  const failed = await apply(third);
  assert.equal(failed.job.state, "rolled_back"); assert.equal(failed.current.version, "0.3.15");
  db = new DatabaseSync(path.join(cfg.home, "data", "db2.sqlite"), { readOnly:true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM ledger WHERE id='new-bill'").get().n, 1); db.close();
  assert.equal(fs.readFileSync(path.join(cfg.home, "data", "user-media"), "utf8"), "keep-original");
});
