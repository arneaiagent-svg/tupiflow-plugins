# telegram

Telegram bot integration ported from the tupiflow first-party tree
(`tupiflow/plugins/telegram/`) to the registry plugin format.

This port targets the smallest viable shape: integration spec +
send-reply step + webhook route. Feature parity with the first-party
source is gated on host-api surface that does not yet exist — see
"Host-API gaps" below.

## What it registers

- Integration `telegram` with three form fields (bot token, bot
  username, webhook secret).
- One action `send-reply` (step `telegramSendReplyStep`, tool
  `telegram_send_reply`). Posts text to a Telegram chat via the Bot
  API, supports inline_keyboard buttons and blank-line bubble splitting.
- One route `POST /webhook` that verifies the
  `X-Telegram-Bot-Api-Secret-Token` header (constant-time) and returns
  `{ok:true}`.

## Capabilities

- `net.fetch` — used by the send-reply step to call
  `https://api.telegram.org/bot<token>/sendMessage`.

`secrets.read` is intentionally **not** declared yet. While the shim
now types `fetchCredentials` after Phase 4a.1, this port still accepts
`botToken` on the step input as the M3a wire-through workaround. Add
`secrets.read` and switch to `api.fetchCredentials` together once the
wire format change is acceptable.

## Credentials

| Key | Purpose |
| --- | --- |
| `TELEGRAM_BOT_API_KEY` | Bot token from @BotFather. |
| `TELEGRAM_WEBHOOK_SECRET` | Secret used to verify inbound webhook headers. |

## Build

```bash
pnpm -F @tupiflow-plugins/telegram build
```

Output in `dist/`: `bundle.mjs`, `manifest.json`, `icon.svg`,
`bundle.tgz`.

## Host-API gaps (block full parity, deferred to PLUGIN_TIERS Phase 4)

1. Connection lifecycle (`startInstance`, `shutdown`,
   `webhookHandler`, `buildThreadJson`) — the first-party plugin owns
   a long-lived Telegram adapter (`@chat-adapter/telegram`) plus a
   `Chat` from the `chat` library. The host-api has no equivalent
   surface for long-lived per-integration handles. Phase 4a.2.
2. Trigger dispatch (`dispatchToWorkflow(event)`) — the webhook route
   currently 200s the payload but cannot kick off a workflow run.
   Phase 4a.2.
3. Chat takeover gate (`getHumanControl(integrationId, threadId)`) —
   not in the shim. The port drops the suppression branch.
4. Per-thread persistence (`appendThreadMessages`,
   `notifyMessageAppended`, `@chat-adapter/state-pg`) — the shim now
   types `api.db.read/write` after Phase 4a.1, but the chat-adapter
   wiring still has to be ported.
5. Attachment ingestion (image / file / audio / video data URLs) —
   relies on the adapter `fetchData` callback. Port drops it.
6. Telemetry (`record("tlm_connection_events", ...)`) — no host-api
   surface for plugin telemetry.

Phase 4a.1 closed the `RouteContext.req` gap: the webhook handler is
now typed directly as `RouteHandler` and reads `ctx.req.header(...)` /
`ctx.req.json()` without any local cast.

## Tests

`pnpm -F @tupiflow-plugins/telegram test` runs the Node `--test`
suite under `tests/`. Covers the send-reply step against a stubbed
`fetch` and the webhook handler against a stubbed `RouteContext`.
