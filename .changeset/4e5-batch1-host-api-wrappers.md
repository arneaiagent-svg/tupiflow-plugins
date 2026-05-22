---
"@tupiflow-plugins/shared": minor
---

Phase 4e.5 batch 1 — add `opts.schema` arg to `api.db.{read,write}` and
seven new wrappers on `PluginHostAPI`:

- `api.workflow.create(spec)`
- `api.agents.list / create / update / delete`
- `api.integrations.list`
- `api.connections.types`

The publisher gate is the security boundary for all core-table writes
(no new capability strings). Default db schema remains `"plugin"`
(sandbox); third-party publishers calling `{schema: "public"}` are
rejected with `DbPublicSchemaPublisherDeniedError`.
