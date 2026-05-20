// seed-snapshot — emits a JSON manifest of packages flagged as Tier 1
// seeded so the tupiflow image build can ingest them into
// docker/seeded-plugins.json.
//
// Shape:
//   { "seeded": [{ "name", "version", "source": "tupiflow-plugins" }] }
//
// A package opts into seeding by declaring `[registry] tier = "seeded"`
// in its plugin.toml. hello-plugin is community Tier 2 (per
// PLUGIN_TIERS.md §4.1) so the snapshot is currently empty. Future
// seeded packages: ai-providers, mcp, workflow-builder.

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "toml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = resolve(root, "packages");

const seeded = [];

const entries = await readdir(packagesDir, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  if (entry.name === "_shared") continue;

  const tomlPath = resolve(packagesDir, entry.name, "plugin.toml");
  if (!existsSync(tomlPath)) continue;

  const toml = parseToml(await readFile(tomlPath, "utf8"));
  if (toml.registry?.tier === "seeded") {
    seeded.push({
      name: toml.identity.name,
      version: toml.identity.version,
      source: "tupiflow-plugins",
    });
  }
}

process.stdout.write(`${JSON.stringify({ seeded }, null, 2)}\n`);
