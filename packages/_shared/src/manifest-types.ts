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
  bundle: ManifestBundle;
};
