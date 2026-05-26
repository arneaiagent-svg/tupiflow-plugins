// Build script for whatsapp. Delegates to @tupiflow-plugins/shared's
// buildPlugin helper. The connection/actions/routes/workers set is
// supplied here because the helper does not yet sandbox-introspect the
// bundle.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlugin } from "@tupiflow-plugins/shared/build-helpers";

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Connection metadata mirrored verbatim from the legacy bundled plugin
// (tupiflow/plugins/whatsapp/index.ts:39-67). supportsAttachments=false
// because the baileys adapter's postMessage silently drops file uploads;
// the takeover composer must refuse them rather than store a phantom
// message.
const WHATSAPP_CONNECTION = {
  triggerType: "Chat Message",
  triggerLabel: "WhatsApp Message",
  triggerIcon: "MessageCircle",
  supportsAttachments: false,
  triggerInputFields: [
    { field: "text", description: "Text of the incoming message" },
    { field: "integrationId", description: "WhatsApp integration ID" },
    { field: "threadId", description: "WhatsApp thread ID" },
    { field: "channelId", description: "WhatsApp channel (JID)" },
    { field: "userName", description: "Sender's display name" },
    { field: "isDM", description: "True if the message is a 1:1 DM" },
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
  formFields: [],
  connection: WHATSAPP_CONNECTION,
  credentials: [],
  actions: [
    {
      slug: "send-reply",
      label: "Send WhatsApp Reply",
      description: "Reply to the incoming WhatsApp thread",
      category: "WhatsApp",
      stepFunction: "whatsappSendReplyStep",
      outputFields: [
        {
          field: "messageId",
          description: "ID of the last posted message (final bubble)",
        },
        {
          field: "messageIds",
          description:
            "IDs of every posted message in order. Length matches bubbleCount.",
        },
        {
          field: "bubbleCount",
          description:
            "How many WhatsApp messages were posted (1 unless splitBubbles is on)",
        },
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
          label: "Chat ID (fallback)",
          type: "template-input",
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
    },
  ],
  routes: [
    {
      method: "GET",
      path: "/qr/:integrationId",
      handlerExport: "whatsappQrHandler",
    },
    {
      method: "POST",
      path: "/reset/:integrationId",
      handlerExport: "whatsappResetHandler",
    },
  ],
  workers: [
    {
      id: "whatsapp-qr-encode",
      entry: "src/workers/qr-encode.mjs",
      memLimitMb: 128,
      timeoutMs: 5000,
    },
  ],
  integrationRowActions: [
    {
      label: "QR / status",
      icon: "QrCode",
      componentExport: "WhatsappQrOverlay",
      bundleEntry: "frontend/qr-overlay.mjs",
    },
  ],
  requiredNpmDeps: {
    "chat-adapter-baileys": "^2.0.2",
    "chat": "^4.26.0",
  },
  requiresHostRestart: true,
  watch,
});
