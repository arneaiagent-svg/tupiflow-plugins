import type { Logger } from "chat";
import type { WhatsappLinkState } from "./link-state.ts";

type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function getLogLevel(): LogLevel {
  const raw = (process.env.WHATSAPP_LOG_LEVEL || "warn").toLowerCase();
  return (raw in LEVEL_ORDER ? raw : "warn") as LogLevel;
}

export function shouldLog(target: LogLevel): boolean {
  return LEVEL_ORDER[getLogLevel()] >= LEVEL_ORDER[target];
}

/**
 * Logger that intercepts Baileys connection-state messages and mirrors them
 * into our link-state object.
 *
 * State-mutation always runs regardless of log level so the QR overlay can
 * reflect the real connection state. Console output is gated by
 * WHATSAPP_LOG_LEVEL (silent | error | warn | info | debug; default "warn").
 */
export function createLinkStateLogger(
  state: WhatsappLinkState,
  prefix = ""
): Logger {
  const isBaileys = prefix.includes("baileys");

  const onInfo = (message: string) => {
    if (!isBaileys) {
      return;
    }
    if (message.includes("Connected to WhatsApp")) {
      state.connected = true;
      state.qr = null;
      state.error = null;
      state.linkedAt = state.linkedAt ?? Date.now();
      return;
    }
    if (message.includes("Connection closed")) {
      state.connected = false;
    }
  };

  const onWarn = (message: string) => {
    if (!isBaileys) {
      return;
    }
    if (message.includes("Logged out")) {
      state.connected = false;
      state.error = "WhatsApp logged this device out. Click Reset to re-link.";
    }
  };

  const onError = (message: string) => {
    if (!isBaileys) {
      return;
    }
    if (message.includes("pairing code")) {
      state.error =
        "WhatsApp rejected the pairing-code request. Leave the phone number blank and scan the QR instead, or click Reset.";
    }
  };

  const tag = prefix || "chat";
  return {
    child: (childPrefix: string) =>
      createLinkStateLogger(
        state,
        prefix ? `${prefix}:${childPrefix}` : childPrefix
      ),
    debug: (message: string, ...args: unknown[]) => {
      if (shouldLog("debug")) {
        console.debug(`[chat-sdk:${tag}] ${message}`, ...args);
      }
    },
    info: (message: string, ...args: unknown[]) => {
      onInfo(message);
      if (shouldLog("info")) {
        console.log(`[chat-sdk:${tag}] ${message}`, ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      onWarn(message);
      if (shouldLog("warn")) {
        console.warn(`[chat-sdk:${tag}] ${message}`, ...args);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      onError(message);
      if (shouldLog("error")) {
        console.error(`[chat-sdk:${tag}] ${message}`, ...args);
      }
    },
  };
}

interface BaileysILogger {
  child: (obj: Record<string, unknown>) => BaileysILogger;
  debug: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  level: string;
  trace: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export function createBaileysLogger(): BaileysILogger {
  const fmt = (obj: unknown, msg?: string) =>
    typeof obj === "string" ? obj : (msg ?? "");
  const noop = () => {
    /* ignore below-threshold levels */
  };
  return {
    level: getLogLevel(),
    child: createBaileysLogger,
    trace: noop,
    debug: shouldLog("debug")
      ? (obj, msg) => console.debug(`[baileys] ${fmt(obj, msg)}`)
      : noop,
    info: shouldLog("info")
      ? (obj, msg) => console.log(`[baileys] ${fmt(obj, msg)}`)
      : noop,
    warn: shouldLog("warn")
      ? (obj, msg) => console.warn(`[baileys] ${fmt(obj, msg)}`)
      : noop,
    error: shouldLog("error")
      ? (obj, msg) => console.error(`[baileys] ${fmt(obj, msg)}`)
      : noop,
  };
}
