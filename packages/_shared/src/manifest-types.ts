// Manifest types for tupiflow-registry plugin manifests.
//
// TODO: codegen these from tupiflow-registry/schema/manifest.schema.json
// once the codegen pipeline lands. Hand-written for now to keep the
// monorepo self-contained. Keep field set in lockstep with
// tupiflow-registry/docs/MANIFEST.md.

import type { WorkerSpec } from "./host-api-types.ts";

export type ManifestIdentity = {
  name: string;
  type: string;
  version: string;
  publisher: string;
  description: string;
};

export type ManifestRuntime = {
  minTupiflowVersion: string;
  maxTupiflowVersion?: string;
};

export type ManifestIconSvg = { kind: "svg"; path: string };
export type ManifestIconLucide = { kind: "lucide"; name: string };
export type ManifestIcon = ManifestIconSvg | ManifestIconLucide;

export type ManifestSchemaBlock = {
  namespace: string;
  migrations: string[];
};

export type ManifestCredential = {
  key: string;
  label: string;
  type: "password" | "text";
  helpText?: string;
};

/**
 * Admin-UI form field rendered when the operator configures a connection
 * instance (Phase B of the manifest-driven connection UX). Mirrors the
 * registry `formField` $def exactly — every regex constraint is enforced by
 * the registry Go validator at publish time. The host reads these out of
 * `manifest.json` and serialises them onto `IntegrationPlugin.formFields` so
 * the admin UI hydrates without bespoke per-plugin code.
 *
 * - `id` and `configKey` MUST match `/^[a-zA-Z][a-zA-Z0-9_]*$/`.
 * - `envVar` (when present) MUST match `/^[A-Z][A-Z0-9_]*$/`.
 */
export type ManifestFormField = {
  id: string;
  label: string;
  type: "text" | "password" | "number" | "boolean" | "select" | "template-input";
  configKey: string;
  envVar?: string;
  placeholder?: string;
  helpText?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  helpLink?: { text: string; url: string };
};

/**
 * Connection metadata for plugins that register a chat-style trigger via
 * `api.registerConnection` (Phase 4a.2 connection lifecycle). Required when
 * `capabilities` includes `connection.lifecycle` — the registry allOf clause
 * rejects publishes that omit `connection{}` while declaring the capability.
 *
 * - `triggerIcon` MUST match `/^[A-Z][a-zA-Z0-9]*$/` (lucide-react component
 *   name).
 * - `triggerInputFields[].field` MUST match `/^[a-zA-Z][a-zA-Z0-9_]*$/`.
 */
export type ManifestConnection = {
  triggerType: string;
  triggerLabel: string;
  triggerIcon: string;
  supportsAttachments?: boolean;
  triggerInputFields?: {
    field: string;
    description: string;
  }[];
};

export type ManifestActionTool = {
  name: string;
  description: string;
  inputSchemaJson: string;
};

export type ManifestAction = {
  slug: string;
  label: string;
  description?: string;
  category?: string;
  stepFunction: string;
  outputFields?: Array<{ field: string; description?: string }>;
  configFields?: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
    example?: string;
  }>;
  tool?: ManifestActionTool;
};

export type ManifestRoute = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handlerExport: string;
};

export type ManifestBundle = {
  sha256: string;
  sizeBytes: number;
};

/**
 * Takeover target the plugin registers via `api.registerTakeoverTarget`.
 * `actionId` is a plugin-namespaced step id (regex
 * `^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$`) that MUST match a registered step.
 * Required to be non-empty when `capabilities` includes
 * `takeover.register` (registry allOf enforces). See Phase 4e (tupiflow
 * docs/registry/PHASE_4E_SEEDED_HOST_API.md §4.2).
 */
export type ManifestTakeoverTarget = {
  actionId: string;
  label: string;
  description?: string;
};

/**
 * Full top-level dashboard page contributed by the plugin. Host mounts each
 * declared entry at /plugins/<pluginName><path> with a sidebar entry, fetches
 * the compiled frontend ESM at runtime (served by host backend from extracted
 * bundle storage), and mounts `componentExport` into the host React tree.
 *
 * Declaring a non-empty `Manifest.frontendRoutes` is a full-trust escalation
 * comparable to backend code execution — the plugin code runs with access to
 * host React context (auth cookies, hooks, atoms). The publisher-trust gate
 * at registry publish is the consent boundary; the operator's caps approval
 * dialog at install surfaces "this plugin renders frontend UI" as a row.
 *
 * Schema mirror: tupiflow-registry/internal/manifest/schema.json
 * `$defs.frontendRoute`. Registry-enforced constraints (carried as
 * plugin-author hints; the registry validator is authoritative):
 *  - `path`: 1..64 chars, MUST match `^/[a-z0-9][a-z0-9/_-]*$`.
 *  - `label`: 1..64 chars.
 *  - `icon` (optional): 1..64 chars, lucide-react component name
 *    (`^[A-Za-z][A-Za-z0-9]*$`).
 *  - `componentExport`: PascalCase identifier
 *    (`^[A-Z][A-Za-z0-9]*$`), 1..64 chars — named export from the bundle.
 *  - `bundleEntry`: 1..128 chars, MUST match
 *    `^frontend/[a-z0-9][a-z0-9/_-]*\.mjs$` (path-traversal defense at
 *    schema level; `buildPlugin` emits to this exact relative path).
 */
export type ManifestFrontendRoute = {
  path: string;
  label: string;
  icon?: string;
  componentExport: string;
  bundleEntry: string;
};

/**
 * Per-integration-row button + overlay contributed by the plugin. Host
 * renders each button alongside built-in row actions in the integrations
 * list; click opens an overlay mounting `componentExport` with row props
 * `{ integrationId, integrationType, integration }` injected by the host
 * runtime.
 *
 * Same full-trust posture as `ManifestFrontendRoute` — see above.
 *
 * Schema mirror: tupiflow-registry/internal/manifest/schema.json
 * `$defs.integrationRowAction`. Registry-enforced constraints (the
 * registry validator is authoritative):
 *  - `label`: 1..64 chars.
 *  - `icon` (optional): same lucide-name shape as `frontendRoute.icon`.
 *  - `componentExport`: PascalCase identifier, 1..64 chars.
 *  - `bundleEntry`: same `^frontend/...\.mjs$` shape as
 *    `frontendRoute.bundleEntry`.
 */
export type ManifestIntegrationRowAction = {
  label: string;
  icon?: string;
  componentExport: string;
  bundleEntry: string;
};

/**
 * Postgres extensions the plugin depends on. The customer-side installer runs
 * `CREATE EXTENSION IF NOT EXISTS <name>` per entry inside the install
 * transaction (defense-in-depth — extensions are pre-installed by the
 * operator). v1 allowlist (registry `manifest/schema.json`): `vector`,
 * `timescaledb`, `timescaledb_toolkit`. These are the real Postgres extension
 * names — the pgvector project installs as the literal PG name `vector`
 * (`pgvector` is the GitHub repo name, NOT the extension name). Names only —
 * never pin a version.
 */
export type ManifestRequiredExtension =
  | "vector"
  | "timescaledb"
  | "timescaledb_toolkit";

/**
 * Custom SQL files applied at install time, AFTER `requiredExtensions`
 * `CREATE EXTENSION` and INSTEAD OF `schema.migrations`. Use when the
 * migration needs to reference extension-owned types/operators that the
 * per-plugin `SET LOCAL search_path` cannot resolve (e.g. pgvector's
 * `public.vector(N)` type), declare extensions inline for self-contained
 * re-apply, or run otherwise unrestricted DDL (hypertables, CAGGs,
 * compression/retention policies).
 *
 * Paths are relative to the plugin root and MUST match the registry regex
 * `^custom-sql/[0-9]{4,}_[a-z0-9_]+\.sql$`. Statements inside the file are
 * split on the `--> statement-breakpoint` marker.
 *
 * Plugins declaring a non-empty `customSql` MUST include the `db.custom_sql`
 * capability (registry allOf clause).
 */
export type Manifest = {
  identity: ManifestIdentity;
  runtime: ManifestRuntime;
  entrypoint: string;
  icon?: ManifestIcon;
  schema?: ManifestSchemaBlock;
  capabilities: string[];
  credentials?: ManifestCredential[];
  formFields?: ManifestFormField[];
  connection?: ManifestConnection;
  actions: ManifestAction[];
  routes?: ManifestRoute[];
  requiredExtensions?: ManifestRequiredExtension[];
  customSql?: string[];
  /**
   * True when the plugin registers a dynamic tool-catalog contributor via
   * `api.registerToolCatalogContributor` (Phase 4e §2.4). The host
   * short-circuits non-contributor plugins during agent tool-list builds.
   * Absence is semantically equivalent to false; the registry schema does
   * NOT set a JSON-Schema default for this field — `json-schema-to-zod`
   * 2.x would translate `default` into a mutating Zod default which would
   * inject the field after parse and break the publish-time canonical-JSON
   * hash on the consumer side (signature verify would fail). Required to
   * be `true` when `capabilities` includes `tool-registry.contribute`
   * (registry allOf enforces).
   */
  toolCatalogContributor?: boolean;
  /**
   * Takeover targets the plugin registers via `api.registerTakeoverTarget`
   * (Phase 4e §2.5). Required to be non-empty when `capabilities`
   * includes `takeover.register` (registry allOf enforces).
   */
  takeoverTargets?: ManifestTakeoverTarget[];
  /**
   * Plugin-defined workers (Phase 4f batch 1). Each entry becomes a separate
   * ESM bundle under `workers/<id>.mjs`, built alongside the main bundle by
   * `buildPlugin`. The host's worker pool spawns these via `api.runTask(id,
   * input)`. Required to be non-empty when `capabilities` includes
   * `worker.run` (registry allOf enforces). See
   * tupiflow/docs/registry/PHASE_4F_PLUGIN_DEPS_AND_WORKERS.md for the
   * full design (isolation model, resource limits, capability gating).
   */
  workers?: WorkerSpec[];
  /**
   * Plugin-declared external npm dependencies (Phase 4f batch 2). Each key is
   * a package name the plugin imports but does NOT bundle; the build helper
   * auto-marks every declared name `external` in BOTH the main bundle and
   * every worker bundle (alongside `BLESSED_HOST_MODULES`). Values are npm
   * semver ranges (`^22.0.0`, `~0.5.0`, …) validated as parseable semver at
   * registry publish time.
   *
   * Install-time gate (host side): the installer resolves each declared name
   * from the host's `node_modules/` and compares the installed version
   * against the declared range. A missing or out-of-range module fails the
   * install with `MissingNpmDepError` BEFORE any plugin schema is created.
   *
   * Trust model: the shim no longer enforces a closed package-name allowlist.
   * The gate moved to the registry admin layer (only trusted publishers hold
   * a publish token; arbitrary callers cannot push manifests). The shim still
   * enforces npm's package-name FORMAT at build time
   * (`assertNpmPackageNameValid` — anti-injection / anti-path-traversal),
   * and the host installer still verifies presence + range on customer
   * boxes. Adding a heavy dep no longer requires a coordinated PR.
   *
   * Complements `BLESSED_HOST_MODULES`: blessed = always available + no
   * opt-in needed (zod, hono, drizzle-orm, …); `requiredNpmDeps` = opt-in
   * extras the host pnpm-adds at install time (jsdom, @mozilla/readability,
   * turndown, pdf-parse, sharp, mammoth, chat-adapter packages, …).
   * See PHASE_4F_PLUGIN_DEPS_AND_WORKERS.md batch 2.
   */
  requiredNpmDeps?: Record<string, string>;
  /**
   * Full top-level dashboard pages contributed by this plugin. Host mounts
   * each at `/plugins/<name><path>` and renders a sidebar entry. Optional;
   * absence means the plugin contributes no top-level frontend routes. Cap
   * at 8 entries enforced by registry schema (`frontendRoutes.maxItems`).
   *
   * Coordinate with `routes?: ManifestRoute[]` (Hono backend) for any API
   * endpoints the frontend needs to call. The two arrays are independent —
   * a plugin can declare backend routes without frontend, or vice versa.
   * Each entry's `bundleEntry` corresponds to a compiled ESM module emitted
   * under `dist/frontend/<sub>.mjs` by `buildPlugin`.
   */
  frontendRoutes?: ManifestFrontendRoute[];
  /**
   * Per-integration-row buttons + overlays contributed by this plugin.
   * Optional; absence means the plugin contributes no per-row UI. Cap at 8
   * entries enforced by registry schema (`integrationRowActions.maxItems`).
   * Each entry's `bundleEntry` shares the same emit convention as
   * `frontendRoutes` and may reuse the same compiled bundle if multiple
   * components are exported from one entry.
   */
  integrationRowActions?: ManifestIntegrationRowAction[];
  /**
   * Hint to the host install pipeline: when true, the host skips
   * activation after pnpm-add of requiredNpmDeps, marks the install row
   * pending_restart, and self-exits so the container restart policy
   * brings the process back. The boot reconciler activates
   * pending_restart rows.
   *
   * Set true when any requiredNpmDeps entry is consumed by host wiring
   * code (not lazy-imported by bundle.mjs) or is a native module with
   * .node bindings. Default false preserves the today-behavior of
   * immediate in-process activation.
   */
  requiresHostRestart?: boolean;
  bundle: ManifestBundle;
};
