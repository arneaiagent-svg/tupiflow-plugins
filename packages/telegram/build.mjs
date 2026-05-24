// Build script for telegram. Delegates to @tupiflow-plugins/shared's
// buildPlugin helper. The actions/routes/credentials set is supplied
// here because the helper does not yet sandbox-introspect the bundle
// (see TODO in build-helpers.ts).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlugin } from "@tupiflow-plugins/shared/build-helpers";

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Admin-UI form fields rendered when the operator configures a Telegram
// connection instance. Shape matches the legacy first-party plugin
// (plugins_bu/telegram/index.ts) so the host can hydrate
// IntegrationPlugin.formFields straight off manifest.json (Phase C).
const TELEGRAM_FORM_FIELDS = [
  {
    id: "botToken",
    label: "Bot Token",
    type: "password",
    configKey: "botToken",
    envVar: "TELEGRAM_BOT_API_KEY",
    placeholder: "123456:ABC-...",
    helpText: "Create a bot and get its token from ",
    helpLink: { text: "@BotFather", url: "https://t.me/BotFather" },
    required: true,
  },
  {
    id: "botUsername",
    label: "Bot Username (optional)",
    type: "text",
    configKey: "botUsername",
    placeholder: "my_bot",
    helpText: "The bot's @username without the leading @",
  },
  {
    id: "webhookSecret",
    label: "Webhook Secret (optional)",
    type: "password",
    configKey: "webhookSecret",
    placeholder: "Random secret for webhook validation",
    helpText: "Used if you configure a production webhook instead of polling",
  },
];

// Connection metadata mirrored from the legacy first-party plugin. The full
// triggerInputFields list (text/integrationId/threadId/channelId/userName/
// isDM/isMention/threadJson/imageUrls/fileUrls/audioUrls/videoUrls) is copied
// verbatim from plugins_bu/telegram/index.ts so admin UI dynamic-option
// dropdowns surface every field the runtime emits.
const TELEGRAM_CONNECTION = {
  triggerType: "Chat Message",
  triggerLabel: "Telegram Message",
  triggerIcon: "MessageCircle",
  supportsAttachments: true,
  triggerInputFields: [
    { field: "text", description: "Text of the incoming message" },
    { field: "integrationId", description: "Telegram integration ID" },
    { field: "threadId", description: "Telegram thread ID" },
    { field: "channelId", description: "Telegram channel ID" },
    { field: "userName", description: "Sender's display name" },
    { field: "isDM", description: "True if the message is a DM" },
    { field: "isMention", description: "True if the bot was @-mentioned" },
    { field: "threadJson", description: "Serialized thread for replies" },
    {
      field: "imageUrls",
      description: "Image attachments from the message (data URLs)",
    },
    {
      field: "fileUrls",
      description:
        "Document/file attachments from the message (data URLs, excludes images/audio/video)",
    },
    {
      field: "audioUrls",
      description:
        "Audio attachments from the message (voice notes, audio files; data URLs)",
    },
    {
      field: "videoUrls",
      description:
        "Video attachments from the message (mp4, webm, mov; data URLs). Requires a model that supports video input (e.g. Gemini).",
    },
  ],
};

await buildPlugin({
  root,
  srcEntry: "src/index.ts",
  distDir: resolve(root, "dist"),
  formFields: TELEGRAM_FORM_FIELDS,
  connection: TELEGRAM_CONNECTION,
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
  // Host-wired npm dep — `@chat-adapter/telegram` is loaded from the
  // tupiflow host's node_modules (bind-mounted) rather than bundled. The
  // host installer runs `pnpm add` for these entries before activating.
  // Version pin mirrors the host's own dependency in `tupiflow/package.json`.
  requiredNpmDeps: {
    "@chat-adapter/telegram": "^4.26.0",
  },
  // Signals that activation requires a host process restart so freshly
  // installed `requiredNpmDeps` can be loaded. See
  // HANDOFF_PLUGIN_RESTART_FLAG.md in the tupiflow repo for the host-side
  // contract.
  requiresHostRestart: true,
  watch,
});
