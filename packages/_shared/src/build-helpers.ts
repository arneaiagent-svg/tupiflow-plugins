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
  watch,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseToml } from "toml";

import type { WorkerSpec } from "./host-api-types.ts";
import type {
  Manifest,
  ManifestAction,
  ManifestConnection,
  ManifestCredential,
  ManifestFormField,
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

/**
 * §4f batch 2 — Closed allowlist of npm package names a plugin may declare in
 * `manifest.requiredNpmDeps`. Mirrors the registry-side Go allowlist byte-for-
 * byte; drift between the two is caught by
 * `tupiflow-registry/scripts/check-npm-allowlist.sh`.
 *
 * Distinct from `BLESSED_HOST_MODULES`: blessed modules are always available
 * to every plugin (no opt-in). `ALLOWED_NPM_DEPS` are opt-in heavy parsing
 * libs the host commits to providing when a plugin explicitly declares them
 * — the host installer verifies presence + semver range at install time, so
 * unused entries impose zero install-time cost on hosts.
 *
 * Adding a new entry requires a PR to BOTH this constant AND the registry Go
 * mirror, with a justification for why the dep can't be bundled. Native-
 * binding-heavy libs (canvas, unpdf, …) stay OUT — those route through the
 * sidecar mechanism (`PLUGIN_TIERS.md` §3 Amendment 2).
 */
export const ALLOWED_NPM_DEPS = [
  "jsdom",
  "@mozilla/readability",
  "turndown",
  "pdf-parse",
  "sharp",
  "mammoth",
] as const;

const WORKER_ENTRY_RE = /^workers\/[a-zA-Z0-9_-]+\.mjs$/;

export type BuildPluginOptions = {
  root: string;
  srcEntry: string;
  distDir: string;
  actions: ManifestAction[];
  routes?: ManifestRoute[];
  credentials?: ManifestCredential[];
  /**
   * Admin-UI form fields rendered when the operator configures a connection
   * instance. Emitted verbatim onto `manifest.formFields` (Phase B). The host
   * hydrates `IntegrationPlugin.formFields` from this block so the UI
   * renders without bespoke per-plugin code. Optional — omit (or pass `[]`)
   * for plugins that don't expose a connection-configuration form.
   */
  formFields?: ManifestFormField[];
  /**
   * Connection metadata (trigger type/label/icon, supportsAttachments,
   * triggerInputFields). Emitted verbatim onto `manifest.connection`. Required
   * by the registry allOf clause when `plugin.toml` capabilities include
   * `connection.lifecycle` — `buildPlugin` enforces this at build time so the
   * mistake surfaces before publish.
   */
  connection?: ManifestConnection;
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
  /**
   * §4f batch 2 — External npm deps the plugin imports but does NOT bundle.
   * Each declared name is validated against `ALLOWED_NPM_DEPS` at build time
   * (off-allowlist names throw before publish) and added to the esbuild
   * `external` list for BOTH the main bundle and every worker bundle
   * (alongside `BLESSED_HOST_MODULES`). Values are npm semver ranges
   * (`^22.0.0`, `~0.5.0`, …); the registry Go validator re-parses them at
   * publish. Recorded verbatim on `manifest.requiredNpmDeps`. The host
   * installer enforces presence + range at install time
   * (`MissingNpmDepError` on a mismatch).
   */
  requiredNpmDeps?: Record<string, string>;
  /**
   * Forwarded verbatim to manifest.requiresHostRestart. See
   * `manifest-types.ts` for semantics. Default false (omitted from
   * emitted manifest).
   */
  requiresHostRestart?: boolean;
  /**
   * When true, after the initial successful build, keep the process alive and
   * watch source directories for changes; rebuild on change (100ms debounce
   * coalesces editor-save bursts). Default false — single build + exit, no
   * behavioural change for existing callers. Rebuild errors are logged to
   * stderr without exiting. SIGINT/SIGTERM close watchers + exit cleanly.
   */
  watch?: boolean;
  /**
   * Explicit list of directories to watch (paths relative to `root` OR
   * absolute). When omitted, the watcher uses `dirname(srcEntry)` resolved
   * against `root` (typically `src/`). Workers with sources outside that dir
   * should pass an explicit list so their edits trigger rebuilds too. Each
   * dir is watched recursively (`{recursive: true}` — supported on macOS +
   * Windows + Linux >= Node 20). Ignored when `watch` is false/undefined.
   */
  watchDirs?: string[];
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
  takeoverTargets?: Array<{ actionId: string; label: string; description?: string }>;
};

export async function buildPlugin(
  opts: BuildPluginOptions
): Promise<BuildPluginResult> {
  const result = await runBuildOnce(opts);
  if (opts.watch === true) {
    await runWatchLoop(opts);
  }
  return result;
}

/**
 * Convention X — every `formField.envVar` MUST be declared in
 * `manifest.credentials[].key`.
 *
 * Plugin authors frequently declare a formField with an `envVar` ("X") but
 * forget to also declare `{ key: "X" }` in the credentials block. Without
 * this check the manifest ships with a credential the runtime emits but
 * never declares: manifest viewers, audit tools, and the host's
 * runtimeRegistry.manifestCredentialKeys list show INCOMPLETE data. Two
 * host-side bugs (helpers.ts `runtimeCredsFromConfig`, credential-fetcher.ts
 * `mapIntegrationConfig`) shipped in tupiflow because the saved-row path
 * read the configKey instead of the envVar; once those landed, plugins that
 * skip the credentials declaration "work" silently, which is worse — the
 * contract breaks without surfacing. Enforcing the declaration at build
 * time keeps the manifest honest.
 *
 * Reverse direction (manifest credentials without a formField) stays valid:
 * those are server-only creds (e.g. refresh tokens injected by the host),
 * so this helper does NOT check that direction.
 *
 * Exported so unit tests can exercise the predicate without spinning up a
 * full buildPlugin() invocation (which mkdirs, esbuilds, and tars).
 */
export function assertFormFieldEnvVarsDeclared(
  formFields: ManifestFormField[] | undefined,
  credentials: ManifestCredential[] | undefined
): void {
  if (!formFields || formFields.length === 0) return;
  const credentialKeys = new Set((credentials ?? []).map((c) => c.key));
  for (const ff of formFields) {
    if (typeof ff.envVar === "string" && ff.envVar.length > 0) {
      if (!credentialKeys.has(ff.envVar)) {
        throw new Error(
          `buildPlugin: formField "${ff.id}" declares envVar "${ff.envVar}" but no manifest credential declares that key. Add { key: "${ff.envVar}", label: "...", type: "..." } to the manifest's credentials list, or remove the envVar from the formField if no credential is meant.`
        );
      }
    }
  }
}

async function runBuildOnce(
  opts: BuildPluginOptions
): Promise<BuildPluginResult> {
  const { root, srcEntry, distDir, actions } = opts;

  // §4f batch 1 — blessed host-provided modules are externalized in BOTH the
  // main bundle and every worker bundle. The host guarantees these resolve at
  // runtime from its own node_modules; plugins MUST NOT vendor them.
  const blessedExternals = Object.keys(BLESSED_HOST_MODULES);

  // §4f batch 2 — validate + externalize plugin-declared npm deps. Validation
  // runs BEFORE rm/mkdir so a bad name fails the build without touching
  // distDir. Off-allowlist names fail loudly here so the publish-time
  // registry rejection never fires in practice.
  const npmDepExternals: string[] = [];
  if (opts.requiredNpmDeps) {
    const allowed = new Set<string>(ALLOWED_NPM_DEPS);
    for (const [name, range] of Object.entries(opts.requiredNpmDeps)) {
      if (!allowed.has(name)) {
        throw new Error(
          `buildPlugin: requiredNpmDeps entry "${name}" is not on the registry allowlist (ALLOWED_NPM_DEPS). Update both shim + registry Go allowlist to add it.`
        );
      }
      if (typeof range !== "string" || range.length === 0) {
        throw new Error(
          `buildPlugin: requiredNpmDeps["${name}"] must be a non-empty semver range string (got ${typeof range}).`
        );
      }
      npmDepExternals.push(name);
    }
  }
  const allExternals = [...blessedExternals, ...npmDepExternals];

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
    external: allExternals,
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

  if (opts.connection) {
    if (!toml.capabilities?.includes("connection.lifecycle")) {
      throw new Error(
        `buildPlugin: connection{} is set but plugin.toml capabilities does not include "connection.lifecycle" (registry allOf clause will reject).`
      );
    }
  }
  if (toml.capabilities?.includes("connection.lifecycle") && !opts.connection) {
    throw new Error(
      `buildPlugin: plugin.toml capabilities includes "connection.lifecycle" but no connection{} was passed to buildPlugin (registry allOf clause requires manifest.connection when the capability is declared).`
    );
  }

  // Convention X — formField.envVar MUST appear in manifest.credentials[].key.
  // See assertFormFieldEnvVarsDeclared() below for full rationale.
  assertFormFieldEnvVarsDeclared(opts.formFields, opts.credentials);

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
        external: allExternals,
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
    ...(opts.formFields && opts.formFields.length > 0
      ? { formFields: opts.formFields }
      : {}),
    ...(opts.connection ? { connection: opts.connection } : {}),
    actions,
    ...(opts.routes ? { routes: opts.routes } : {}),
    ...(opts.requiredExtensions && opts.requiredExtensions.length > 0
      ? { requiredExtensions: opts.requiredExtensions }
      : {}),
    ...(opts.customSql && opts.customSql.length > 0
      ? { customSql: opts.customSql }
      : {}),
    ...(manifestWorkers.length > 0 ? { workers: manifestWorkers } : {}),
    ...(opts.requiredNpmDeps && Object.keys(opts.requiredNpmDeps).length > 0
      ? { requiredNpmDeps: opts.requiredNpmDeps }
      : {}),
    ...(opts.requiresHostRestart ? { requiresHostRestart: true } : {}),
    ...(toml.takeoverTargets && toml.takeoverTargets.length > 0
      ? { takeoverTargets: toml.takeoverTargets }
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

  return {
    manifest,
    bundleTgzPath: tgzPath,
    manifestPath,
    workerOutputs,
  };
}

async function runWatchLoop(opts: BuildPluginOptions): Promise<void> {
  // Resolve watch dirs: explicit list wins, else dirname(srcEntry) under root.
  // Absolute paths pass through; relative paths resolve against root.
  const dirs =
    opts.watchDirs && opts.watchDirs.length > 0
      ? opts.watchDirs.map((d) => resolve(opts.root, d))
      : [resolve(opts.root, dirname(opts.srcEntry))];

  // Loop-avoidance: a watched dir equal to or ancestor of distDir would
  // re-fire on every build write and spin rebuilds forever.
  const resolvedDist = resolve(opts.root, opts.distDir);
  for (const dir of dirs) {
    const rel = relative(dir, resolvedDist);
    const isAncestorOrSelf =
      rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (isAncestorOrSelf) {
      throw new Error(
        `buildPlugin: watchDirs entry "${dir}" is equal to or an ancestor of distDir "${resolvedDist}"; watching it would trigger an infinite rebuild loop.`
      );
    }
  }

  // AbortController drives both the per-dir async iterators and the SIGINT/
  // SIGTERM cleanup path. Closing the controller terminates every watch()
  // iterator pending in the for-await loops below.
  const ac = new AbortController();
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    ac.abort();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Debounce: collapse editor-save bursts (vim/VS Code emit rename + change
  // back-to-back) into one rebuild. 100ms is enough for atomic-rename saves
  // without feeling laggy on single keystroke saves.
  let debounceTimer: NodeJS.Timeout | undefined;
  let rebuildInFlight = false;
  let rebuildQueued = false;

  const triggerRebuild = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void runRebuild();
    }, 100);
  };

  const runRebuild = async (): Promise<void> => {
    // Serialize rebuilds: if one is running, queue at most one follow-up so
    // bursts that arrive mid-rebuild don't stack indefinitely.
    if (rebuildInFlight) {
      rebuildQueued = true;
      return;
    }
    rebuildInFlight = true;
    try {
      console.log("[buildPlugin] rebuild: " + Date.now());
      await runBuildOnce(opts);
    } catch (err) {
      // Keep watching on error — author fixes the source, next save retries.
      console.error("[buildPlugin] rebuild failed:", err);
    } finally {
      rebuildInFlight = false;
      if (rebuildQueued) {
        rebuildQueued = false;
        triggerRebuild();
      }
    }
  };

  // Spawn one async iterator per watched dir. Each runs until ac.abort().
  // Promise.all keeps the function awaiting forever in steady state; SIGINT
  // shutdown() calls process.exit before any settles.
  const watchers = dirs.map(async (dir) => {
    try {
      const iter = watch(dir, { recursive: true, signal: ac.signal });
      for await (const _evt of iter) {
        triggerRebuild();
      }
    } catch (err) {
      // AbortError on shutdown is expected; anything else is a real failure
      // that must surface loudly (EACCES/EMFILE/…) instead of silently
      // disabling hot-reload.
      if ((err as { name?: string }).name !== "AbortError") {
        console.error(`[buildPlugin] watcher for ${dir} died:`, err);
        throw err;
      }
    }
  });

  console.log(
    "[buildPlugin] watch mode: " + dirs.join(", ") + " (Ctrl-C to exit)"
  );
  await Promise.all(watchers);
}
