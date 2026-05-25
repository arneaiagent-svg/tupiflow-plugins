---
"@tupiflow-plugins/shared": minor
---

Phase 4e.5 batch 5b — mirror three new host `PluginHostAPI` surfaces and
extend `api.connections.sendReply` with structured `card` / `actions`
variants.

- `api.chat.{getHumanControl, appendThreadMessages, notifyMessageAppended}`
  — capabilities `chat.takeover.read` (read + notify) and
  `chat.history.write` (append). Persists messages to
  `connection_thread_history` and observes the human-takeover flag without
  importing bundled `#app/backend/...` modules. Required by connection
  plugins (telegram, whatsapp, discord, …) that need to coexist with the
  chat-takeover UX.
- `api.telemetry.record(metric, fields)` — capability `telemetry.write`.
  Writes a row into one of the closed `tlm_*` tables; host throws on
  unknown metric strings.
- `api.connections.shutdownPeer(integrationId)` — force-shutdown peer
  instances of the caller's own integration (e.g. after a token rotation
  or HMR leak). Plugin scope enforced by manifest integrationType +
  registered plugin name. No new capability beyond
  `connection.lifecycle`.
- `ConnectionSendReplySpec` widened to a discriminated union with
  explicit `?: never` exclusions for mutual exclusion of `text` / `card`
  / `actions`. `threadJson` is now OPTIONAL (host falls back to the
  active thread for the integration when unambiguous). New companion
  types: `ButtonSpec`, `CardSpec`, `ActionsSpec`, `ChatMessage`,
  `ChatMessageContentPart`.

Bumps `_shared` 0.15.0 → 0.16.0.
