#!/usr/bin/env node
// Build the product API/Worker only. Never invoke production release entrypoints.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const api = path.join(root, "fanjin-new/fanjin-api");
const require = createRequire(path.join(api, "package.json"));
const { build } = require("esbuild");
const pkg = JSON.parse(fs.readFileSync(path.join(api, "package.json"), "utf8"));
const out = path.join(api, "build-public");
fs.mkdirSync(out, { recursive: true });
const result = await build({
  absWorkingDir: api, entryPoints: ["src/app.ts"], outfile: "build-public/app.cjs",
  bundle: true, platform: "node", target: "node24", format: "cjs",
  packages: "external", tsconfig: "tsconfig.json", alias: { "@": "./src" },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) }, metafile: true,
  logLevel: "silent",
});
const inputs = Object.keys(result.metafile.inputs).map(f => path.relative(root, path.resolve(api, f)).split(path.sep).join("/")).sort();
const runtimeValidationLibraries = new Set([
  "candidate-exact-authorization-package.ts", "candidate-exact-authorization-v2.ts",
  "candidate-independent-launcher-attestation.ts", "candidate-independent-launcher-formal-issuer.ts",
  "production-startup-environment.ts", "production-startup-files.ts",
  "release-candidate-freeze.ts", "release-candidate-session-identity.ts",
].map(f => `fanjin-new/fanjin-api/scripts/lib/${f}`));
const outside = inputs.filter(f => !f.startsWith("fanjin-new/fanjin-api/src/") && !f.startsWith("contracts/") && !runtimeValidationLibraries.has(f));
if (outside.length) {
  throw new Error(`Product build escaped the allowed source boundary: ${outside.join(", ")}`);
}
fs.writeFileSync(path.join(out, "source-inputs.json"), JSON.stringify({ schema: "fanjin-public-product-build/v1", version: pkg.version, inputs }, null, 2) + "\n");
fs.writeFileSync(path.join(out, "source-graph.json"), JSON.stringify(Object.fromEntries(
  Object.entries(result.metafile.inputs).map(([file, value]) => [
    path.relative(root, path.resolve(api, file)).split(path.sep).join("/"),
    value.imports.filter(i => !i.external).map(i => path.relative(root, path.resolve(api, i.path)).split(path.sep).join("/")),
  ]),
), null, 2) + "\n");
process.stdout.write(JSON.stringify({ ok: true, entrypoints: ["API", "Worker"], sourceInputs: inputs.length, productionReleaseEntrypoints: false }) + "\n");
