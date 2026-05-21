import type {
  ConnectionInstance,
  PluginHostAPI,
} from "@tupiflow-plugins/shared/host-api-types";

import type { InstanceRegistry } from "./webhook.ts";

export interface StartInstanceDeps {
  api: PluginHostAPI;
  registry: InstanceRegistry;
}

const TELEGRAM_API_ROOT = "https://api.telegram.org";

function webhookUrlFor(baseUrl: string, integrationId: string): string {
  return `${baseUrl}/plugins/telegram/webhook/${integrationId}`;
}

async function callTelegramApi(
  api: PluginHostAPI,
  botToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; description?: string }> {
  const response = await api.fetch(
    `${TELEGRAM_API_ROOT}/bot${botToken}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  let parsed: { ok?: boolean; description?: string } = {};
  try {
    parsed = (await response.json()) as { ok?: boolean; description?: string };
  } catch {
    // Telegram occasionally returns non-JSON on transport-level errors; treat
    // as failure rather than throwing.
  }
  return {
    ok: response.ok && parsed.ok !== false,
    description: parsed.description,
  };
}

/**
 * Build the `startInstance` callback the host invokes for every active
 * telegram integration row (INSERT, UPDATE-after-shutdown, boot
 * reconciliation).
 *
 * Q5 (Phase 4a.2, resolved 2026-05-21): `startInstance` now auto-registers
 * the inbound webhook URL with telegram-api via `setWebhook`, using
 * `api.publicBaseUrl` to build the absolute callback. `shutdown` calls
 * `deleteWebhook` so a removed integration stops receiving inbound updates
 * upstream. The previous customer-run setWebhook script becomes optional —
 * use it only when `TUPIFLOW_PUBLIC_BASE_URL` / `BETTER_AUTH_URL` is unset
 * (air-gapped deployments).
 *
 * Q6 (Phase 4a.2, resolved 2026-05-21): credential keys are verbatim from
 * the manifest `[[credentials]].key` block. Telegram declares
 * `TELEGRAM_BOT_API_KEY`; the legacy `botToken` alias is gone.
 *
 * Behaviour vs first-party `tupiflow/plugins/telegram/connection.ts`:
 * - Fetches the bot token via `api.fetchCredentials` (instead of reading
 *   `config.botToken` directly).
 * - Caches the per-integration webhook secret + bot username in the
 *   plugin-local registry so the webhook route can authenticate inbound
 *   updates without touching credentials on every request.
 * - `shutdown` removes the registry entry and deregisters the upstream
 *   webhook. There is no long-poll loop to stop (the host's
 *   registry-port plugin runtime does not embed `@chat-adapter/telegram`).
 */
export function makeStartInstance(deps: StartInstanceDeps) {
  const { api, registry } = deps;
  return async function startInstance(args: {
    integrationId: string;
    config: Record<string, unknown>;
  }): Promise<ConnectionInstance> {
    const { integrationId, config } = args;

    // Verbatim credential key — Phase 4a.2 Q6 Convention X. Manifest
    // declares `TELEGRAM_BOT_API_KEY` under `[[credentials]]`; the host's
    // credential resolver returns it under exactly that name.
    const creds = await api.fetchCredentials(integrationId);
    const botToken = creds.TELEGRAM_BOT_API_KEY ?? "";
    if (!botToken) {
      throw new Error(
        `[telegram] integration ${integrationId} is missing TELEGRAM_BOT_API_KEY — set it on the integration credential.`
      );
    }

    const webhookSecret =
      typeof config.webhookSecret === "string" ? config.webhookSecret : "";
    const botUsername =
      typeof config.botUsername === "string" ? config.botUsername : "";

    registry.set(integrationId, { webhookSecret, botUsername });

    // Auto-register the webhook URL with telegram-api when `publicBaseUrl`
    // is available. Without it, fall back to the legacy customer-run
    // setWebhook flow — log a warning so the operator sees the gap.
    const baseUrl = api.publicBaseUrl;
    let webhookAutoRegistered = false;
    if (baseUrl) {
      const url = webhookUrlFor(baseUrl, integrationId);
      const result = await callTelegramApi(api, botToken, "setWebhook", {
        url,
        ...(webhookSecret ? { secret_token: webhookSecret } : {}),
      });
      if (result.ok) {
        webhookAutoRegistered = true;
        api.logger.info("telegram setWebhook ok", { integrationId, url });
      } else {
        api.logger.warn("telegram setWebhook failed", {
          integrationId,
          url,
          description: result.description,
        });
      }
    } else {
      api.logger.warn(
        "telegram publicBaseUrl unset — skipping setWebhook; run the customer-side setWebhook script manually",
        { integrationId }
      );
    }

    api.logger.info("telegram connection started", {
      integrationId,
      hasWebhookSecret: webhookSecret.length > 0,
      webhookAutoRegistered,
    });

    return {
      integrationId,
      handle: {
        botToken,
        webhookSecret,
        botUsername,
        webhookAutoRegistered,
      },
      shutdown: async () => {
        registry.delete(integrationId);
        if (webhookAutoRegistered) {
          const result = await callTelegramApi(
            api,
            botToken,
            "deleteWebhook",
            {}
          );
          if (!result.ok) {
            api.logger.warn("telegram deleteWebhook failed", {
              integrationId,
              description: result.description,
            });
          }
        }
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
