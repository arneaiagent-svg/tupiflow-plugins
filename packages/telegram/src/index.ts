// telegram — registry plugin port of plugins/telegram from the tupiflow
// first-party tree. Now wires the Phase 4a.2 connection lifecycle surface:
// `api.registerConnection` for startInstance / shutdown and
// `api.dispatchToWorkflow` for inbound message routing.
//
// Webhook URL moves to /plugins/telegram/webhook/<integrationId>. Customers
// must update their Telegram setWebhook call to the new path; see the
// per-plugin migration script (PLUGIN_TIERS.md Phase 3 step 6).

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

import {
  buildTelegramThreadJson,
  makeStartInstance,
} from "./connection.ts";
import { runSendReply, type SendReplyInput } from "./send-reply.ts";
import { createInstanceRegistry, makeWebhookHandler } from "./webhook.ts";

const SEND_REPLY_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    botToken: {
      type: "string",
      description:
        "Telegram bot token. Optional when running inside a registered connection — the step will fetchCredentials by integrationId.",
    },
    integrationId: {
      type: "string",
      description: "Integration ID the chat trigger emitted.",
    },
    text: {
      type: "string",
      description: "Reply text. Required and non-empty.",
    },
    chatId: {
      type: "string",
      description: "Fallback Telegram chat ID when no threadJson is provided.",
    },
    threadJson: {
      description:
        "Serialized thread emitted by the chat trigger. Object or JSON string.",
    },
    messageThreadId: {
      type: ["string", "number"],
      description: "Optional supergroup forum topic ID.",
    },
    buttons: {
      description:
        "Optional JSON array of {text,url} entries rendered as inline_keyboard. String or array.",
    },
    splitBubbles: {
      type: "string",
      description: "When 'on', splits text on blank lines and posts each chunk as its own message.",
    },
    bubbleDelayMs: {
      type: ["string", "number"],
      description: "Delay between bubbles in milliseconds when splitBubbles is on. Default 700.",
    },
  },
  required: ["text", "integrationId"],
  additionalProperties: false,
};

export function registerPlugin(api: PluginHostAPI): void {
  api.registerIntegration({
    type: "telegram",
    label: "Telegram",
    formFields: [
      {
        id: "botToken",
        label: "Bot Token",
        type: "password",
        placeholder: "123456:ABC-...",
        configKey: "botToken",
        envVar: "TELEGRAM_BOT_API_KEY",
        helpText: "Create a bot and get its token from @BotFather (https://t.me/BotFather).",
      },
      {
        id: "botUsername",
        label: "Bot Username (optional)",
        type: "text",
        placeholder: "my_bot",
        configKey: "botUsername",
        helpText: "The bot's @username without the leading @",
      },
      {
        id: "webhookSecret",
        label: "Webhook Secret (optional)",
        type: "password",
        placeholder: "Random secret for webhook validation",
        configKey: "webhookSecret",
        helpText:
          "Used to verify the X-Telegram-Bot-Api-Secret-Token header on inbound webhook requests.",
      },
    ],
    actions: [
      {
        slug: "send-reply",
        label: "Send Telegram Reply",
        description: "Reply to the incoming Telegram thread",
        category: "Telegram",
        stepFunction: "telegramSendReplyStep",
      },
    ],
  });

  api.registerStep("telegramSendReplyStep", async (input: unknown) => {
    return runSendReply(input as SendReplyInput);
  });

  // Default `replyActionId` (`telegram/send-reply`) matches the convention
  // `connection-dispatch-graph.ts` falls back to, so we also register the
  // step under that exact id for the auto-generated default workflow.
  api.registerStep("telegram/send-reply", async (input: unknown) => {
    // The default workflow binds { text, integrationId, threadJson } — the
    // shape `runSendReply` already accepts. The botToken slot is left blank;
    // a future revision will let send-reply call fetchCredentials internally
    // (mirrors first-party connection.ts:245 path).
    return runSendReply(input as SendReplyInput);
  });

  api.registerTool(
    "telegram_send_reply",
    SEND_REPLY_TOOL_INPUT_SCHEMA,
    async (input: unknown) => {
      const result = await runSendReply(input as SendReplyInput);
      if (!result.success) {
        throw new Error(result.error.message);
      }
      return result.data;
    }
  );

  // Phase 4a.2 — connection lifecycle + workflow dispatch.
  // Per-plugin instance registry holds webhook secret + bot username for
  // every active integration so the webhook route can authenticate without
  // re-reading credentials on every request.
  const registry = createInstanceRegistry();

  api.registerConnection({
    startInstance: makeStartInstance({ api, registry }),
    buildThreadJson: buildTelegramThreadJson,
    // omit replyActionId — `${integrationType}/send-reply` is the default and
    // matches what the first-party plugin already registers
    // (`tupiflow/plugins/telegram/connection.ts:582`).
  });

  api.registerRoute(
    "POST",
    "/webhook/:integrationId",
    makeWebhookHandler({ api, registry })
  );
}
