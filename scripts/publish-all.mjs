// publish-all — enumerates each package's dist/*.tgz and publishes via
// tfr for any version not already in the registry.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const packagesDir = path.join(rootDir, "packages");

// Default to the production registry unless overridden via env
const registryUrl = process.env.TUPIFLOW_REGISTRY_URL || "https://registry.falsesilver.id";
const token = process.env.TUPIFLOW_REGISTRY_TOKEN;

console.log(`Using registry URL: ${registryUrl}`);

if (!token) {
  console.warn("WARNING: TUPIFLOW_REGISTRY_TOKEN env variable is not set. Publishing might fail if not already authenticated.");
}

async function checkIsPublished(name, version) {
  const url = `${registryUrl}/v1/plugins/${encodeURIComponent(name)}/${encodeURIComponent(version)}/manifest`;
  try {
    const res = await fetch(url);
    if (res.status === 200) {
      return true;
    }
    if (res.status === 404) {
      return false;
    }
    throw new Error(`Unexpected status code: ${res.status} from ${url}`);
  } catch (err) {
    throw new Error(`Failed to query registry: ${err.message}`);
  }
}

async function main() {
  const dirs = fs.readdirSync(packagesDir);
  let failed = false;

  for (const dir of dirs) {
    const packagePath = path.join(packagesDir, dir);
    if (!fs.statSync(packagePath).isDirectory()) continue;

    const manifestPath = path.join(packagePath, "dist", "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      console.error(`[-] Failed to parse manifest for ${dir}: ${err.message}`);
      failed = true;
      continue;
    }

    const { name, version } = manifest.identity || {};
    if (!name || !version) {
      console.error(`[-] Manifest for ${dir} is missing identity.name or identity.version`);
      failed = true;
      continue;
    }

    const bundlePath = path.join(packagePath, "dist", "bundle.tgz");
    if (!fs.existsSync(bundlePath)) {
      console.error(`[-] Bundle file not found at ${bundlePath}`);
      failed = true;
      continue;
    }

    console.log(`Checking ${name}@${version}...`);
    try {
      const alreadyPublished = await checkIsPublished(name, version);
      if (alreadyPublished) {
        console.log(`[+] ${name}@${version} is already published.`);
        continue;
      }

      console.log(`[*] Publishing ${name}@${version} to registry...`);
      const cmd = `tfr publish --endpoint "${registryUrl}" --manifest "${manifestPath}" --bundle "${bundlePath}"`;
      console.log(`Running: ${cmd}`);

      execSync(cmd, { stdio: "inherit" });
      console.log(`[+] Successfully published ${name}@${version}`);
    } catch (err) {
      console.error(`[-] Failed processing ${name}@${version}: ${err.message}`);
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
