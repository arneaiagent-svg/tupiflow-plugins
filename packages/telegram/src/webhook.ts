import type {
  ChatAttachment,
  ChatMessageEvent,
  PluginHostAPI,
  RouteHandler,
} from "@tupiflow-plugins/shared/host-api-types";

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

/**
 * Per-integration runtime state owned by `startInstance` and consulted by
 * the webhook handler to authenticate inbound updates. Keyed by
 * `integrationId`.
 */
export type InstanceState = {
  webhookSecret: string;
  botUsername: string;
};

export type InstanceRegistry = {
  get(integrationId: string): InstanceState | undefined;
  set(integrationId: string, state: InstanceState): void;
  delete(integrationId: string): void;
};

export function createInstanceRegistry(): InstanceRegistry {
  const map = new Map<string, InstanceState>();
  return {
    get: (id) => map.get(id),
    set: (id, state) => {
      map.set(id, state);
    },
    delete: (id) => {
      map.delete(id);
    },
  };
}

type TelegramUser = {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramChat = {
  id?: number | string;
  type?: string;
  title?: string;
};

type TelegramPhotoSize = {
  file_id?: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
};

type TelegramDocument = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramAudioOrVoice = {
  file_id?: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
};

type TelegramVideo = {
  file_id?: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
};

type TelegramMessage = {
  message_id?: number;
  date?: number;
  from?: TelegramUser;
  chat?: TelegramChat;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  entities?: Array<{ type?: string; offset?: number; length?: number }>;
  caption_entities?: Array<{ type?: string; offset?: number; length?: number }>;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudioOrVoice;
  voice?: TelegramAudioOrVoice;
  video?: TelegramVideo;
  video_note?: TelegramVideo;
  animation?: TelegramVideo;
};

export type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

function fileApiUrlFor(botToken: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}

async function resolveTelegramFileUrl(
  api: PluginHostAPI,
  botToken: string,
  fileId: string
): Promise<string | null> {
  try {
    const response = await api.fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(
        fileId
      )}`
    );
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
    };
    if (!(data.ok && data.result?.file_path)) {
      return null;
    }
    return fileApiUrlFor(botToken, data.result.file_path);
  } catch {
    return null;
  }
}

async function buildAttachmentArrays(
  api: PluginHostAPI,
  botToken: string,
  message: TelegramMessage
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

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    // Telegram returns multiple sizes for the same photo. Take the largest
    // (last entry) to match the first-party behaviour.
    const largest = message.photo[message.photo.length - 1];
    if (largest?.file_id) {
      const url = await resolveTelegramFileUrl(api, botToken, largest.file_id);
      if (url) {
        imageUrls.push({ url, mediaType: "image/jpeg" });
      }
    }
  }

  if (message.document?.file_id) {
    const url = await resolveTelegramFileUrl(
      api,
      botToken,
      message.document.file_id
    );
    if (url) {
      fileUrls.push({
        url,
        ...(message.document.file_name
          ? { filename: message.document.file_name }
          : {}),
        ...(message.document.mime_type
          ? { mediaType: message.document.mime_type }
          : { mediaType: "application/octet-stream" }),
      });
    }
  }

  const audioSource = message.audio ?? message.voice;
  if (audioSource?.file_id) {
    const url = await resolveTelegramFileUrl(
      api,
      botToken,
      audioSource.file_id
    );
    if (url) {
      audioUrls.push({
        url,
        mediaType: audioSource.mime_type ?? "audio/ogg",
      });
    }
  }

  const videoSource = message.video ?? message.video_note ?? message.animation;
  if (videoSource?.file_id) {
    const url = await resolveTelegramFileUrl(
      api,
      botToken,
      videoSource.file_id
    );
    if (url) {
      videoUrls.push({
        url,
        mediaType: videoSource.mime_type ?? "video/mp4",
      });
    }
  }

  return { imageUrls, fileUrls, audioUrls, videoUrls };
}

function deriveText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? "").trim();
}

function deriveUserName(from: TelegramUser | undefined): string {
  if (!from) {
    return "";
  }
  if (from.username) {
    return from.username;
  }
  const parts = [from.first_name, from.last_name].filter(
    (p): p is string => typeof p === "string" && p.length > 0
  );
  if (parts.length > 0) {
    return parts.join(" ");
  }
  return typeof from.id === "number" ? String(from.id) : "";
}

function detectMention(
  message: TelegramMessage,
  botUsername: string
): boolean {
  const candidates = [
    ...(message.entities ?? []),
    ...(message.caption_entities ?? []),
  ];
  const hasMentionEntity = candidates.some((e) => e.type === "mention");
  if (!hasMentionEntity) {
    return false;
  }
  if (!botUsername) {
    return true;
  }
  const needle = `@${botUsername.toLowerCase()}`;
  const haystack = (message.text ?? message.caption ?? "").toLowerCase();
  return haystack.includes(needle);
}

function buildThreadJsonFor(
  chatIdRaw: number | string,
  isDM: boolean,
  messageThreadId: number | undefined
): { id: string; channelId: string; threadJson: Record<string, unknown> } {
  const channelId = String(chatIdRaw);
  const id =
    typeof messageThreadId === "number"
      ? `telegram:${channelId}:${messageThreadId}`
      : `telegram:${channelId}`;
  return {
    id,
    channelId,
    threadJson: {
      _type: "chat:Thread",
      adapterName: "telegram",
      channelId,
      id,
      isDM,
    },
  };
}

/**
 * Build a ChatMessageEvent from a Telegram update and dispatch it to the
 * host. Used by both the webhook handler and the polling fallback in
 * connection.ts, so they emit identical events. Returns true when the
 * update contained a routable message, false otherwise.
 */
export async function processTelegramUpdate(
  deps: { api: PluginHostAPI },
  integrationId: string,
  state: InstanceState,
  update: TelegramUpdate
): Promise<boolean> {
  const { api } = deps;
  const message =
    update.message ?? update.edited_message ?? update.channel_post;
  if (!(message && message.chat && message.chat.id !== undefined)) {
    return false;
  }

  // Bot token is required to resolve file URLs. Fetch at dispatch time so
  // a token rotation takes effect on the next update without restarting
  // the connection. Verbatim manifest key per Phase 4a.2 Q6 Convention X.
  const creds = await api.fetchCredentials(integrationId);
  const botToken = creds.TELEGRAM_BOT_API_KEY ?? "";

  const chatType = message.chat.type ?? "";
  const isDM = chatType === "private";
  const isMention = detectMention(message, state.botUsername);
  const { id: threadId, channelId, threadJson } = buildThreadJsonFor(
    message.chat.id,
    isDM,
    message.message_thread_id
  );

  const attachments = botToken
    ? await buildAttachmentArrays(api, botToken, message)
    : {
        imageUrls: [],
        fileUrls: [],
        audioUrls: [],
        videoUrls: [],
      };

  const event: ChatMessageEvent = {
    integrationId,
    text: deriveText(message),
    threadJson,
    isDM,
    isMention,
    channelId,
    threadId,
    ...(message.from && typeof message.from.id === "number"
      ? { chatId: String(message.from.id) }
      : {}),
    userName: deriveUserName(message.from),
    arrivalAt: Date.now(),
    imageUrls: attachments.imageUrls,
    fileUrls: attachments.fileUrls,
    audioUrls: attachments.audioUrls,
    videoUrls: attachments.videoUrls,
  };

  try {
    await api.dispatchToWorkflow(event);
  } catch (error) {
    api.logger.warn("telegram dispatchToWorkflow failed", {
      integrationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
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
    const state = registry.get(integrationId);
    if (!state) {
      // Connection not started for this integration. Return 200 (per design
      // §5) so Telegram does not enter retry storms. Operators see the gap
      // via the warn log.
      api.logger.warn("telegram webhook for unknown integration", {
        integrationId,
      });
      return ctx.json({ ok: true });
    }
    if (!state.webhookSecret) {
      api.logger.warn("telegram webhook rejected: no secret configured", {
        integrationId,
      });
      return ctx.json({ error: "Unauthorized" }, 401);
    }
    const headerValue = ctx.req.header(TELEGRAM_SECRET_TOKEN_HEADER);
    if (!headerValue || !constantTimeEquals(state.webhookSecret, headerValue)) {
      return ctx.json({ error: "Unauthorized" }, 401);
    }

    let update: TelegramUpdate;
    try {
      update = await ctx.req.json<TelegramUpdate>();
    } catch {
      // Bad payload from Telegram — ack so we don't get retried.
      return ctx.json({ ok: true });
    }

    await processTelegramUpdate({ api }, integrationId, state, update);
    // Always 200 — duplicate / no-target cases return null from
    // dispatchToWorkflow, but Telegram must never be told to retry.
    return ctx.json({ ok: true });
  };
}
