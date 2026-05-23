// Build script for telegram. Delegates to @tupiflow-plugins/shared's
// buildPlugin helper. The actions/routes/credentials set is supplied
// here because the helper does not yet sandbox-introspect the bundle
// (see TODO in build-helpers.ts).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlugin } from "@tupiflow-plugins/shared/build-helpers";

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

await buildPlugin({
  root,
  srcEntry: "src/index.ts",
  distDir: resolve(root, "dist"),
  credentials: [
    {
      key: "TELEGRAM_BOT_API_KEY",
      label: "Bot Token",
      type: "password",
      helpText: "Create a bot via @BotFather and paste its token here.",
    },
    {
      key: "TELEGRAM_WEBHOOK_SECRET",
      label: "Webhook Secret",
      type: "password",
      helpText:
        "Random secret used to verify the X-Telegram-Bot-Api-Secret-Token header on inbound webhook requests.",
    },
  ],
  actions: [
    {
      slug: "send-reply",
      label: "Send Telegram Reply",
      description: "Reply to the incoming Telegram thread",
      category: "Telegram",
      stepFunction: "telegramSendReplyStep",
      outputFields: [
        { field: "messageId", description: "ID of the last posted message (final bubble)" },
        { field: "messageIds", description: "IDs of every posted message in order. Length matches bubbleCount." },
        { field: "bubbleCount", description: "How many Telegram messages were posted (1 unless splitBubbles is on)" },
        { field: "threadId", description: "ID of the thread replied to" },
      ],
      configFields: [
        {
          key: "text",
          label: "Reply Text",
          type: "template-textarea",
          required: true,
          example: "Hello from my workflow!",
        },
        {
          key: "chatId",
          label: "Fallback Chat (optional)",
          type: "select",
        },
        {
          key: "messageThreadId",
          label: "Forum Topic ID (optional)",
          type: "template-input",
        },
        {
          key: "buttons",
          label: "Inline Buttons (optional, JSON)",
          type: "template-textarea",
        },
        {
          key: "splitBubbles",
          label: "Split into multiple bubbles",
          type: "select",
        },
        {
          key: "bubbleDelayMs",
          label: "Delay between bubbles (ms)",
          type: "number",
        },
      ],
      tool: {
        name: "telegram_send_reply",
        description:
          "Reply to a Telegram thread via the Bot API. Supports inline_keyboard buttons and bubble splitting.",
        inputSchemaJson: JSON.stringify({
          type: "object",
          properties: {
            botToken: { type: "string" },
            integrationId: { type: "string" },
            text: { type: "string" },
            chatId: { type: "string" },
            threadJson: {},
            messageThreadId: { type: ["string", "number"] },
            buttons: {},
            splitBubbles: { type: "string" },
            bubbleDelayMs: { type: ["string", "number"] },
          },
          required: ["text", "integrationId"],
          additionalProperties: false,
        }),
      },
    },
  ],
  routes: [
    {
      method: "POST",
      path: "/webhook/:integrationId",
      handlerExport: "telegramWebhookHandler",
    },
  ],
  watch,
});
