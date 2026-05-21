export interface ButtonSpec {
  text: string;
  url: string;
}

function isTelegramAcceptableButtonUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return false;
    }
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".localhost") ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function parseButtons(raw: unknown): ButtonSpec[] | { error: string } {
  if (raw === undefined || raw === null) {
    return [];
  }
  let value: unknown = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { error: "buttons must be valid JSON" };
    }
  }
  if (!Array.isArray(value)) {
    return { error: "buttons must be a JSON array" };
  }
  const out: ButtonSpec[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return { error: "each button must be { text, url }" };
    }
    const text = (item as { text?: unknown }).text;
    const url = (item as { url?: unknown }).url;
    if (typeof text !== "string" || typeof url !== "string") {
      return { error: "each button must have string `text` and `url`" };
    }
    if (!(text.trim() && url.trim())) {
      return { error: "button text and url cannot be empty" };
    }
    if (!isTelegramAcceptableButtonUrl(url.trim())) {
      return {
        error: `button url "${url.trim()}" is not publicly reachable. Telegram rejects localhost / private-IP URLs in inline_keyboard.`,
      };
    }
    out.push({ text: text.trim(), url: url.trim() });
  }
  return out;
}
