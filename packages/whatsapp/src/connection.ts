// whatsapp connection — SDK port of plugins/whatsapp/connection.ts.
// Uses chat-adapter-baileys + chat SDK for inbound message routing and
// adapter-state persistence in postgres. Linking is QR-only (the operator
// scans a code from WhatsApp -> Linked Devices); pairing-code auth is
// disabled because chat-adapter-baileys requests the code before the
// noise handshake completes and WhatsApp rejects with HTTP 428.

import { createPostgresState } from "@chat-adapter/state-pg";
import { useMultiFileAuthState } from "baileys";
import { Chat } from "chat";
import {
  type BaileysAdapter,
  createBaileysAdapter,
} from "chat-adapter-baileys";

import type {
  ChatMessage,
  ChatMessageEvent,
  ConnectionInstance,
  PluginHostAPI,
} from "@tupiflow-plugins/shared/host-api-types";

import {
  extractAttachments,
  extractFileAttachments,
  type IncomingAttachment,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_VIDEO_BYTES,
  MAX_VIDEOS_PER_MESSAGE,
} from "./attachments.ts";
import { getLinkStates, type WhatsappLinkState } from "./link-state.ts";
import { createBaileysLogger, createLinkStateLogger } from "./logger.ts";
import type { InstanceRegistry } from "./routes.ts";
import { getWhatsappSessionDir } from "./session-dir.ts";

export interface WhatsappConnectionHandle {
  adapter: BaileysAdapter;
  chat: Chat;
  state: WhatsappLinkState;
}

export interface StartInstanceDeps {
  api: PluginHostAPI;
  registry: InstanceRegistry;
}

export function makeStartInstance(deps: StartInstanceDeps) {
  const { api, registry } = deps;
  return async function startInstance(args: {
    integrationId: string;
    config: Record<string, unknown>;
  }): Promise<ConnectionInstance> {
    const { integrationId, config } = args;

    const chatStateUrl = process.env.CONNECTION_CHAT_DATABASE_URL;
    if (!chatStateUrl) {
      throw new Error(
        "[whatsapp] CONNECTION_CHAT_DATABASE_URL is required for WhatsApp bot state"
      );
    }

    const sessionDir = getWhatsappSessionDir(integrationId);
    const { state: authState, saveCreds } =
      // biome-ignore lint/correctness/useHookAtTopLevel: Baileys helper, not a React hook
      await useMultiFileAuthState(sessionDir);

    const linkState: WhatsappLinkState = {
      qr: null,
      connected: false,
      linkedAt: null,
      linkedAs: null,
      pairingCode: null,
      error: null,
    };
    getLinkStates().set(integrationId, linkState);

    // Pairing-code auth is disabled — chat-adapter-baileys issues
    // `requestPairingCode` on `connection === "connecting"`, before Baileys'
    // noise handshake completes, and WhatsApp rejects with HTTP 428
    // "Precondition Required" + closes the socket. We force QR-only until
    // the adapter fixes the race. If an old integration still carries a
    // pairingPhone value in its config, we ignore it.
    if (config.pairingPhone) {
      console.warn(
        `[whatsapp] integration=${integrationId} ignoring legacy pairingPhone=${JSON.stringify(
          config.pairingPhone
        )} — pairing-code auth is disabled, use QR instead`
      );
    }

    const adapter = createBaileysAdapter({
      auth: { state: authState, saveCreds },
      userName: "workflow_wa_bot",
      adapterName: `baileys-${integrationId}`,
      socketOptions: { logger: createBaileysLogger() },
      onQR: (qr) => {
        linkState.qr = qr;
        linkState.connected = false;
      },
    });

    // chat-sdk's detectMention only checks for `@<userName>` or `@<botUserId>` in
    // message text, but WhatsApp surfaces group mentions out-of-band via
    // `contextInfo.mentionedJid` (an array of JIDs) — the visible text only
    // shows `@<phonenumber>`, never the full JID. So we override parseMessage to
    // pre-set `isMention` whenever the bot's phone appears in mentionedJid,
    // matching by the phone-number portion (strips ":<device>" and "@<host>")
    // since botUserId may carry a device suffix the mentioned JID does not.
    interface RawWhatsappMessage {
      message?: {
        extendedTextMessage?: { contextInfo?: { mentionedJid?: string[] } };
        imageMessage?: { contextInfo?: { mentionedJid?: string[] } };
        videoMessage?: { contextInfo?: { mentionedJid?: string[] } };
        documentMessage?: { contextInfo?: { mentionedJid?: string[] } };
      };
    }
    const phonePart = (jid: string | undefined): string =>
      (jid ?? "").split("@")[0]?.split(":")[0] ?? "";
    const collectMentionedJids = (raw: RawWhatsappMessage): string[] => {
      const m = raw.message;
      return [
        ...(m?.extendedTextMessage?.contextInfo?.mentionedJid ?? []),
        ...(m?.imageMessage?.contextInfo?.mentionedJid ?? []),
        ...(m?.videoMessage?.contextInfo?.mentionedJid ?? []),
        ...(m?.documentMessage?.contextInfo?.mentionedJid ?? []),
      ];
    };
    // WhatsApp groups now address participants by LID (e.g. `<id>@lid`) instead
    // of phone JID for privacy. The bot's own LID lives on `socket.user.lid` —
    // adapter exposes the socket privately, so we read it via a typed cast.
    const getBotLid = (): string | undefined => {
      const sock = (
        adapter as unknown as { _socket?: { user?: { lid?: unknown } } }
      )._socket;
      const lid = sock?.user?.lid;
      return typeof lid === "string" ? lid : undefined;
    };

    const origParseMessage = adapter.parseMessage.bind(adapter);
    adapter.parseMessage = (raw: Parameters<typeof adapter.parseMessage>[0]) => {
      const msg = origParseMessage(raw);
      const botPhone = phonePart(adapter.botUserId);
      const botLidId = phonePart(getBotLid());
      const mentioned = collectMentionedJids(raw as RawWhatsappMessage);
      if (
        mentioned.some((jid) => {
          const part = phonePart(jid);
          return (
            (botPhone && part === botPhone) || (botLidId && part === botLidId)
          );
        })
      ) {
        (msg as { isMention?: boolean }).isMention = true;
      }
      return msg;
    };

    const chat = new Chat({
      userName: "workflow_wa_bot",
      adapters: { whatsapp: adapter },
      state: createPostgresState({
        url: chatStateUrl,
        keyPrefix: `whatsapp:${integrationId}`,
      }),
      concurrency: "queue",
      logger: createLinkStateLogger(linkState),
    });

    type ThreadArg = Parameters<Parameters<typeof chat.onNewMention>[0]>[0];
    type MessageArg = Parameters<Parameters<typeof chat.onNewMention>[0]>[1];

    const persistUserTurn = async (
      thread: ThreadArg,
      message: MessageArg
    ): Promise<void> => {
      const text = message.text || "";
      if (!text) {
        return;
      }
      const author = message.author as
        | { userId?: string; id?: string }
        | undefined;
      const authorId = author?.userId || author?.id || undefined;
      const userMessage: ChatMessage = {
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };
      try {
        await api.chat.appendThreadMessages(
          integrationId,
          thread.id,
          [userMessage],
          authorId,
          thread.toJSON()
        );
        await api.chat.notifyMessageAppended(
          integrationId,
          thread.id,
          userMessage
        );
      } catch (error) {
        console.warn(
          `[whatsapp] failed to persist user turn for ${thread.id}:`,
          error
        );
      }
    };

    const markMessageRead = async (
      thread: ThreadArg,
      message: MessageArg
    ): Promise<void> => {
      try {
        await adapter.markRead(
          thread.id,
          [message.id],
          thread.isDM
            ? undefined
            : (message.author as { userId?: string } | undefined)?.userId
        );
      } catch (error) {
        console.warn("[whatsapp] markRead failed:", error);
      }
    };

    const buildEvent = async (
      thread: ThreadArg,
      message: MessageArg,
      flags: { isDM: boolean; isMention: boolean }
    ): Promise<ChatMessageEvent> => {
      // Capture arrival time before any async work so dedup key is stable.
      const arrivalAt = Date.now();
      const attachmentMsg = message as unknown as {
        attachments?: IncomingAttachment[];
      };
      const [imageUrls, audioUrls, videoUrls, fileUrls] = await Promise.all([
        extractAttachments(
          attachmentMsg,
          "image",
          MAX_IMAGES_PER_MESSAGE,
          MAX_IMAGE_BYTES,
          "image/jpeg"
        ),
        extractAttachments(
          attachmentMsg,
          "audio",
          MAX_AUDIO_PER_MESSAGE,
          MAX_AUDIO_BYTES,
          "audio/ogg"
        ),
        extractAttachments(
          attachmentMsg,
          "video",
          MAX_VIDEOS_PER_MESSAGE,
          MAX_VIDEO_BYTES,
          "video/mp4"
        ),
        extractFileAttachments(attachmentMsg),
      ]);

      // Baileys' WAMessage proto (stored on `currentMessage.raw`) contains Long
      // and Buffer instances that the workflow serde can't handle ("Cannot
      // stringify arbitrary non-POJOs"). send-reply only needs thread id/channel
      // so dropping `raw` is safe.
      const rawThreadJson = thread.toJSON() as {
        currentMessage?: { raw?: unknown };
      };
      if (rawThreadJson.currentMessage) {
        rawThreadJson.currentMessage.raw = null;
      }
      const author = message.author as
        | { id?: string; name?: string; userId?: string }
        | undefined;
      const chatId = author?.userId || author?.id || undefined;
      return {
        integrationId,
        arrivalAt,
        text: message.text || "",
        threadJson: rawThreadJson,
        isDM: flags.isDM,
        isMention: flags.isMention,
        channelId: thread.channelId,
        threadId: thread.id,
        chatId,
        userName: author?.name || author?.id || "",
        imageUrls,
        fileUrls,
        audioUrls,
        videoUrls,
      };
    };

    const dispatchEvent = async (event: ChatMessageEvent): Promise<void> => {
      try {
        await api.dispatchToWorkflow(event);
      } catch (error) {
        console.warn("[whatsapp] dispatchToWorkflow failed:", error);
      }
    };

    chat.onNewMention(async (thread, message) => {
      if (await api.chat.getHumanControl(integrationId, thread.id)) return;
      await thread.subscribe();
      await markMessageRead(thread, message);
      await persistUserTurn(thread, message);
      api.telemetry.record("tlm_connection_events", {
        user_id: "unknown",
        integration_type: "whatsapp",
        integration_id: integrationId,
        event: "message_in",
        duration_ms: null,
        error_class: null,
        ok: true,
      });
      await dispatchEvent(
        await buildEvent(thread, message, { isDM: false, isMention: true })
      );
    });

    chat.onDirectMessage(async (thread, message) => {
      if (await api.chat.getHumanControl(integrationId, thread.id)) return;
      await thread.subscribe();
      await markMessageRead(thread, message);
      await persistUserTurn(thread, message);
      api.telemetry.record("tlm_connection_events", {
        user_id: "unknown",
        integration_type: "whatsapp",
        integration_id: integrationId,
        event: "message_in",
        duration_ms: null,
        error_class: null,
        ok: true,
      });
      await dispatchEvent(
        await buildEvent(thread, message, { isDM: true, isMention: false })
      );
    });

    chat.onSubscribedMessage(async (thread, message) => {
      if (await api.chat.getHumanControl(integrationId, thread.id)) return;
      const isMention = Boolean((message as { isMention?: boolean }).isMention);
      await markMessageRead(thread, message);
      await persistUserTurn(thread, message);
      if (!(thread.isDM || isMention)) {
        return;
      }
      api.telemetry.record("tlm_connection_events", {
        user_id: "unknown",
        integration_type: "whatsapp",
        integration_id: integrationId,
        event: "message_in",
        duration_ms: null,
        error_class: null,
        ok: true,
      });
      await dispatchEvent(
        await buildEvent(thread, message, {
          isDM: thread.isDM,
          isMention,
        })
      );
    });

    await chat.initialize();

    // Fire and forget: `adapter.connect()` keeps the websocket running and
    // reconnects on drop. Awaiting it would block `startInstance` until the
    // first QR/pair completes, which can be minutes while the user scans.
    adapter.connect().catch((error: unknown) => {
      console.error(
        `[whatsapp] adapter.connect failed for ${integrationId}:`,
        error
      );
      linkState.error = error instanceof Error ? error.message : String(error);
    });

    // Surface the linked account identity once the socket reports connected.
    // `adapter.botUserId` is `undefined` until the pair handshake settles, so
    // we poll briefly and store it on linkState for the UI to display.
    const identityInterval = setInterval(() => {
      if (!linkState.connected) {
        return;
      }
      const jid = adapter.botUserId;
      if (jid && !linkState.linkedAs) {
        linkState.linkedAs = jid.split("@")[0] || jid;
      }
    }, 2000);

    const handle: WhatsappConnectionHandle = {
      chat,
      adapter,
      state: linkState,
    };
    registry.set(integrationId, handle);

    // Telemetry — boot. user_id is "unknown" until the parked host telemetry
    // bug is fixed (host doesn't auto-fill owner for plugin-scoped writes).
    api.telemetry.record("tlm_connection_events", {
      user_id: "unknown",
      integration_type: "whatsapp",
      integration_id: integrationId,
      event: "boot",
      duration_ms: null,
      error_class: null,
      ok: true,
    });

    return {
      integrationId,
      handle,
      shutdown: async () => {
        api.telemetry.record("tlm_connection_events", {
          user_id: "unknown",
          integration_type: "whatsapp",
          integration_id: integrationId,
          event: "disconnect",
          duration_ms: null,
          error_class: null,
          ok: true,
        });
        clearInterval(identityInterval);
        getLinkStates().delete(integrationId);
        registry.delete(integrationId);
        try {
          await adapter.disconnect();
        } catch (error) {
          console.warn(
            `[whatsapp] adapter.disconnect failed for ${integrationId}:`,
            error
          );
        }
        await chat.shutdown();
      },
    };
  };
}

/**
 * Builds the adapter-serialized Thread JSON for a raw WhatsApp JID.
 * DMs use `<num>@s.whatsapp.net` (or modern `<id>@lid`); groups use
 * `<id>@g.us`. The thread id is the JID itself — chat-adapter-baileys
 * addresses threads by JID directly.
 */
export function buildWhatsappThreadJson(
  chatId: string
): Record<string, unknown> | null {
  const trimmed = chatId.trim();
  if (!trimmed) {
    return null;
  }
  const isDM = trimmed.endsWith("@s.whatsapp.net") || trimmed.endsWith("@lid");
  return {
    _type: "chat:Thread",
    adapterName: "whatsapp",
    channelId: trimmed,
    id: trimmed,
    isDM,
  };
}
