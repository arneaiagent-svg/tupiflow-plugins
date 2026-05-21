import type { StepResult } from "@tupiflow-plugins/shared/host-api-types";

import { type ButtonSpec, parseButtons } from "./buttons.ts";

export interface SendReplyInput {
  botToken?: string;
  bubbleDelayMs?: string | number;
  buttons?: unknown;
  chatId?: string;
  integrationId?: string;
  messageThreadId?: string | number;
  splitBubbles?: string;
  text?: string;
  threadJson?: unknown;
}

interface SerializedTelegramThread {
  channelId: string;
  id: string;
  isDM: boolean;
  messageThreadId?: number;
}

interface TelegramSendMessageResponse {
  description?: string;
  ok: boolean;
  result?: { message_id: number };
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

function buildFallbackThread(
  chatId: string,
  messageThreadId?: string | number
): SerializedTelegramThread {
  const trimmed = chatId.trim();
  const topic =
    typeof messageThreadId === "number"
      ? messageThreadId
      : typeof messageThreadId === "string" && messageThreadId.trim()
        ? Number.parseInt(messageThreadId.trim(), 10)
        : Number.NaN;
  const id = Number.isFinite(topic)
    ? `telegram:${trimmed}:${topic}`
    : `telegram:${trimmed}`;
  const isDM = !trimmed.startsWith("-");
  return {
    channelId: trimmed,
    id,
    isDM,
    ...(Number.isFinite(topic) ? { messageThreadId: topic as number } : {}),
  };
}

function coerceThread(
  raw: unknown,
  fallbackChatId: string | undefined,
  fallbackMessageThreadId: string | number | undefined
): SerializedTelegramThread | { error: string } {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { error: "threadJson is not valid JSON" };
    }
  }
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const channelId = typeof v.channelId === "string" ? v.channelId : "";
    if (channelId) {
      const id =
        typeof v.id === "string" && v.id ? v.id : `telegram:${channelId}`;
      const isDM = typeof v.isDM === "boolean" ? v.isDM : !channelId.startsWith("-");
      const parsedTopic = id.startsWith("telegram:")
        ? id.slice("telegram:".length).split(":", 2)[1]
        : undefined;
      const topic = parsedTopic
        ? Number.parseInt(parsedTopic, 10)
        : Number.NaN;
      return {
        channelId,
        id,
        isDM,
        ...(Number.isFinite(topic) ? { messageThreadId: topic as number } : {}),
      };
    }
  }
  const cid = fallbackChatId?.toString().trim();
  if (!cid) {
    return {
      error:
        "Send Reply requires a threadJson from the chat trigger, or a fallback Chat ID configured on the node",
    };
  }
  return buildFallbackThread(cid, fallbackMessageThreadId);
}

interface PostMessageArgs {
  botToken: string;
  channelId: string;
  text: string;
  messageThreadId?: number;
  buttons: ButtonSpec[];
  fetchImpl: typeof fetch;
}

async function postMessage(
  args: PostMessageArgs
): Promise<{ messageId: string } | { error: string }> {
  const body: Record<string, unknown> = {
    chat_id: args.channelId,
    text: args.text,
  };
  if (args.messageThreadId !== undefined) {
    body.message_thread_id = args.messageThreadId;
  }
  if (args.buttons.length > 0) {
    body.reply_markup = {
      inline_keyboard: [args.buttons.map((b) => ({ text: b.text, url: b.url }))],
    };
  }
  const response = await args.fetchImpl(
    `https://api.telegram.org/bot${args.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const data = (await response.json()) as TelegramSendMessageResponse;
  if (!(response.ok && data.ok && data.result)) {
    return {
      error: data.description ?? `Telegram API returned ${response.status}`,
    };
  }
  return { messageId: String(data.result.message_id) };
}

export interface SendReplyDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export async function runSendReply(
  input: SendReplyInput,
  deps: SendReplyDeps = {}
): Promise<StepResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
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
  const botToken = input.botToken?.trim();
  if (!botToken) {
    return {
      success: false,
      error: {
        message:
          "Send Reply requires a botToken. Until the host-api exposes fetchCredentials(integrationId), pass it on the step input.",
      },
    };
  }
  const thread = coerceThread(
    input.threadJson,
    input.chatId,
    input.messageThreadId
  );
  if ("error" in thread) {
    return { success: false, error: { message: thread.error } };
  }
  const buttonsResult = parseButtons(input.buttons);
  if (!Array.isArray(buttonsResult)) {
    return { success: false, error: { message: buttonsResult.error } };
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
  const messageIds: string[] = [];
  for (let i = 0; i < bubbles.length; i++) {
    const chunk = bubbles[i] as string;
    const isLast = i === bubbles.length - 1;
    if (split && i > 0 && delayMs > 0) {
      await sleepImpl(delayMs);
    }
    const buttons = isLast ? buttonsResult : [];
    const result = await postMessage({
      botToken,
      channelId: thread.channelId,
      text: chunk,
      ...(thread.messageThreadId !== undefined
        ? { messageThreadId: thread.messageThreadId }
        : {}),
      buttons,
      fetchImpl,
    });
    if ("error" in result) {
      return { success: false, error: { message: result.error } };
    }
    messageIds.push(result.messageId);
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
}
