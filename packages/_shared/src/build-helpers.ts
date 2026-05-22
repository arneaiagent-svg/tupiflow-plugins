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

import type { WorkerSpec } from "./host-api-types.ts";
import type {
  Manifest,
  ManifestAction,
  ManifestCredential,
  ManifestRequiredExtension,
  ManifestRoute,
  ManifestSchemaBlock,
} from "./manifest-types.ts";

/**
 * §4f batch 1 — Blessed host-provided npm modules. Every name listed here is
 * guaranteed to be importable from the customer's tupiflow host installation
 * at a version satisfying the declared semver range. `buildPlugin` marks each
 * entry `external` in BOTH the main esbuild call and every worker esbuild
 * call so bundles stay small without forcing plugin authors to vendor common
 * deps.
 *
 * Versions mirror the tupiflow host `package.json` (verified at build of the
 * shim — see Phase 4f design §"Blessed module versioning"). Removing or
 * narrowing an entry is a breaking change for the shim; ship behind a major
 * `_shared` bump. Adding a new entry is non-breaking.
 *
 * NOT included: heavy parsing libs (jsdom, @mozilla/readability, turndown,
 * pdf-parse, sharp, mammoth). Those land in Phase 4f batch 2 via the
 * `requiredNpmDeps` allowlist.
 */
export const BLESSED_HOST_MODULES = {
  zod: "^4.1.12",
  hono: "^4.12.17",
  "drizzle-orm": "^0.44.7",
  postgres: "^3.4.7",
  ai: "^6.0.175",
  "@ai-sdk/openai": "^3.0.61",
  "@ai-sdk/anthropic": "^3.0.75",
  "@ai-sdk/google": "^3.0.67",
  "@ai-sdk/groq": "^3.0.38",
  "@ai-sdk/mistral": "^3.0.35",
  canonicalize: "^3.0.0",
} as const;

const WORKER_ENTRY_RE = /^workers\/[a-zA-Z0-9_-]+\.mjs$/;

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
   * registry validator: `vector`, `timescaledb`, `timescaledb_toolkit`. These
   * are real Postgres extension names — pgvector ships as PG extension
   * `vector`.
   */
  requiredExtensions?: ManifestRequiredExtension[];
  /**
   * Custom SQL files to apply at install (instead of `schema.migrations`).
   * Paths relative to `root`. Each path MUST match
   * `^custom-sql/[0-9]{4,}_[a-z0-9_]+\.sql$` (registry schema regex).
   * Files are copied into `distDir/<path>` and added to the tarball; paths
   * are recorded on `manifest.customSql`. Plugins using this option MUST
   * include the `db.custom_sql` capability in `plugin.toml`.
   */
  customSql?: string[];
  /**
   * §4f batch 1 — Plugin-defined workers. Each entry is bundled into a
   * separate ESM file at `distDir/workers/<id>.mjs` (esbuild, target node20,
   * format esm) and added to the tarball alongside `bundle.mjs`. The blessed
   * host-module list is externalized in every worker bundle just like the
   * main bundle. `entry` is the SOURCE path relative to `root` (e.g.
   * `src/workers/extract-pdf.ts`); the output path is derived from `id`
   * (`workers/<id>.mjs`) and recorded verbatim on `manifest.workers[].entry`.
   * The `id` MUST match `/^[a-z0-9][a-z0-9-]*$/` and the derived output path
   * MUST match `^workers/[a-zA-Z0-9_-]+\.mjs$` (registry schema regex). The
   * source file MUST exist on disk before the worker build runs.
   *
   * Plugins declaring a non-empty `workers` MUST include the `worker.run`
   * capability in `plugin.toml` (registry allOf clause).
   */
  workers?: WorkerSpec[];
};

const CUSTOM_SQL_PATH_RE = /^custom-sql\/[0-9]{4,}_[a-z0-9_]+\.sql$/;
const WORKER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export type WorkerBuildOutput = {
  id: string;
  /** Absolute path of the built worker bundle on disk. */
  outPath: string;
};

export type BuildPluginResult = {
  manifest: Manifest;
  bundleTgzPath: string;
  manifestPath: string;
  /**
   * §4f batch 1 — one entry per worker built. Empty when `opts.workers` was
   * absent or empty.
   */
  workerOutputs: WorkerBuildOutput[];
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

  // §4f batch 1 — blessed host-provided modules are externalized in BOTH the
  // main bundle and every worker bundle. The host guarantees these resolve at
  // runtime from its own node_modules; plugins MUST NOT vendor them.
  const blessedExternals = Object.keys(BLESSED_HOST_MODULES);

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
    external: blessedExternals,
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

  if (opts.customSql && opts.customSql.length > 0) {
    if (!toml.capabilities?.includes("db.custom_sql")) {
      throw new Error(
        `buildPlugin: customSql is non-empty but plugin.toml capabilities does not include "db.custom_sql" (registry allOf clause will reject).`
      );
    }
    await mkdir(resolve(distDir, "custom-sql"), { recursive: true });
    for (const p of opts.customSql) {
      if (!CUSTOM_SQL_PATH_RE.test(p)) {
        throw new Error(
          `buildPlugin: customSql path "${p}" does not match registry regex ^custom-sql/[0-9]{4,}_[a-z0-9_]+\\.sql$`
        );
      }
      const dst = resolve(distDir, p);
      await mkdir(resolve(dst, ".."), { recursive: true });
      await copyFile(resolve(root, p), dst);
      tarEntries.push(p);
    }
  }

  // §4f batch 1 — build each declared worker as a separate ESM bundle.
  const workerOutputs: WorkerBuildOutput[] = [];
  const manifestWorkers: WorkerSpec[] = [];
  if (opts.workers && opts.workers.length > 0) {
    if (!toml.capabilities?.includes("worker.run")) {
      throw new Error(
        `buildPlugin: workers is non-empty but plugin.toml capabilities does not include "worker.run" (registry allOf clause will reject).`
      );
    }
    await mkdir(resolve(distDir, "workers"), { recursive: true });
    const seenIds = new Set<string>();
    for (const w of opts.workers) {
      if (!WORKER_ID_RE.test(w.id)) {
        throw new Error(
          `buildPlugin: worker id "${w.id}" does not match /^[a-z0-9][a-z0-9-]*$/ (registry schema regex).`
        );
      }
      if (seenIds.has(w.id)) {
        throw new Error(
          `buildPlugin: duplicate worker id "${w.id}" in opts.workers.`
        );
      }
      seenIds.add(w.id);

      const entrySrc = resolve(root, w.entry);
      try {
        await stat(entrySrc);
      } catch {
        throw new Error(
          `buildPlugin: worker "${w.id}" entry source not found on disk: ${w.entry}`
        );
      }

      const builtRel = `workers/${w.id}.mjs`;
      if (!WORKER_ENTRY_RE.test(builtRel)) {
        // Defensive: WORKER_ID_RE already enforces the chars; this guards a
        // future loosening of WORKER_ID_RE without a matching WORKER_ENTRY_RE
        // update.
        throw new Error(
          `buildPlugin: derived worker entry "${builtRel}" does not match registry regex ^workers/[a-zA-Z0-9_-]+\\.mjs$`
        );
      }
      const outPath = resolve(distDir, builtRel);
      await build({
        entryPoints: [entrySrc],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node20",
        outfile: outPath,
        external: blessedExternals,
        legalComments: "none",
        logLevel: "info",
      });

      workerOutputs.push({ id: w.id, outPath });
      manifestWorkers.push({
        id: w.id,
        entry: builtRel,
        ...(w.memLimitMb !== undefined ? { memLimitMb: w.memLimitMb } : {}),
        ...(w.timeoutMs !== undefined ? { timeoutMs: w.timeoutMs } : {}),
      });
      tarEntries.push(builtRel);
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
    ...(opts.customSql && opts.customSql.length > 0
      ? { customSql: opts.customSql }
      : {}),
    ...(manifestWorkers.length > 0 ? { workers: manifestWorkers } : {}),
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

  return {
    manifest,
    bundleTgzPath: tgzPath,
    manifestPath,
    workerOutputs,
  };
}
