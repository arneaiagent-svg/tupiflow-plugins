// telegram — registry plugin port of plugins/telegram from the tupiflow
// first-party tree. Surface is intentionally minimal: integration spec,
// send-reply step, send-reply tool, webhook route. Full feature parity
// (chat-takeover suppression, thread persistence, attachment ingestion,
// long-poll connection lifecycle, telemetry) is blocked on host-api
// surface that does not yet exist — see README for the gap list.

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

import { runSendReply, type SendReplyInput } from "./send-reply.ts";
import { makeWebhookHandler } from "./webhook.ts";

const SEND_REPLY_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    botToken: {
      type: "string",
      description:
        "Telegram bot token. Until host-api fetchCredentials lands, pass it on the input.",
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
  required: ["text", "integrationId", "botToken"],
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

  api.registerRoute(
    "POST",
    "/webhook",
    makeWebhookHandler({ expectedSecret: process.env.TELEGRAM_WEBHOOK_SECRET })
  );
}
