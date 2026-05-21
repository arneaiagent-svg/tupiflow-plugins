// Manifest types for tupiflow-registry plugin manifests.
//
// TODO: codegen these from tupiflow-registry/schema/manifest.schema.json
// once the codegen pipeline lands. Hand-written for now to keep the
// monorepo self-contained. Keep field set in lockstep with
// tupiflow-registry/docs/MANIFEST.md.

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
  bundle: ManifestBundle;
};
