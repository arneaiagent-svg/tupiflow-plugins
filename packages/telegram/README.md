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
  `https://api.telegram.org/bot<token>/sendMessage`, and by
  `startInstance`/`shutdown` to call `setWebhook`/`deleteWebhook`.
- `secrets.read` — bot token is read via `api.fetchCredentials`.
- `connection.lifecycle` + `workflow.dispatch` — Phase 4a.2 surface.

## Credentials

| Key | Purpose |
| --- | --- |
| `TELEGRAM_BOT_API_KEY` | Bot token from @BotFather. |
| `TELEGRAM_WEBHOOK_SECRET` | Secret used to verify inbound webhook headers. |

Keys are passed verbatim from the manifest's `[[credentials]]` block — no
normalization. The plugin reads `creds.TELEGRAM_BOT_API_KEY` directly.
This is the canonical contract for registry plugins; see
tupiflow-registry `docs/MANIFEST.md` for the resolver rule.

## Webhook URL registration

`startInstance` auto-registers the inbound webhook URL with telegram-api
when `TUPIFLOW_PUBLIC_BASE_URL` (or `BETTER_AUTH_URL`) is set on the
tupiflow host. The URL is `<base>/plugins/telegram/webhook/<integrationId>`
and the configured webhook secret is forwarded as `secret_token`.
`shutdown` calls `deleteWebhook` so a removed integration stops receiving
upstream pushes.

When neither env var is set (air-gapped deployments), `startInstance`
logs a warning and skips the call — operators then run `setWebhook`
themselves against `<host>/plugins/telegram/webhook/<integrationId>`.

## Build

```bash
pnpm -F @tupiflow-plugins/telegram build
```

Output in `dist/`: `bundle.mjs`, `manifest.json`, `icon.svg`,
`bundle.tgz`.

## Host-API gaps (still open)

1. ~~Connection lifecycle~~ — closed in Phase 4a.2.
2. ~~Trigger dispatch~~ — closed in Phase 4a.2.
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
