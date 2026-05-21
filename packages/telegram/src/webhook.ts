import type { RouteHandler } from "@tupiflow-plugins/shared/host-api-types";

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

export interface WebhookDeps {
  expectedSecret?: string;
}

export function makeWebhookHandler(deps: WebhookDeps = {}): RouteHandler {
  const expected = deps.expectedSecret ?? "";
  return async (ctx) => {
    if (!expected) {
      return ctx.json({ error: "Unauthorized" }, 401);
    }
    const headerValue = ctx.req.header(TELEGRAM_SECRET_TOKEN_HEADER);
    if (!headerValue || !constantTimeEquals(expected, headerValue)) {
      return ctx.json({ error: "Unauthorized" }, 401);
    }
    let _payload: unknown;
    try {
      _payload = await ctx.req.json();
    } catch {
      return ctx.json({ error: "invalid JSON body" }, 400);
    }
    return ctx.json({ ok: true });
  };
}
