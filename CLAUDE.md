# Agent Instructions — tupiflow-plugins (public)

Monorepo for first-party tupiflow plugins published to the tupiflow
registry. Public source per PLUGIN_TIERS.md §4.1.

## Package layout

Each package under `packages/<name>/` follows the hello-plugin template.
See `packages/hello-plugin/` for reference.

## Adding a new package

1. `pnpm create-plugin <name>` (not yet implemented — for now, copy
   `packages/hello-plugin/` and edit).
2. Run `pnpm changeset` before commit if the package version should bump.
3. `pnpm -r --filter <name> build` to verify the bundle builds.
4. Manifest publisher must be `"tupiflow"`.

## Build + publish

- `pnpm build` builds every package (filter via pnpm if needed).
- `pnpm publish-all` publishes every bumped package to the registry via
  tupiflow-registry-cli.
- No GitHub Actions; use `scripts/check.sh` locally.

## Conventions

- pnpm only.
- Biome for lint/format (`pnpm dlx ultracite` if preferred — match
  tupiflow root).
- No emojis in code, docs, commit messages.
- No new .md files unless explicitly requested.
