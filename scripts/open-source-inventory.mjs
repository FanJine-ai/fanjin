#!/usr/bin/env node
// Lock metadata is discovery evidence, never a legal approval or a runtime SBOM.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function inventoryLockfiles(root, lockfiles) {
  const components = new Map();
  const locks = [];
  for (const file of [...lockfiles].sort()) {
    const bytes = fs.readFileSync(path.join(root, file));
    const lock = JSON.parse(bytes);
    if (!lock.packages) throw new Error(`unsupported lockfile: ${file}`);
    locks.push({ path: file, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    for (const [location, pkg] of Object.entries(lock.packages)) {
      if (!location || pkg.link) continue;
      const name = pkg.name || location.split("node_modules/").at(-1);
      const version = pkg.version || "UNKNOWN";
      const license = typeof pkg.license === "string" ? pkg.license : "UNKNOWN";
      const key = `${name}@${version}`;
      const entry = components.get(key) || { name, version, licenses: [], occurrences: [] };
      if (!entry.licenses.includes(license)) entry.licenses.push(license);
      entry.occurrences.push({ lockfile: file, location, dev: pkg.dev === true });
      components.set(key, entry);
    }
  }
  const packages = [...components.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const review = packages.filter(p => p.licenses.length !== 1 || p.licenses.some(l => /UNKNOWN|GPL|MPL|SEE LICENSE|UNLICENSED/i.test(l)));
  return { schema: "fanjin-lock-license-inventory/v1", scope: "npm-lock-metadata-not-installed-runtime", locks, uniquePackages: packages.length, reviewRequired: review, packages };
}

export function toCycloneDx(inventory) {
  return {
    bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
    metadata: { properties: [{ name: "fanjin:scope", value: inventory.scope }] },
    components: inventory.packages.map(p => ({
      type: "library", name: p.name, version: p.version,
      "bom-ref": `pkg:npm/${p.name.replace("@", "%40")}@${p.version}`,
      purl: `pkg:npm/${p.name.replace("@", "%40")}@${p.version}`,
      // Keep unvalidated lock declarations as names, not validated SPDX claims.
      licenses: p.licenses.filter(l => l !== "UNKNOWN").map(name => ({ license: { name } })),
      properties: [
        { name: "fanjin:lockfiles", value: [...new Set(p.occurrences.map(o => o.lockfile))].join(",") },
        { name: "fanjin:licenseDeclarations", value: p.licenses.join(" | ") },
      ],
    })),
  };
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--output") throw new Error("usage: node scripts/open-source-inventory.mjs --output <new-directory>");
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
  const inventory = inventoryLockfiles(root, files.filter(f => path.posix.basename(f) === "package-lock.json"));
  const output = path.resolve(args[1]);
  fs.mkdirSync(output); // Refuse overwrite, including existing evidence directories.
  fs.writeFileSync(path.join(output, "licenses.json"), JSON.stringify(inventory, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "sbom.cdx.json"), JSON.stringify(toCycloneDx(inventory), null, 2) + "\n");
  fs.writeFileSync(path.join(output, "NOTICE-review.txt"), [
    "REVIEW DRAFT — not a distribution NOTICE. Lock metadata only.",
    "Obtain upstream license texts, copyright and required notices before distribution.",
    "Native binaries, fonts, media, system tools and Yarn resolutions need separate review.",
    ...inventory.packages.map(p => `${p.name}@${p.version}: ${p.licenses.join(" | ")}`), "",
  ].join("\n"));
  process.stdout.write(JSON.stringify({ lockfiles: inventory.locks.length, uniquePackages: inventory.uniquePackages, reviewRequired: inventory.reviewRequired.length }) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
