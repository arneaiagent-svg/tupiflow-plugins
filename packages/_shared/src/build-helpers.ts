// Shared plugin build helper.
//
// Replaces the per-package copy of build.mjs that the standalone
// hello-plugin repo carries. Each package's build.mjs is now a thin
// wrapper that supplies its actions/routes/etc and lets this helper
// drive esbuild + manifest + tar.
//
// TODO: introspect the bundle via sandboxed import to enumerate
// registerIntegration / registerStep / registerTool / registerRoute
// calls automatically (see tupiflow-registry/docs/PUBLISH.md step 5).
// Until then, callers pass actions/routes explicitly.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parse as parseToml } from "toml";

import type {
  Manifest,
  ManifestAction,
  ManifestCredential,
  ManifestRequiredExtension,
  ManifestRoute,
  ManifestSchemaBlock,
} from "./manifest-types.ts";

export type BuildPluginOptions = {
  root: string;
  srcEntry: string;
  distDir: string;
  actions: ManifestAction[];
  routes?: ManifestRoute[];
  credentials?: ManifestCredential[];
  schema?: ManifestSchemaBlock;
  /**
   * SQL migration files to include in the tarball. Paths relative to `root`.
   * Each path is also recorded in `manifest.schema.migrations` when present.
   */
  migrations?: string[];
  /**
   * Postgres extensions the plugin requires. Emitted as
   * `manifest.requiredExtensions` for the customer-side installer's
   * `CREATE EXTENSION IF NOT EXISTS` pre-step. v1 allowlist enforced by the
   * registry validator: `pgvector`, `timescaledb`, `timescaledb_toolkit`.
   */
  requiredExtensions?: ManifestRequiredExtension[];
};

export type BuildPluginResult = {
  manifest: Manifest;
  bundleTgzPath: string;
  manifestPath: string;
};

type PluginToml = {
  identity: {
    name: string;
    type: string;
    version: string;
    publisher: string;
    description: string;
  };
  runtime: {
    min_tupiflow_version: string;
    max_tupiflow_version?: string;
  };
  icon?: { kind: "svg"; path: string } | { kind: "lucide"; name: string };
  capabilities?: string[];
};

export async function buildPlugin(
  opts: BuildPluginOptions
): Promise<BuildPluginResult> {
  const { root, srcEntry, distDir, actions } = opts;

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const bundlePath = resolve(distDir, "bundle.mjs");
  await build({
    entryPoints: [resolve(root, srcEntry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: bundlePath,
    legalComments: "none",
    logLevel: "info",
  });

  const tomlSrc = await readFile(resolve(root, "plugin.toml"), "utf8");
  const toml = parseToml(tomlSrc) as PluginToml;

  const tarEntries: string[] = ["manifest.json", "bundle.mjs"];

  if (toml.icon?.kind === "svg") {
    const iconSrc = resolve(root, toml.icon.path);
    const iconDst = resolve(distDir, "icon.svg");
    await copyFile(iconSrc, iconDst);
    tarEntries.push("icon.svg");
  }

  if (opts.migrations && opts.migrations.length > 0) {
    await mkdir(resolve(distDir, "migrations"), { recursive: true });
    for (const m of opts.migrations) {
      const dst = resolve(distDir, m);
      await mkdir(resolve(dst, ".."), { recursive: true });
      await copyFile(resolve(root, m), dst);
      tarEntries.push(m);
    }
  }

  const bundleBytes = await readFile(bundlePath);
  const bundleMjsSha = createHash("sha256").update(bundleBytes).digest("hex");

  const icon =
    toml.icon?.kind === "svg"
      ? { kind: "svg" as const, path: "icon.svg" }
      : toml.icon?.kind === "lucide"
        ? { kind: "lucide" as const, name: toml.icon.name }
        : undefined;

  const runtime: Manifest["runtime"] = {
    minTupiflowVersion: toml.runtime.min_tupiflow_version,
    ...(toml.runtime.max_tupiflow_version
      ? { maxTupiflowVersion: toml.runtime.max_tupiflow_version }
      : {}),
  };

  const manifest: Manifest = {
    identity: {
      name: toml.identity.name,
      type: toml.identity.type,
      version: toml.identity.version,
      publisher: toml.identity.publisher,
      description: toml.identity.description,
    },
    runtime,
    entrypoint: "bundle.mjs",
    ...(icon ? { icon } : {}),
    ...(opts.schema ? { schema: opts.schema } : {}),
    capabilities: toml.capabilities ?? [],
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
    actions,
    ...(opts.routes ? { routes: opts.routes } : {}),
    ...(opts.requiredExtensions && opts.requiredExtensions.length > 0
      ? { requiredExtensions: opts.requiredExtensions }
      : {}),
    bundle: {
      // Provisional values; patched after tar below. Server is authoritative.
      // sizeBytes is a non-zero placeholder so the embedded-in-tarball
      // manifest matches the standalone hello-plugin build for byte parity.
      sha256: bundleMjsSha,
      sizeBytes: 1,
    },
  };

  const manifestPath = resolve(distDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const tgzPath = resolve(distDir, "bundle.tgz");
  execFileSync(
    "tar",
    ["-czf", tgzPath, "-C", distDir, ...tarEntries],
    { stdio: "inherit" }
  );

  const tgzBytes = await readFile(tgzPath);
  manifest.bundle.sha256 = createHash("sha256").update(tgzBytes).digest("hex");
  manifest.bundle.sizeBytes = (await stat(tgzPath)).size;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(
    `${toml.identity.name}@${toml.identity.version}: bundle.tgz ${manifest.bundle.sizeBytes} bytes sha256 ${manifest.bundle.sha256}`
  );

  return { manifest, bundleTgzPath: tgzPath, manifestPath };
}
