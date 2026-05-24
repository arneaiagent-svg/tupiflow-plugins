// test.ts — Telegram credential probe.
// Calls getMe to verify the bot token is valid without side effects.

import type { TestIntegrationResult } from "@tupiflow-plugins/shared/host-api-types";

export async function testTelegram(credentials: {
  TELEGRAM_BOT_API_KEY?: string;
}): Promise<TestIntegrationResult> {
  const botToken = credentials.TELEGRAM_BOT_API_KEY;

  if (!botToken) {
    return { success: false, error: "botToken is required" };
  }

  let res: Response;
  try {
    res = await fetch(
      `https://api.telegram.org/bot${botToken}/getMe`,
      { method: "GET" }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Network error: ${message}` };
  }

  if (!res.ok) {
    return {
      success: false,
      error: `Telegram API returned HTTP ${res.status}`,
    };
  }

  let body: { ok?: boolean; description?: string };
  try {
    body = (await res.json()) as { ok?: boolean; description?: string };
  } catch {
    return { success: false, error: "Could not parse Telegram API response" };
  }

  if (!body.ok) {
    return {
      success: false,
      error: body.description ?? "Telegram API responded with ok=false",
    };
  }

  return { success: true };
}
