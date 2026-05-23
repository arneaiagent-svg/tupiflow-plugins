# tupiflow-plugins

First-party tupiflow plugins (public). Published to
[`registry.falsesilver.id`](https://registry.falsesilver.id) under
`publisher = "tupiflow"`.

## Packages

- `packages/_shared` — types, host-api shim, build helpers (workspace-internal).
- `packages/hello-plugin` — minimal proof-of-life plugin. Canonical
  authoring template for new packages.

## Related

- [tupiflow](https://github.com/arneaiagent-svg/tupiflow) — the host runtime.
- [tupiflow-registry](https://github.com/arneaiagent-svg/tupiflow-registry) — the registry server + CLI.
- [tupiflow-plugins-pro](https://github.com/arneaiagent-svg/tupiflow-plugins-pro) — private monorepo for commercial plugins.
- `tupiflow/docs/PLUGIN_TIERS.md` §4.1 — the monorepo strategy that
  defines this repo's role.

## Quick start

```bash
pnpm install
pnpm build        # builds every package (currently just hello-plugin)
pnpm check        # full gate: type-check, build, changeset status
```

## Adding a package

See `CLAUDE.md` for the current authoring flow.
