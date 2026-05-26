import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

import { runSendReply } from "../src/send-reply.ts";
import {
  createInstanceRegistry,
  type InstanceRegistry,
} from "../src/routes.ts";

interface PostCall {
  content: string;
}

function makeFakeApi(opts?: { humanControlMap?: Map<string, boolean> }) {
  const humanControlMap = opts?.humanControlMap ?? new Map<string, boolean>();
  const api = {
    chat: {
      appendThreadMessages: async () => {},
      getHumanControl: async (_integrationId: string, threadId: string) =>
        humanControlMap.get(threadId) ?? false,
      notifyMessageAppended: async () => {},
    },
    // stubs for the rest — runSendReply only reaches into api.chat.getHumanControl
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as PluginHostAPI;
  return { api, humanControlMap };
}

function makeRegistryWithInstance(integrationId: string): {
  registry: InstanceRegistry;
  postCalls: PostCall[];
} {
  const registry = createInstanceRegistry();
  const postCalls: PostCall[] = [];
  registry.set(integrationId, {
    adapter: { fake: "adapter" } as any,
    chat: { fake: "chat" } as any,
    state: {
      qr: null,
      connected: true,
      linkedAt: 1,
      linkedAs: "1234",
      pairingCode: null,
      error: null,
    },
  });
  return { registry, postCalls };
}

// Test seam: each test supplies a threadFromJSON stub that returns a fake
// thread with .post() pushing into a local array. Avoids vendoring the chat
// SDK into the test runtime.
function makeThreadFromJSON(opts: {
  postCalls: PostCall[];
  threadId?: string;
}) {
  return (json: unknown, _adapter: unknown) => {
    const j = (json as { id?: string }) ?? {};
    const id = opts.threadId ?? j.id ?? "stub-thread";
    return {
      id,
      post: async (chunk: string) => {
        opts.postCalls.push({ content: chunk });
        return { id: `msg-${opts.postCalls.length}` };
      },
    };
  };
}

test("send-reply rejects missing integrationId", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const { api } = makeFakeApi();
  const result = await runSendReply(
    { text: "hi" },
    { api, registry }
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /integrationId/);
  }
});

test("send-reply rejects when integration not in registry", async () => {
  const registry = createInstanceRegistry();
  const { api } = makeFakeApi();
  const result = await runSendReply(
    { text: "hi", integrationId: "int_missing" },
    { api, registry }
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /not running/);
  }
});

test("send-reply requires threadJson or fallback chatId", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const { api } = makeFakeApi();
  const result = await runSendReply(
    { text: "hi", integrationId: "int_1" },
    { api, registry }
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /threadJson|Chat ID/i);
  }
});

test("send-reply with valid threadJson + text → 1 post, bubbleCount 1", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const { api } = makeFakeApi();
  const postCalls: PostCall[] = [];
  const result = await runSendReply(
    {
      text: "hello world",
      integrationId: "int_1",
      threadJson: {
        _type: "chat:Thread",
        adapterName: "whatsapp",
        channelId: "555@s.whatsapp.net",
        id: "555@s.whatsapp.net",
        isDM: true,
      },
    },
    {
      api,
      registry,
      threadFromJSON: makeThreadFromJSON({ postCalls }),
    }
  );
  assert.equal(result.success, true);
  assert.equal(postCalls.length, 1);
  if (result.success) {
    const data = result.data as { bubbleCount: number; messageIds: string[] };
    assert.equal(data.bubbleCount, 1);
    assert.equal(data.messageIds.length, 1);
  }
});

test("send-reply splitBubbles=on with 3 chunks → 3 posts, sleep between", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const { api } = makeFakeApi();
  const postCalls: PostCall[] = [];
  const sleepCalls: number[] = [];
  const result = await runSendReply(
    {
      text: "a\n\nb\n\nc",
      splitBubbles: "on",
      bubbleDelayMs: 200,
      integrationId: "int_1",
      chatId: "-100@g.us",
    },
    {
      api,
      registry,
      threadFromJSON: makeThreadFromJSON({ postCalls }),
      sleepImpl: async (ms: number) => {
        sleepCalls.push(ms);
      },
    }
  );
  assert.equal(result.success, true);
  assert.equal(postCalls.length, 3);
  assert.equal(postCalls[0].content, "a");
  assert.equal(postCalls[1].content, "b");
  assert.equal(postCalls[2].content, "c");
  // Sleeps occur between bubbles (n - 1 = 2 sleeps).
  assert.equal(sleepCalls.length, 2);
  assert.equal(sleepCalls[0], 200);
});

test("send-reply with human-takeover map true → success suppressed, no posts", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const humanControlMap = new Map<string, boolean>();
  humanControlMap.set("555@s.whatsapp.net", true);
  const { api } = makeFakeApi({ humanControlMap });
  const postCalls: PostCall[] = [];
  const result = await runSendReply(
    {
      text: "hi",
      integrationId: "int_1",
      threadJson: {
        _type: "chat:Thread",
        adapterName: "whatsapp",
        channelId: "555@s.whatsapp.net",
        id: "555@s.whatsapp.net",
        isDM: true,
      },
    },
    {
      api,
      registry,
      threadFromJSON: makeThreadFromJSON({
        postCalls,
        threadId: "555@s.whatsapp.net",
      }),
    }
  );
  assert.equal(result.success, true);
  assert.equal(postCalls.length, 0);
  if (result.success) {
    const data = result.data as { suppressed?: boolean; reason?: string };
    assert.equal(data.suppressed, true);
    assert.equal(data.reason, "human takeover");
  }
});

test("send-reply fallback chatId '123@s.whatsapp.net' → DM thread built + post", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const { api } = makeFakeApi();
  const postCalls: PostCall[] = [];
  // The threadFromJSON stub asserts the serialized DM shape the production
  // path builds via buildFallbackThread.
  let receivedJson: any = null;
  const result = await runSendReply(
    {
      text: "hi",
      integrationId: "int_1",
      chatId: "123@s.whatsapp.net",
    },
    {
      api,
      registry,
      threadFromJSON: (json, _adapter) => {
        receivedJson = json;
        const j = json as { id?: string };
        return {
          id: j.id ?? "123@s.whatsapp.net",
          post: async (chunk: string) => {
            postCalls.push({ content: chunk });
            return { id: `msg-${postCalls.length}` };
          },
        };
      },
    }
  );
  assert.equal(result.success, true);
  assert.ok(receivedJson);
  assert.equal(receivedJson.isDM, true);
  assert.equal(receivedJson.channelId, "123@s.whatsapp.net");
  assert.equal(postCalls.length, 1);
});

test("send-reply fallback chatId '-100@g.us' → group thread built (isDM false)", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const { api } = makeFakeApi();
  let receivedJson: any = null;
  await runSendReply(
    {
      text: "hi",
      integrationId: "int_1",
      chatId: "-100@g.us",
    },
    {
      api,
      registry,
      threadFromJSON: (json, _adapter) => {
        receivedJson = json;
        return {
          id: "-100@g.us",
          post: async () => ({ id: "msg-1" }),
        };
      },
    }
  );
  assert.ok(receivedJson);
  assert.equal(receivedJson.isDM, false);
});

test("send-reply rejects empty text", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const { api } = makeFakeApi();
  const result = await runSendReply(
    {
      text: "   ",
      integrationId: "int_1",
      chatId: "123@s.whatsapp.net",
    },
    {
      api,
      registry,
      threadFromJSON: makeThreadFromJSON({ postCalls: [] }),
    }
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /non-empty/);
  }
});

test("send-reply rejects invalid JSON threadJson string", async () => {
  const { registry } = makeRegistryWithInstance("int_1");
  const { api } = makeFakeApi();
  const result = await runSendReply(
    {
      text: "hi",
      integrationId: "int_1",
      threadJson: "{not json",
    },
    { api, registry }
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /threadJson/);
  }
});
