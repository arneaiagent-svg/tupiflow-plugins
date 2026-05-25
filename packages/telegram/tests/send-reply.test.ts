import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runSendReply } from "../src/send-reply.ts";
import { createInstanceRegistry } from "../src/webhook.ts";

interface PostCall {
  content: unknown;
}

function makeMockAdapter(opts?: {
  postCalls?: Array<{ threadId: string; message: unknown }>;
}) {
  const postCalls = opts?.postCalls ?? [];
  return {
    name: "telegram",
    userName: "test_bot",
    stopPolling() {},
    async postMessage(threadId: string, message: unknown) {
      postCalls.push({ threadId, message });
      return { id: `msg-${postCalls.length}`, threadId, raw: {} };
    },
  };
}

function makeMockThread(opts?: { postCalls?: PostCall[] }) {
  const postCalls = opts?.postCalls ?? [];
  return {
    id: "telegram:123",
    async post(content: unknown) {
      postCalls.push({ content });
    },
  };
}

function makeMockChat() {
  return {
    webhooks: { telegram: async () => new Response("ok") },
    async initialize() {},
    async shutdown() {},
    onNewMention() {},
    onDirectMessage() {},
    onSubscribedMessage() {},
  };
}

function makeRegistryWithInstance(integrationId: string) {
  const registry = createInstanceRegistry();
  const postCalls: PostCall[] = [];

  registry.set(integrationId, {
    adapter: makeMockAdapter() as any,
    chat: makeMockChat() as any,
    integrationId,
    botUsername: "",
    webhookSecret: "s",
  });

  return { registry, postCalls };
}

test("send-reply rejects missing integrationId", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const result = await runSendReply({ text: "hi" }, { registry });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /integrationId/);
  }
});

test("send-reply rejects when integration not in registry", async () => {
  const registry = createInstanceRegistry();
  const result = await runSendReply(
    { text: "hi", integrationId: "int_missing" },
    { registry }
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /not found/);
  }
});

test("send-reply rejects empty text", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const result = await runSendReply(
    {
      text: "   ",
      integrationId: "int_1",
      chatId: "123",
    },
    { registry }
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /non-empty/);
  }
});

test("send-reply requires thread or fallback chatId", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const result = await runSendReply(
    { text: "hi", integrationId: "int_1" },
    { registry }
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /threadJson|Chat ID/);
  }
});

test("send-reply rejects localhost button urls", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const result = await runSendReply(
    {
      text: "hi",
      integrationId: "int_1",
      chatId: "123",
      buttons: '[{"text":"Open","url":"http://localhost:3000"}]',
    },
    { registry }
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /localhost|private-IP|publicly/);
  }
});

test("send-reply returns success with threadId and bubbleCount", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const result = await runSendReply(
    {
      text: "hello world",
      integrationId: "int_1",
      chatId: "123",
    },
    { registry }
  );
  assert.equal(result.success, true);
  if (result.success) {
    const data = result.data as { threadId: string; bubbleCount: number };
    assert.equal(data.bubbleCount, 1);
    assert.ok(data.threadId);
  }
});

test("send-reply bubble splitting produces correct bubbleCount", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const result = await runSendReply(
    {
      text: "first\n\nsecond\n\nthird",
      splitBubbles: "on",
      bubbleDelayMs: 0,
      integrationId: "int_1",
      chatId: "-100123",
    },
    { registry, sleepImpl: async () => {} }
  );
  assert.equal(result.success, true);
  if (result.success) {
    const data = result.data as { bubbleCount: number };
    assert.equal(data.bubbleCount, 3);
  }
});

test("send-reply uses threadJson when supplied", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const result = await runSendReply(
    {
      text: "hi",
      integrationId: "int_1",
      threadJson: {
        channelId: "-100999",
        id: "telegram:-100999:42",
        isDM: false,
      },
    },
    { registry }
  );
  assert.equal(result.success, true);
  if (result.success) {
    const data = result.data as { threadId: string };
    assert.ok(data.threadId);
  }
});

test("send-reply handles stringified threadJson", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const result = await runSendReply(
    {
      text: "hi",
      integrationId: "int_1",
      threadJson: JSON.stringify({
        channelId: "555",
        id: "telegram:555",
        isDM: true,
      }),
    },
    { registry }
  );
  assert.equal(result.success, true);
});

test("send-reply does not check getHumanControl (host-side concern)", async () => {
  // send-reply is called from workflow, which implies intent to send.
  // Human control gating is done at the connection/inbound level, not here.
  const { registry } = makeRegistryWithInstance("int_1");
  const result = await runSendReply(
    {
      text: "reply",
      integrationId: "int_1",
      chatId: "123",
    },
    { registry }
  );
  assert.equal(result.success, true);
});
