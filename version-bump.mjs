/**
 * Sync the Obsidian plugin manifest + versions map to a release version.
 *
 * Run by semantic-release during `prepare` (see .releaserc.json) with the
 * computed next version, so the GitHub release's manifest.json matches the tag
 * and BRAT/Obsidian can detect updates:
 *
 *   node version-bump.mjs 2.8.0
 *
 * Falls back to package.json's version when no argument is given (handy for a
 * manual `npm version` flow).
 */

import { readFileSync, writeFileSync } from "node:fs";

const targetVersion =
  process.argv[2] ?? JSON.parse(readFileSync("package.json", "utf8")).version;

if (!/^\d+\.\d+\.\d+/.test(targetVersion)) {
  console.error(`version-bump: invalid version "${targetVersion}"`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

console.log(
  `version-bump: manifest.json + versions.json → ${targetVersion} (minAppVersion ${manifest.minAppVersion})`,
);
