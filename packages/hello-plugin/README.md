# hello-plugin

Minimal proof-of-life plugin for tupiflow-registry. Registers one tool
and one route. No DB, no credentials, no capabilities.

This is the **canonical source** going forward. The standalone
[`github.com/arneaiagent-svg/hello-plugin`](https://github.com/arneaiagent-svg/hello-plugin)
repo is preserved as a tutorial reference — the M3a registry round-trip
was validated against the v0.1.0 artifact there. New versions ship from
this monorepo.

## Build

```bash
pnpm -F @tupiflow-plugins/hello-plugin build
```

Output lands in `packages/hello-plugin/dist/`:

- `bundle.mjs` — esbuilt ESM bundle of `src/index.ts`
- `manifest.json` — populated from `plugin.toml` + build-helper output
- `icon.svg` — copied verbatim
- `bundle.tgz` — tarball containing the above

## Publish

Publish wiring (`pnpm publish-all`) is stubbed until the first end-to-end
publish from the monorepo is wired up (probably alongside the telegram port).
For now, publish manually via tfr:

```bash
TUPIFLOW_REGISTRY_TOKEN=tfr_... \
  tfr publish \
    --manifest dist/manifest.json \
    --bundle dist/bundle.tgz
```
