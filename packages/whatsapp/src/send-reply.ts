// whatsapp send-reply — ports plugins/whatsapp/steps/send-reply.ts to the
// registry-plugin host-API surface. Reads the live BaileysAdapter+Chat handle
// from an in-process registry that connection.ts populates at startInstance
// time, then posts text via the chat-SDK ThreadImpl helper.

import type {
  PluginHostAPI,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

import type { InstanceRegistry } from "./routes.ts";

export interface SendReplyInput {
  // Delay in milliseconds between bubbles. String because the config UI emits
  // strings. Defaults to 700 when splitBubbles is on.
  bubbleDelayMs?: string | number;
  // Fallback chat target. Used when the workflow doesn't have a trigger
  // threadJson (manual run, scheduler, AI-agent-only flow). WhatsApp JID:
  // `<number>@s.whatsapp.net` for DMs, `<id>@g.us` for groups.
  chatId?: string;
  integrationId?: string;
  // When "on", split `text` on blank lines and post each chunk as its own
  // WhatsApp message with a sleep between bubbles.
  splitBubbles?: string;
  text?: string;
  threadJson?: unknown;
}

interface SerializedWhatsappThread {
  _type: "chat:Thread";
  adapterName: "whatsapp";
  channelId: string;
  id: string;
  isDM: boolean;
}

function parseBubbles(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

function parseDelayMs(raw: string | number | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.min(10_000, Math.floor(raw)));
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(n)) {
      return Math.max(0, Math.min(10_000, n));
    }
  }
  return 700;
}

function isOn(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const v = value.trim().toLowerCase();
  return v === "on" || v === "true" || v === "yes" || v === "1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFallbackThread(chatId: string): SerializedWhatsappThread {
  const trimmed = chatId.trim();
  const isDM = trimmed.endsWith("@s.whatsapp.net") || trimmed.endsWith("@lid");
  return {
    _type: "chat:Thread",
    adapterName: "whatsapp",
    channelId: trimmed,
    id: trimmed,
    isDM,
  };
}

export interface SendReplyDeps {
  api: PluginHostAPI;
  registry: InstanceRegistry;
  sleepImpl?: (ms: number) => Promise<void>;
  // Test seam: override the dynamic `chat` import + adapter lookup. Production
  // path uses the real chat-sdk ThreadImpl.fromJSON; tests substitute a stub
  // that returns a fake thread with a post() spy so we don't have to vendor
  // the SDK into the test runtime.
  threadFromJSON?: (
    json: unknown,
    adapter: unknown
  ) => { id: string; post: (chunk: string) => Promise<{ id: string }> };
  getAdapterImpl?: (chat: unknown) => unknown;
}

export async function runSendReply(
  input: SendReplyInput,
  deps: SendReplyDeps
): Promise<StepResult> {
  const sleepImpl = deps.sleepImpl ?? sleep;
  const text = input.text?.trim();
  const integrationId = input.integrationId;
  if (!integrationId) {
    return {
      success: false,
      error: {
        message:
          "Send Reply requires an integrationId (passed from the chat trigger)",
      },
    };
  }

  const handle = deps.registry.get(integrationId);
  if (!handle) {
    return {
      success: false,
      error: {
        message: `WhatsApp connection ${integrationId} is not running`,
      },
    };
  }
  if (!handle.chat) {
    return {
      success: false,
      error: { message: "WhatsApp connection is missing a chat handle" },
    };
  }

  let threadJson: unknown = input.threadJson;
  if (typeof threadJson === "string") {
    try {
      threadJson = JSON.parse(threadJson);
    } catch {
      return {
        success: false,
        error: { message: "threadJson is not valid JSON" },
      };
    }
  }
  if (!threadJson || typeof threadJson !== "object") {
    const fallbackChatId = input.chatId?.toString().trim();
    if (!fallbackChatId) {
      return {
        success: false,
        error: {
          message:
            "Send Reply requires a threadJson from the chat trigger, or a fallback Chat ID (WhatsApp JID) configured on the node",
        },
      };
    }
    threadJson = buildFallbackThread(fallbackChatId);
    console.log("[whatsapp] using fallback chatId", { chatId: fallbackChatId });
  }

  try {
    let thread: { id: string; post: (chunk: string) => Promise<{ id: string }> };
    if (deps.threadFromJSON) {
      const adapter = deps.getAdapterImpl
        ? deps.getAdapterImpl(handle.chat)
        : handle.adapter;
      thread = deps.threadFromJSON(threadJson, adapter);
    } else {
      const chatModule = (await import("chat")) as {
        ThreadImpl: {
          fromJSON: (
            json: unknown,
            adapter: unknown
          ) => { id: string; post: (chunk: string) => Promise<{ id: string }> };
        };
      };
      const adapter =
        typeof (handle.chat as { getAdapter?: (n: string) => unknown }).getAdapter ===
        "function"
          ? (handle.chat as { getAdapter: (n: string) => unknown }).getAdapter(
              "whatsapp"
            )
          : handle.adapter;
      thread = chatModule.ThreadImpl.fromJSON(threadJson, adapter);
    }

    if (await deps.api.chat.getHumanControl(integrationId, thread.id)) {
      console.log("[whatsapp] send-reply suppressed: human takeover active", {
        integrationId,
        threadId: thread.id,
      });
      return {
        success: true,
        data: {
          messageId: "",
          messageIds: [],
          threadId: thread.id,
          bubbleCount: 0,
          suppressed: true,
          reason: "human takeover",
        },
      };
    }

    if (!text) {
      return {
        success: false,
        error: { message: "Send Reply requires non-empty text" },
      };
    }

    const split = isOn(input.splitBubbles);
    const bubbles = split ? parseBubbles(text) : [text];
    const delayMs = split ? parseDelayMs(input.bubbleDelayMs) : 0;
    console.log("[whatsapp] posting", {
      integrationId,
      threadId: thread.id,
      bubbleCount: bubbles.length,
      split,
      delayMs,
    });
    const messageIds: string[] = [];
    for (let i = 0; i < bubbles.length; i++) {
      const chunk = bubbles[i] as string;
      if (split && i > 0 && delayMs > 0) {
        await sleepImpl(delayMs);
      }
      const sent = await thread.post(chunk);
      messageIds.push(sent.id);
    }
    return {
      success: true,
      data: {
        messageId: messageIds.at(-1) ?? "",
        messageIds,
        threadId: thread.id,
        bubbleCount: messageIds.length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[whatsapp] post failed", { integrationId, error: message });
    return {
      success: false,
      error: { message },
    };
  }
}
