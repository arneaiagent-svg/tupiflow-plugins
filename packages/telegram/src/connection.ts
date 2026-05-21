import type {
  ConnectionInstance,
  PluginHostAPI,
} from "@tupiflow-plugins/shared/host-api-types";

import type { InstanceRegistry } from "./webhook.ts";

export interface StartInstanceDeps {
  api: PluginHostAPI;
  registry: InstanceRegistry;
}

/**
 * Build the `startInstance` callback the host invokes for every active
 * telegram integration row (INSERT, UPDATE-after-shutdown, boot
 * reconciliation). The registry-port plugin is webhook-only: it does NOT
 * register a webhook URL with Telegram itself (unlike a long-poll setup);
 * customers run `setWebhook` against
 * `<host>/plugins/telegram/webhook/<integrationId>` per the Phase 4a.2
 * migration script.
 *
 * Behaviour vs first-party `tupiflow/plugins/telegram/connection.ts`:
 * - Fetches the bot token via `api.fetchCredentials` (instead of reading
 *   `config.botToken` directly).
 * - Caches the per-integration webhook secret + bot username in the
 *   plugin-local registry so the webhook route can authenticate inbound
 *   updates without touching credentials on every request.
 * - `shutdown` removes the registry entry. There is no long-poll loop to
 *   stop (the host's registry-port plugin runtime does not embed
 *   `@chat-adapter/telegram`).
 */
export function makeStartInstance(deps: StartInstanceDeps) {
  const { api, registry } = deps;
  return async function startInstance(args: {
    integrationId: string;
    config: Record<string, unknown>;
  }): Promise<ConnectionInstance> {
    const { integrationId, config } = args;

    // Pull the bot token through fetchCredentials so the audit log captures
    // every read (single secrets path per design §4 decision 7). The bot
    // token shape used to live on `config.botToken`; the credential record
    // keys on `botToken` or the canonical env `TELEGRAM_BOT_API_KEY`.
    const creds = await api.fetchCredentials(integrationId);
    const botToken = creds.botToken ?? creds.TELEGRAM_BOT_API_KEY ?? "";
    if (!botToken) {
      throw new Error(
        `[telegram] integration ${integrationId} is missing botToken; configure TELEGRAM_BOT_API_KEY on the integration credential.`
      );
    }

    const webhookSecret =
      typeof config.webhookSecret === "string" ? config.webhookSecret : "";
    const botUsername =
      typeof config.botUsername === "string" ? config.botUsername : "";

    registry.set(integrationId, { webhookSecret, botUsername });

    api.logger.info("telegram connection started", {
      integrationId,
      hasWebhookSecret: webhookSecret.length > 0,
    });

    return {
      integrationId,
      handle: { botToken, webhookSecret, botUsername },
      shutdown: async () => {
        registry.delete(integrationId);
        api.logger.info("telegram connection stopped", { integrationId });
      },
    };
  };
}

/**
 * Mirror of the first-party `buildTelegramThreadJson`. Used by chat-takeover
 * paths the host invokes outside the workflow trigger pipeline.
 */
export function buildTelegramThreadJson(
  chatId: string
): Record<string, unknown> | null {
  const trimmed = chatId.trim();
  if (!trimmed) {
    return null;
  }
  const normalised = trimmed.startsWith("telegram:")
    ? trimmed.slice("telegram:".length)
    : trimmed;
  const [rawChannel, rawTopic] = normalised.split(":", 2);
  const channelId = (rawChannel ?? "").trim();
  if (!channelId) {
    return null;
  }
  const trimmedTopic = rawTopic?.trim();
  const topic = trimmedTopic ? Number.parseInt(trimmedTopic, 10) : Number.NaN;
  const id = Number.isFinite(topic)
    ? `telegram:${channelId}:${topic}`
    : `telegram:${channelId}`;
  const isDM = !channelId.startsWith("-");
  return {
    _type: "chat:Thread",
    adapterName: "telegram",
    channelId,
    id,
    isDM,
  };
}
