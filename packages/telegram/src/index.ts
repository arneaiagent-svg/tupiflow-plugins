// telegram — SDK-based registry plugin port of plugins/telegram.
// Uses @chat-adapter/telegram + chat SDK for connection lifecycle,
// inbound message routing, and outbound replies.
//
// Webhook URL: /plugins/telegram/webhook/<integrationId>
// New in 0.4.5: chat-takeover gate, history persistence, telemetry,
// album batching, requiresHostRestart (SDK imports resolved at boot).
// Required npm deps: @chat-adapter/telegram, chat.

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

import {
  buildTelegramThreadJson,
  makeStartInstance,
} from "./connection.ts";
import { runSendReply, type SendReplyInput } from "./send-reply.ts";
import { testTelegram } from "./test.ts";
import { createInstanceRegistry, makeWebhookHandler } from "./webhook.ts";

const SEND_REPLY_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
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
          "Used to verify the X-Telegram-Bot-Api-Secret-Token header on inbound webhook requests. Auto-generated if left blank.",
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

  api.registerTestHandler(async ({ credentials }) => {
    return testTelegram({ TELEGRAM_BOT_API_KEY: credentials.TELEGRAM_BOT_API_KEY });
  });

  const registry = createInstanceRegistry();

  api.registerStep("telegramSendReplyStep", async (input: unknown) => {
    return runSendReply(input as SendReplyInput, { registry });
  });

  api.registerTool(
    "telegram_send_reply",
    SEND_REPLY_TOOL_INPUT_SCHEMA,
    async (input: unknown) => {
      const result = await runSendReply(input as SendReplyInput, { registry });
      if (!result.success) {
        throw new Error(result.error.message);
      }
      return result.data;
    }
  );

  api.registerConnection({
    startInstance: makeStartInstance({ api, registry }),
    buildThreadJson: buildTelegramThreadJson,
    replyActionId: "telegram/send-reply",
  });

  api.registerRoute(
    "POST",
    "/webhook/:integrationId",
    makeWebhookHandler({ api, registry })
  );
}
