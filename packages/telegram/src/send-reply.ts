import type { StepResult } from "@tupiflow-plugins/shared/host-api-types";
import {
  Card,
  CardText,
  Actions,
  LinkButton,
  ThreadImpl,
  type SerializedThread,
} from "chat";

import { parseButtons } from "./buttons.ts";
import type { InstanceRegistry } from "./webhook.ts";

export interface SendReplyInput {
  bubbleDelayMs?: string | number;
  buttons?: unknown;
  chatId?: string;
  integrationId?: string;
  messageThreadId?: string | number;
  splitBubbles?: string;
  text?: string;
  threadJson?: unknown;
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

function coerceSerializedThread(
  raw: unknown,
  fallbackChatId: string | undefined,
  fallbackMessageThreadId: string | number | undefined
): SerializedThread | { error: string } {
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
    if (typeof v.channelId === "string" && v.channelId) {
      return {
        _type: "chat:Thread" as const,
        adapterName:
          typeof v.adapterName === "string" ? v.adapterName : "telegram",
        channelId: v.channelId,
        id:
          typeof v.id === "string" && v.id
            ? v.id
            : `telegram:${v.channelId}`,
        isDM:
          typeof v.isDM === "boolean"
            ? v.isDM
            : !v.channelId.startsWith("-"),
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
  const topic =
    typeof fallbackMessageThreadId === "number"
      ? fallbackMessageThreadId
      : typeof fallbackMessageThreadId === "string" &&
          fallbackMessageThreadId.trim()
        ? Number.parseInt(fallbackMessageThreadId.trim(), 10)
        : Number.NaN;
  const id = Number.isFinite(topic)
    ? `telegram:${cid}:${topic}`
    : `telegram:${cid}`;
  const isDM = !cid.startsWith("-");
  return {
    _type: "chat:Thread",
    adapterName: "telegram",
    channelId: cid,
    id,
    isDM,
  };
}

export interface SendReplyDeps {
  registry: InstanceRegistry;
  sleepImpl?: (ms: number) => Promise<void>;
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
        message: `[telegram] integration ${integrationId} not found in registry`,
      },
    };
  }
  const serialized = coerceSerializedThread(
    input.threadJson,
    input.chatId,
    input.messageThreadId
  );
  if ("error" in serialized) {
    return { success: false, error: { message: serialized.error } };
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

  const thread = ThreadImpl.fromJSON(serialized, handle.adapter);
  const split = isOn(input.splitBubbles);
  const bubbles = split ? parseBubbles(text) : [text];
  const delayMs = split ? parseDelayMs(input.bubbleDelayMs) : 0;

  for (let i = 0; i < bubbles.length; i++) {
    const chunk = bubbles[i] as string;
    const isLast = i === bubbles.length - 1;
    if (split && i > 0 && delayMs > 0) {
      await sleepImpl(delayMs);
    }
    if (buttonsResult.length > 0 && isLast) {
      await thread.post(
        Card({
          children: [
            CardText(chunk),
            Actions(
              buttonsResult.map((b) =>
                LinkButton({ label: b.text, url: b.url })
              )
            ),
          ],
        })
      );
    } else {
      await thread.post(chunk);
    }
  }

  return {
    success: true,
    data: {
      threadId: thread.id,
      bubbleCount: bubbles.length,
    },
  };
}
