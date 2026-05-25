import { randomBytes } from "node:crypto";

import type {
  ChatAttachment,
  ChatMessage,
  ChatMessageEvent,
  ConnectionInstance,
  PluginHostAPI,
} from "@tupiflow-plugins/shared/host-api-types";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type Attachment, type Message, type ThreadImpl } from "chat";
import { createPostgresState } from "@chat-adapter/state-pg";

import type { InstanceRegistry } from "./webhook.ts";

export interface StartInstanceDeps {
  api: PluginHostAPI;
  registry: InstanceRegistry;
}

/**
 * Resolve the webhook secret using a hybrid read pattern.
 * User-supplied (top-level config.webhookSecret from form field) takes
 * precedence. If absent, falls back to a prior auto-generated value stored
 * in pluginData.__autoWebhookSecret. If neither exists, generates a fresh
 * secret and persists it via api.connections.setOwnPluginData (which writes
 * to config.pluginData.__autoWebhookSecret).
 *
 * Must use setOwnPluginData rather than updateIntegrationConfig because
 * ensureWebhookSecret runs at boot via startInstance, which has no
 * request/step scope (no userId). setOwnPluginData is bound by plugin
 * name + integration type and requires no caller scope.
 */
export async function ensureWebhookSecret(args: {
  api: PluginHostAPI;
  integrationId: string;
  config: Record<string, unknown>;
}): Promise<string> {
  const { api, integrationId, config } = args;
  const supplied =
    typeof config.webhookSecret === "string" && config.webhookSecret
      ? config.webhookSecret
      : undefined;
  if (supplied) return supplied;

  const pluginData = config.pluginData as
    | Record<string, unknown>
    | undefined;
  const cached =
    pluginData &&
    typeof pluginData.__autoWebhookSecret === "string" &&
    pluginData.__autoWebhookSecret
      ? pluginData.__autoWebhookSecret
      : undefined;
  if (cached) return cached;

  const fresh = randomBytes(24).toString("hex");
  // Feature-detect the boot-scope-safe surface. Older tupiflow hosts
  // (pre-`api.connections.setOwnPluginData`) leave this method undefined;
  // calling it would throw a TypeError that masks the real compatibility
  // gap. The plugin's manifest gate (min_tupiflow_version) is the
  // canonical guard, but until the host adopts versioned API tags this
  // runtime check produces a self-describing error for fresh installs.
  const setOwn =
    api.connections && typeof api.connections.setOwnPluginData === "function"
      ? api.connections.setOwnPluginData.bind(api.connections)
      : undefined;
  if (!setOwn) {
    throw new Error(
      "telegram: host is missing api.connections.setOwnPluginData. " +
        "Upgrade tupiflow to the version that exposes this surface, or " +
        "provide a top-level config.webhookSecret to bypass auto-generation."
    );
  }
  await setOwn(integrationId, {
    pluginData: { __autoWebhookSecret: fresh },
  });
  return fresh;
}

/**
 * Transform an SDK Message into a ChatMessage for appendThreadMessages.
 * SDK Message has .text/.author; host ChatMessage needs content/role.
 */
function sdkMessageToChatMessage(message: Message): ChatMessage {
  return {
    content: message.text ?? "",
    role: "user",
  };
}

const ATTACHMENT_BYTE_CAPS: Record<string, number> = {
  image: 8 * 1024 * 1024,
  file: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  video: 20 * 1024 * 1024,
};

const DEFAULT_MIMES: Record<string, string> = {
  image: "image/jpeg",
  file: "application/octet-stream",
  audio: "audio/ogg",
  video: "video/mp4",
};

const MAX_PER_MESSAGE: Record<string, number> = {
  image: 4,
  file: 4,
  audio: 2,
  video: 2,
};

/**
 * Convert an SDK attachment to a data: URL ChatAttachment.
 * Fetches bytes via the SDK's authenticated pipeline, base64-encodes,
 * and returns a data: URL. Returns null if fetch fails, bytes empty,
 * or file exceeds per-type byte cap.
 */
async function toDataUrlAttachment(
  sdkAtt: Attachment,
  logger: PluginHostAPI["logger"]
): Promise<ChatAttachment | null> {
  const type = sdkAtt.type ?? "file";
  const maxBytes = ATTACHMENT_BYTE_CAPS[type] ?? ATTACHMENT_BYTE_CAPS.file;
  const defaultMime = DEFAULT_MIMES[type] ?? DEFAULT_MIMES.file;

  try {
    let buf: Buffer | undefined;
    if (sdkAtt.fetchData) {
      buf = await sdkAtt.fetchData();
    } else if (sdkAtt.data) {
      buf = Buffer.isBuffer(sdkAtt.data)
        ? sdkAtt.data
        : Buffer.from(await new Response(sdkAtt.data).arrayBuffer());
    }
    if (!buf || buf.byteLength === 0) return null;
    if (buf.byteLength > maxBytes) {
      logger.info("telegram attachment dropped: oversize", {
        type,
        size: buf.byteLength,
        maxBytes,
      });
      return null;
    }
    const mime = sdkAtt.mimeType || defaultMime;
    const url = `data:${mime};base64,${buf.toString("base64")}`;
    return {
      url,
      mediaType: mime,
      ...(sdkAtt.name ? { filename: sdkAtt.name } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Process all attachments from an SDK message into categorized
 * ChatAttachment arrays with data: URLs, respecting per-type caps.
 */
async function resolveAttachments(
  message: Message,
  logger: PluginHostAPI["logger"]
): Promise<{
  imageUrls: ChatAttachment[];
  fileUrls: ChatAttachment[];
  audioUrls: ChatAttachment[];
  videoUrls: ChatAttachment[];
}> {
  const imageUrls: ChatAttachment[] = [];
  const fileUrls: ChatAttachment[] = [];
  const audioUrls: ChatAttachment[] = [];
  const videoUrls: ChatAttachment[] = [];

  const buckets: Record<string, ChatAttachment[]> = {
    image: imageUrls,
    file: fileUrls,
    audio: audioUrls,
    video: videoUrls,
  };

  for (const att of message.attachments ?? []) {
    const type = att.type ?? "file";
    const bucket = buckets[type] ?? fileUrls;
    const max = MAX_PER_MESSAGE[type] ?? MAX_PER_MESSAGE.file;
    if (bucket.length >= max) continue;
    const resolved = await toDataUrlAttachment(att, logger);
    if (resolved) bucket.push(resolved);
  }

  return { imageUrls, fileUrls, audioUrls, videoUrls };
}

/**
 * Transform SDK thread + message into the ChatMessageEvent shape that
 * dispatchToWorkflow expects.
 *
 * SDK handlers receive (thread, message) as separate arguments.
 * This mapper bridges the two worlds:
 *   thread      → channelId, threadId, threadJson, isDM
 *   message     → text, userName
 *   caller flag → isMention (true only from onNewMention handler)
 *   attachments → categorized data: URL arrays
 */
function buildChatMessageEvent(
  integrationId: string,
  thread: ThreadImpl,
  message: Message,
  overrides: { isMention: boolean; isDM: boolean },
  attachments: {
    imageUrls: ChatAttachment[];
    fileUrls: ChatAttachment[];
    audioUrls: ChatAttachment[];
    videoUrls: ChatAttachment[];
  }
): ChatMessageEvent {
  const threadJson = thread.toJSON();
  const channelId = threadJson.channelId || thread.id;

  const userName =
    typeof message.author?.userName === "string"
      ? message.author.userName
      : typeof message.author?.userId === "string"
        ? message.author.userId
        : "";

  return {
    integrationId,
    text: message.text ?? "",
    threadJson,
    isDM: overrides.isDM,
    isMention: overrides.isMention,
    channelId,
    threadId: thread.id,
    userName,
    arrivalAt: Date.now(),
    ...attachments,
  };
}

async function dispatchInbound(args: {
  api: PluginHostAPI;
  integrationId: string;
  thread: ThreadImpl;
  message: Message;
  isMention: boolean;
  isDM: boolean;
}) {
  const { api, integrationId, thread, message, isMention, isDM } = args;

  await api.chat.appendThreadMessages(
    integrationId,
    thread.id,
    [sdkMessageToChatMessage(message)],
    undefined,
    thread.toJSON()
  );
  api.chat.notifyMessageAppended(
    integrationId,
    thread.id,
    sdkMessageToChatMessage(message)
  );
  api.telemetry.record("tlm_connection_events", {
    event: "message_in",
    integration_type: "telegram",
    integration_id: integrationId,
  });

  const attachments = await resolveAttachments(message, api.logger);
  const chatEvent = buildChatMessageEvent(
    integrationId,
    thread,
    message,
    { isMention, isDM },
    attachments
  );
  try {
    await api.dispatchToWorkflow(chatEvent);
  } catch (error) {
    api.logger.warn("telegram dispatchToWorkflow failed", {
      integrationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function makeStartInstance(deps: StartInstanceDeps) {
  const { api, registry } = deps;
  return async function startInstance(args: {
    integrationId: string;
    config: Record<string, unknown>;
  }): Promise<ConnectionInstance> {
    const { integrationId, config } = args;

    const creds = await api.fetchCredentials(integrationId);
    const botToken = creds.TELEGRAM_BOT_API_KEY ?? "";
    if (!botToken) {
      throw new Error(
        `[telegram] integration ${integrationId} is missing TELEGRAM_BOT_API_KEY`
      );
    }
    const chatDbUrl = process.env.CONNECTION_CHAT_DATABASE_URL;
    if (!chatDbUrl) {
      throw new Error("[telegram] CONNECTION_CHAT_DATABASE_URL is not set");
    }
    const secretToken = await ensureWebhookSecret({
      api,
      integrationId,
      config,
    });

    const botUsername =
      typeof config.botUsername === "string" ? config.botUsername : "";

    const adapter = createTelegramAdapter({
      botToken,
      mode: "auto",
      secretToken,
    });
    const state = createPostgresState({
      url: chatDbUrl,
      keyPrefix: `telegram:${integrationId}`,
    });
    const chat = new Chat({
      adapters: { telegram: adapter },
      state,
      concurrency: "queue",
      userName: botUsername,
    });

    chat.onNewMention(async (thread, message) => {
      if (await api.chat.getHumanControl(integrationId, thread.id)) return;
      thread.subscribe();
      await dispatchInbound({
        api,
        integrationId,
        thread: thread as unknown as ThreadImpl,
        message,
        isMention: true,
        isDM: false,
      });
    });
    chat.onDirectMessage(async (thread, message) => {
      if (await api.chat.getHumanControl(integrationId, thread.id)) return;
      thread.subscribe();
      await dispatchInbound({
        api,
        integrationId,
        thread: thread as unknown as ThreadImpl,
        message,
        isMention: false,
        isDM: true,
      });
    });
    chat.onSubscribedMessage(async (thread, message) => {
      if (await api.chat.getHumanControl(integrationId, thread.id)) return;
      await dispatchInbound({
        api,
        integrationId,
        thread: thread as unknown as ThreadImpl,
        message,
        isMention: false,
        isDM: false,
      });
    });

    await chat.initialize();
    api.telemetry.record("tlm_connection_events", {
      event: "connection_boot",
      integration_type: "telegram",
      integration_id: integrationId,
    });

    await api.connections.shutdownPeer(integrationId);

    const handle = {
      adapter,
      chat,
      integrationId,
      botUsername,
      webhookSecret: secretToken,
    };
    registry.set(integrationId, handle);

    return {
      integrationId,
      handle,
      shutdown: async () => {
        adapter.stopPolling();
        await chat.shutdown();
        registry.delete(integrationId);
        api.telemetry.record("tlm_connection_events", {
          event: "connection_disconnect",
          integration_type: "telegram",
          integration_id: integrationId,
        });
      },
    };
  };
}

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
