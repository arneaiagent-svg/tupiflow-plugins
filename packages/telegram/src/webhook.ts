import type {
  PluginHostAPI,
  RouteHandler,
} from "@tupiflow-plugins/shared/host-api-types";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import type { Chat } from "chat";

const TELEGRAM_SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export interface TelegramInstance {
  adapter: TelegramAdapter;
  chat: Chat;
  integrationId: string;
  botUsername: string;
  webhookSecret: string;
}

export type InstanceRegistry = {
  get(integrationId: string): TelegramInstance | undefined;
  set(integrationId: string, instance: TelegramInstance): void;
  delete(integrationId: string): void;
};

export function createInstanceRegistry(): InstanceRegistry {
  const map = new Map<string, TelegramInstance>();
  return {
    get: (id) => map.get(id),
    set: (id, instance) => {
      map.set(id, instance);
    },
    delete: (id) => {
      map.delete(id);
    },
  };
}

export interface WebhookHandlerDeps {
  api: PluginHostAPI;
  registry: InstanceRegistry;
}

export function makeWebhookHandler(deps: WebhookHandlerDeps): RouteHandler {
  const { api, registry } = deps;
  return async (ctx) => {
    const integrationId = ctx.req.param("integrationId");
    if (!integrationId) {
      return ctx.json({ error: "missing integrationId" }, 400);
    }
    const handle = registry.get(integrationId);
    if (!handle) {
      api.logger.warn("telegram webhook for unknown integration", {
        integrationId,
      });
      return ctx.json({ ok: true });
    }
    if (!handle.webhookSecret) {
      api.logger.warn("telegram webhook rejected: no secret configured", {
        integrationId,
      });
      return ctx.json({ error: "Unauthorized" }, 401);
    }
    const headerValue = ctx.req.header(TELEGRAM_SECRET_TOKEN_HEADER);
    if (!headerValue || !constantTimeEquals(handle.webhookSecret, headerValue)) {
      return ctx.json({ error: "Unauthorized" }, 401);
    }

    try {
      await handle.chat.webhooks.telegram(ctx.req.raw);
    } catch (error) {
      api.logger.warn("telegram SDK webhook processing failed", {
        integrationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return ctx.json({ ok: true });
  };
}
