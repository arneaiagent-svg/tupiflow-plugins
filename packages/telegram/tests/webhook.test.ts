import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { RouteContext } from "@tupiflow-plugins/shared/host-api-types";

import { makeWebhookHandler } from "../src/webhook.ts";

interface JsonCall {
  body: unknown;
  status: number | undefined;
}

function makeCtx(
  headers: Record<string, string>,
  payload: unknown,
  throwOnJson = false
): { ctx: RouteContext; calls: JsonCall[]; jsonReadCount: () => number } {
  const calls: JsonCall[] = [];
  let jsonReads = 0;
  const ctx: RouteContext = {
    json: (body: unknown, status?: number) => {
      calls.push({ body, status });
      return { body, status };
    },
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      json: async <T = unknown>(): Promise<T> => {
        jsonReads++;
        if (throwOnJson) {
          throw new Error("bad json");
        }
        return payload as T;
      },
      query: (_name: string) => undefined,
      param: (_name: string) => "",
      raw: new Request("https://example.test/webhook", { method: "POST" }),
    },
  };
  return { ctx, calls, jsonReadCount: () => jsonReads };
}

test("webhook rejects when no expected secret is configured", async () => {
  const handler = makeWebhookHandler({});
  const { ctx, calls } = makeCtx(
    { "x-telegram-bot-api-secret-token": "anything" },
    { update_id: 1 }
  );
  await handler(ctx);
  assert.equal(calls.length, 1);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 401);
  assert.deepEqual(first.body, { error: "Unauthorized" });
});

test("webhook rejects when header is missing", async () => {
  const handler = makeWebhookHandler({ expectedSecret: "s3cret" });
  const { ctx, calls } = makeCtx({}, { update_id: 1 });
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 401);
});

test("webhook rejects when header mismatches", async () => {
  const handler = makeWebhookHandler({ expectedSecret: "s3cret" });
  const { ctx, calls } = makeCtx(
    { "x-telegram-bot-api-secret-token": "wrong" },
    { update_id: 1 }
  );
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 401);
});

test("webhook rejects when header length differs", async () => {
  const handler = makeWebhookHandler({ expectedSecret: "s3cret" });
  const { ctx, calls } = makeCtx(
    { "x-telegram-bot-api-secret-token": "s3cret-too-long" },
    { update_id: 1 }
  );
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 401);
});

test("webhook accepts a matching header and reads the body", async () => {
  const handler = makeWebhookHandler({ expectedSecret: "s3cret" });
  const { ctx, calls, jsonReadCount } = makeCtx(
    { "x-telegram-bot-api-secret-token": "s3cret" },
    { update_id: 7 }
  );
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, undefined);
  assert.deepEqual(first.body, { ok: true });
  // Body parse happens after the auth gate; assert we actually consumed it.
  // Once Phase 4a.2 lands the parsed update will be forwarded to
  // dispatchToWorkflow — this assertion is the closest behavioral hook
  // we have today.
  assert.equal(jsonReadCount(), 1);
});

test("webhook rejects invalid JSON body with 400", async () => {
  const handler = makeWebhookHandler({ expectedSecret: "s3cret" });
  const { ctx, calls } = makeCtx(
    { "x-telegram-bot-api-secret-token": "s3cret" },
    null,
    true
  );
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 400);
});
