# workflow-builder

First-party tupiflow plugin. Exposes the meta-actions an AI agent uses to
introspect this host: list/create/get/execute workflows, agents, actions,
integrations, connections, and tools. Also ships the
`request-human-takeover` takeover target consumed by chat-trigger
workflows.

Publisher: `tupiflow`. Capabilities: `takeover.register`,
`workflow.read`, `workflow.write`, `db.read`, `db.write`, `llm.call`,
`secrets.read`, `net.fetch`.

## Build

```bash
pnpm -F @tupiflow-plugins/workflow-builder build
```

Output lands in `packages/workflow-builder/dist/`:

- `bundle.mjs` — esbuilt ESM bundle of `src/index.ts`
- `manifest.json` — populated from `plugin.toml` + build-helper output
- `icon.svg` — copied verbatim
- `bundle.tgz` — tarball containing the above
