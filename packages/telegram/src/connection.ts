import type {
  ConnectionInstance,
  PluginHostAPI,
} from "@tupiflow-plugins/shared/host-api-types";

import {
  type InstanceRegistry,
  type InstanceState,
  type TelegramUpdate,
  processTelegramUpdate,
} from "./webhook.ts";

export interface StartInstanceDeps {
  api: PluginHostAPI;
  registry: InstanceRegistry;
}

const TELEGRAM_API_ROOT = "https://api.telegram.org";
const POLL_TIMEOUT_SECONDS = 25;
const POLL_BACKOFF_MS = 5000;

function webhookUrlFor(baseUrl: string, integrationId: string): string {
  return `${baseUrl}/plugins/telegram/webhook/${integrationId}`;
}

async function callTelegramApi(
  api: PluginHostAPI,
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  init?: { signal?: AbortSignal }
): Promise<{ ok: boolean; description?: string; result?: unknown }> {
  try {
    const response = await api.fetch(
      `${TELEGRAM_API_ROOT}/bot${botToken}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(init?.signal ? { signal: init.signal } : {}),
      }
    );
    let parsed: { ok?: boolean; description?: string; result?: unknown } = {};
    try {
      parsed = (await response.json()) as {
        ok?: boolean;
        description?: string;
        result?: unknown;
      };
    } catch {
      // Telegram occasionally returns non-JSON on transport-level errors;
      // treat as failure rather than throwing.
    }
    return {
      ok: response.ok && parsed.ok !== false,
      description: parsed.description,
      result: parsed.result,
    };
  } catch (error) {
    return {
      ok: false,
      description: error instanceof Error ? error.message : String(error),
    };
  }
}

interface PollingHandle {
  stop(): Promise<void>;
}

function startPolling(args: {
  api: PluginHostAPI;
  integrationId: string;
  botToken: string;
  state: InstanceState;
}): PollingHandle {
  const { api, integrationId, botToken, state } = args;
  const controller = new AbortController();
  let offset = 0;
  let stopped = false;

  const loop = (async () => {
    api.logger.info("telegram polling started", { integrationId });
    while (!stopped) {
      const result = await callTelegramApi(
        api,
        botToken,
        "getUpdates",
        {
          offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message", "edited_message", "channel_post"],
        },
        { signal: controller.signal }
      );
      if (stopped) {
        break;
      }
      if (!result.ok) {
        api.logger.warn("telegram getUpdates failed", {
          integrationId,
          description: result.description,
        });
        // Sleep with abort awareness so shutdown returns promptly.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, POLL_BACKOFF_MS);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true }
          );
        });
        continue;
      }
      const updates = Array.isArray(result.result)
        ? (result.result as TelegramUpdate[])
        : [];
      for (const update of updates) {
        if (typeof update.update_id === "number") {
          offset = Math.max(offset, update.update_id + 1);
        }
        try {
          await processTelegramUpdate({ api }, integrationId, state, update);
        } catch (error) {
          api.logger.warn("telegram processTelegramUpdate failed", {
            integrationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    api.logger.info("telegram polling stopped", { integrationId });
  })();

  return {
    stop: async () => {
      stopped = true;
      controller.abort();
      try {
        await loop;
      } catch {
        // loop swallows its own errors; abort-on-pending-fetch may surface
        // here as an AbortError. Either way we're done.
      }
    },
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

    const state: InstanceState = { webhookSecret, botUsername };
    registry.set(integrationId, state);

    // Auto-register the webhook URL with telegram-api when `publicBaseUrl`
    // is HTTPS. Telegram rejects non-HTTPS webhook URLs, so fall back to
    // long-poll `getUpdates` when no usable base URL is available or when
    // setWebhook fails for any reason.
    const baseUrl = api.publicBaseUrl;
    const baseUrlIsHttps =
      typeof baseUrl === "string" && baseUrl.startsWith("https://");
    let webhookAutoRegistered = false;
    let polling: PollingHandle | null = null;

    if (baseUrlIsHttps) {
      const url = webhookUrlFor(baseUrl, integrationId);
      const result = await callTelegramApi(api, botToken, "setWebhook", {
        url,
        ...(webhookSecret ? { secret_token: webhookSecret } : {}),
      });
      if (result.ok) {
        webhookAutoRegistered = true;
        api.logger.info("telegram setWebhook ok", { integrationId, url });
      } else {
        api.logger.warn(
          "telegram setWebhook failed — falling back to polling",
          { integrationId, url, description: result.description }
        );
      }
    } else if (baseUrl) {
      api.logger.warn(
        "telegram publicBaseUrl is not HTTPS — falling back to polling",
        { integrationId, baseUrl }
      );
    } else {
      api.logger.warn(
        "telegram publicBaseUrl unset — falling back to polling",
        { integrationId }
      );
    }

    if (!webhookAutoRegistered) {
      // Clear any existing webhook before polling — Telegram refuses
      // getUpdates while a webhook is configured.
      const cleared = await callTelegramApi(api, botToken, "deleteWebhook", {});
      if (!cleared.ok) {
        api.logger.warn(
          "telegram deleteWebhook before polling failed (continuing)",
          { integrationId, description: cleared.description }
        );
      }
      polling = startPolling({ api, integrationId, botToken, state });
    }

    api.logger.info("telegram connection started", {
      integrationId,
      hasWebhookSecret: webhookSecret.length > 0,
      webhookAutoRegistered,
      polling: polling !== null,
    });

    return {
      integrationId,
      handle: {
        botToken,
        webhookSecret,
        botUsername,
        webhookAutoRegistered,
        polling: polling !== null,
      },
      shutdown: async () => {
        registry.delete(integrationId);
        if (polling) {
          await polling.stop();
        }
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
