import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runSendReply } from "../src/send-reply.ts";

type FetchMock = {
  calls: Array<{ url: string; init: { method?: string; body?: string; headers?: Record<string, string> } }>;
  fn: typeof fetch;
};

function makeFetchMock(
  respond: (args: { url: string; init: RequestInit }) => {
    status: number;
    body: unknown;
  }
): FetchMock {
  const calls: FetchMock["calls"] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      init: {
        method: init.method,
        body: typeof init.body === "string" ? init.body : undefined,
        headers: init.headers as Record<string, string> | undefined,
      },
    });
    const { status, body } = respond({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, fn };
}

test("send-reply rejects missing integrationId", async () => {
  const result = await runSendReply({ text: "hi", botToken: "T" });
  assert.equal(result.success, false);
  if (result.success === false) {
    assert.match(result.error.message, /integrationId/);
  }
});

test("send-reply rejects missing botToken", async () => {
  const result = await runSendReply({
    text: "hi",
    integrationId: "int_1",
    chatId: "123",
  });
  assert.equal(result.success, false);
  if (result.success === false) {
    assert.match(result.error.message, /botToken/);
  }
});

test("send-reply rejects empty text", async () => {
  const result = await runSendReply({
    text: "   ",
    integrationId: "int_1",
    botToken: "T",
    chatId: "123",
  });
  assert.equal(result.success, false);
  if (result.success === false) {
    assert.match(result.error.message, /non-empty/);
  }
});

test("send-reply requires thread or fallback chatId", async () => {
  const result = await runSendReply({
    text: "hi",
    integrationId: "int_1",
    botToken: "T",
  });
  assert.equal(result.success, false);
  if (result.success === false) {
    assert.match(result.error.message, /threadJson|Chat ID/);
  }
});

test("send-reply posts a single message and returns the id", async () => {
  const mock = makeFetchMock(() => ({
    status: 200,
    body: { ok: true, result: { message_id: 42 } },
  }));
  const result = await runSendReply(
    {
      text: "hello world",
      integrationId: "int_1",
      botToken: "T",
      chatId: "123",
    },
    { fetchImpl: mock.fn }
  );
  assert.equal(mock.calls.length, 1);
  const first = mock.calls[0];
  assert.ok(first);
  assert.equal(first.url, "https://api.telegram.org/botT/sendMessage");
  assert.equal(first.init.method, "POST");
  const body = JSON.parse(first.init.body ?? "{}");
  assert.equal(body.chat_id, "123");
  assert.equal(body.text, "hello world");
  assert.equal(body.reply_markup, undefined);
  assert.equal(result.success, true);
  if (result.success === true) {
    const data = result.data as { messageId: string; messageIds: string[]; bubbleCount: number; threadId: string };
    assert.equal(data.messageId, "42");
    assert.deepEqual(data.messageIds, ["42"]);
    assert.equal(data.bubbleCount, 1);
    assert.equal(data.threadId, "telegram:123");
  }
});

test("send-reply attaches inline_keyboard on the final bubble only", async () => {
  let i = 0;
  const mock = makeFetchMock(() => ({
    status: 200,
    body: { ok: true, result: { message_id: ++i } },
  }));
  const result = await runSendReply(
    {
      text: "first\n\nsecond\n\nthird",
      splitBubbles: "on",
      bubbleDelayMs: 0,
      integrationId: "int_1",
      botToken: "T",
      chatId: "-100123",
      buttons: '[{"text":"Open","url":"https://example.com"}]',
    },
    { fetchImpl: mock.fn, sleepImpl: async () => {} }
  );
  assert.equal(mock.calls.length, 3);
  const bodies = mock.calls.map((c) => JSON.parse(c.init.body ?? "{}"));
  assert.equal(bodies[0].reply_markup, undefined);
  assert.equal(bodies[1].reply_markup, undefined);
  assert.ok(bodies[2].reply_markup);
  assert.equal(bodies[2].reply_markup.inline_keyboard[0][0].text, "Open");
  assert.equal(result.success, true);
  if (result.success === true) {
    const data = result.data as { bubbleCount: number; messageIds: string[] };
    assert.equal(data.bubbleCount, 3);
    assert.deepEqual(data.messageIds, ["1", "2", "3"]);
  }
});

test("send-reply rejects localhost button urls", async () => {
  const mock = makeFetchMock(() => ({ status: 200, body: { ok: true, result: { message_id: 1 } } }));
  const result = await runSendReply(
    {
      text: "hi",
      integrationId: "int_1",
      botToken: "T",
      chatId: "123",
      buttons: '[{"text":"Open","url":"http://localhost:3000"}]',
    },
    { fetchImpl: mock.fn }
  );
  assert.equal(mock.calls.length, 0);
  assert.equal(result.success, false);
  if (result.success === false) {
    assert.match(result.error.message, /localhost|private-IP|publicly/);
  }
});

test("send-reply uses threadJson when supplied (including topic)", async () => {
  const mock = makeFetchMock(() => ({ status: 200, body: { ok: true, result: { message_id: 7 } } }));
  const result = await runSendReply(
    {
      text: "hi",
      integrationId: "int_1",
      botToken: "T",
      threadJson: { channelId: "-100999", id: "telegram:-100999:42", isDM: false },
    },
    { fetchImpl: mock.fn }
  );
  assert.equal(mock.calls.length, 1);
  const first = mock.calls[0];
  assert.ok(first);
  const body = JSON.parse(first.init.body ?? "{}");
  assert.equal(body.chat_id, "-100999");
  assert.equal(body.message_thread_id, 42);
  assert.equal(result.success, true);
});

test("send-reply surfaces Telegram API errors", async () => {
  const mock = makeFetchMock(() => ({
    status: 400,
    body: { ok: false, description: "chat not found" },
  }));
  const result = await runSendReply(
    { text: "hi", integrationId: "int_1", botToken: "T", chatId: "123" },
    { fetchImpl: mock.fn }
  );
  assert.equal(result.success, false);
  if (result.success === false) {
    assert.match(result.error.message, /chat not found/);
  }
});
