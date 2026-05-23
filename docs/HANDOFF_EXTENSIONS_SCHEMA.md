# Handoff — audit public-tier plugin migrations for `public.` references

## Goal

Companion to `tupiflow/HANDOFF_EXTENSIONS_SCHEMA.md`. Host is moving extension installs to a dedicated `extensions` schema. Plugin migrations will run with `SET LOCAL search_path = "plugin_<name>", extensions` (no `public`). Audit every public-tier plugin's migrations + customSql for explicit `public.*` references or implicit host-table dependencies.

## Why

Current `installer.ts:1064` sets `search_path = "plugin_<name>", public`. After the host change, plugins lose `public` from their migration path. Plugin migrations that wrote `public.vector(N)`, `public.tsvector`, or referenced host tables (`public.connections`, etc.) will break.

This handoff is a read-only audit + (if needed) a fix-up commit per affected plugin.

## Repo scope

`tupiflow-plugins` (public monorepo). Plugins to audit:
- `packages/hello-plugin` — minimal, probably nothing.
- `packages/telegram` — connection-lifecycle; check `migrations/` and `custom-sql/` if any.
- `packages/workflow-builder` — large; uses `api.db.write` against core `workflows` table BUT that's a host-DB write through `api.db.write`, not a migration-time reference. Audit migrations only.
- Any future port — `whatsapp`, `web-credentials`, `telemetry` (telemetry will need `extensions` references for `percentile_agg` etc.).

## Audit checklist per plugin

1. `grep -rn 'public\.' packages/<plugin>/migrations/ packages/<plugin>/custom-sql/ 2>/dev/null` — any explicit `public.*` references in migration SQL? Should be 0 hits.
2. `grep -rn 'CREATE TABLE\|ALTER TABLE' packages/<plugin>/migrations/` — any table refs without explicit schema? Default schema (first in search_path) is `plugin_<name>` so these target the plugin schema correctly. No change needed.
3. Telemetry-specific: `grep -rn 'percentile_agg\|toolkit\|cagg' packages/<plugin>/` — verify these reference unqualified extension-provided functions. Should work via `extensions` schema in path.
4. If `requiredExtensions` is declared in `plugin.toml`, verify the migration uses `vector(N)` / `tsvector` unqualified — not `public.vector(N)`.

## Files to touch (only if audit finds hits)

For each plugin whose migration uses `public.`:

| File | Change |
|---|---|
| `packages/<plugin>/migrations/*.sql` | Strip `public.` prefix from extension-type references. Replace `public.vector` → `vector`. |
| `packages/<plugin>/custom-sql/*.sql` | Same. |
| `packages/<plugin>/plugin.toml` | If you bumped a migration, bump plugin version (patch bump usually). |
| `packages/<plugin>/package.json` | Mirror version bump. |

If a migration referenced a HOST table in `public` (e.g. `SELECT FROM public.connections`), that's a deeper bug — plugin migrations shouldn't reach into host. Surface to user and stop; don't paper over.

## Acceptance criteria

- `grep -rn 'public\.' packages/*/migrations/ packages/*/custom-sql/` returns 0 hits across public monorepo.
- Each touched plugin builds cleanly (`pnpm -F @tupiflow-plugins/<plugin> build`).
- `pnpm check` green at repo root.
- For each plugin whose version bumped: include the version bump in the same commit as the migration edit (don't split).

## Out of scope

- The shim `_shared/` package — search_path semantics are host-side, not shim contract.
- Changing `requiredExtensions` allowlist (registry-side).
- Modifying any plugin's `plugin.toml` capabilities.
- Bumping plugins that have no `public.` reference (no version bump needed).

## Constraints

- DO NOT bump shim `_shared` version (no shim change here).
- DO NOT add `public` back to plugin search_path by writing a workaround migration that calls `SET LOCAL search_path` — installer owns that.
- Commit per plugin (one commit per affected plugin + version bump) so the reviewer can trace migration edits cleanly.

## Commit message template (per affected plugin)

```
fix(<plugin>): unqualified extension type refs after host schema move

Host migrated extensions from `public` to a dedicated `extensions`
schema (tupiflow/HANDOFF_EXTENSIONS_SCHEMA.md). Plugin migration
search_path now omits `public`. Migrations that used `public.vector(N)`
fail because the type is no longer in public.

Migration: strip `public.` prefix from extension-type references.
Plugin version bumped to <X.Y.Z>.
```
