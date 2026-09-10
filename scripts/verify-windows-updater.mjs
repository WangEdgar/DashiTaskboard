#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const updaterPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const latestPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const releaseTag = process.argv[4]?.trim();
if (!updaterPath || !latestPath || !releaseTag) {
  throw new Error(
    "Usage: verify-windows-updater.mjs <package.nsis.zip> <latest.json> <release-tag>",
  );
}

const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const tauriConfig = JSON.parse(await readFile(
  path.join(projectRoot, "src-tauri", "tauri.conf.json"),
  "utf8",
));
const releaseRepository = process.env.GITHUB_REPOSITORY || "WangEdgar/DashiTaskboard";
const stableTag = `v${packageJson.version}`;
const betaPrefix = `${stableTag}-beta.`;
const betaNumber = releaseTag.startsWith(betaPrefix)
  ? releaseTag.slice(betaPrefix.length)
  : "";
if (releaseTag !== stableTag && !/^[1-9]\d*$/.test(betaNumber)) {
  throw new Error("Release tag does not match package.json version");
}
const releaseVersion = releaseTag.slice(1);

const signature = await readFile(`${updaterPath}.sig`, "utf8");
await verifyUpdaterSignature({
  publicKey: tauriConfig.plugins.updater.pubkey,
  artifactPath: updaterPath,
  signature,
});

const latest = JSON.parse(await readFile(latestPath, "utf8"));
if (latest.version !== releaseVersion) throw new Error("latest.json version is incorrect");
const expectedUrl = `https://github.com/${releaseRepository}/releases/download/${releaseTag}/${path.basename(updaterPath)}`;
const platform = latest.platforms?.["windows-x86_64"];
if (platform?.url !== expectedUrl || platform.signature !== signature) {
  throw new Error("latest.json windows-x86_64 updater entry is incorrect");
}

console.log(`Verified Windows x64 NSIS updater for ${releaseTag}`);
