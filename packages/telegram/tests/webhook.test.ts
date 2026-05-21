import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  ChatMessageEvent,
  PluginHostAPI,
  RouteContext,
} from "@tupiflow-plugins/shared/host-api-types";

import {
  createInstanceRegistry,
  makeWebhookHandler,
} from "../src/webhook.ts";

interface JsonCall {
  body: unknown;
  status: number | undefined;
}

interface DispatchCall {
  event: ChatMessageEvent;
}

interface FetchCall {
  url: string;
}

interface MockApi {
  api: PluginHostAPI;
  fetchCalls: FetchCall[];
  dispatchCalls: DispatchCall[];
  fetchCredentialsCalls: string[];
}

function makeApi(opts: {
  botToken?: string;
  fileResponses?: Record<string, string>;
} = {}): MockApi {
  const fetchCalls: FetchCall[] = [];
  const dispatchCalls: DispatchCall[] = [];
  const fetchCredentialsCalls: string[] = [];
  const botToken = opts.botToken ?? "T";
  const fileResponses = opts.fileResponses ?? {};

  const api: PluginHostAPI = {
    db: {
      read: async () => [],
      write: async () => {},
    },
    fetch: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url });
      // Crude getFile responder.
      const match = url.match(/getFile\?file_id=(.+)$/);
      if (match) {
        const fileId = decodeURIComponent(match[1] ?? "");
        const filePath = fileResponses[fileId];
        if (filePath) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, result: { file_path: filePath } }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: false }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response;
    }) as PluginHostAPI["fetch"],
    fetchCredentials: async (id: string) => {
      fetchCredentialsCalls.push(id);
      return { TELEGRAM_BOT_API_KEY: botToken };
    },
    llm: {
      call: async () => ({ text: "" }),
      embed: async () => ({ vector: [], dimensions: 1024, model: "" }),
      embedBatch: async () => [],
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    publicBaseUrl: "",
    registerIntegration: () => {},
    registerRoute: () => {},
    registerStep: () => {},
    registerRegistryStep: () => {},
    registerTool: () => {},
    registerConnection: () => {},
    dispatchToWorkflow: async (event) => {
      dispatchCalls.push({ event });
      return { executionId: "exec-1" };
    },
    // Phase 4e.2 stubs — webhook test does not exercise these surfaces.
    registerTestHandler: () => {},
    testIntegration: async () => ({ success: true }),
    updateIntegrationConfig: async () => {},
    registerToolCatalogContributor: () => {},
    registerTakeoverTarget: () => {},
    workflow: {
      get: async () => null,
      list: async () => ({ items: [], nextCursor: null }),
      createExecution: async () => ({ executionId: "exec-1", status: "running" }),
      getExecutionLogs: async () => [],
    },
  };
  return { api, fetchCalls, dispatchCalls, fetchCredentialsCalls };
}

function makeCtx(
  integrationId: string,
  headers: Record<string, string>,
  payload: unknown,
  throwOnJson = false
): { ctx: RouteContext; calls: JsonCall[] } {
  const calls: JsonCall[] = [];
  const ctx: RouteContext = {
    json: (body: unknown, status?: number) => {
      calls.push({ body, status });
      return { body, status };
    },
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      json: async <T = unknown>(): Promise<T> => {
        if (throwOnJson) {
          throw new Error("bad json");
        }
        return payload as T;
      },
      query: (_name: string) => undefined,
      param: (name: string) =>
        name === "integrationId" ? integrationId : "",
      raw: new Request("https://example.test/webhook", { method: "POST" }),
    },
    // Phase 4e.2 §2.3 — telegram does not declare route.context.user so the
    // host populates these with empty defaults. Mirror that in the stub.
    userId: "",
    abilities: [],
  };
  return { ctx, calls };
}

test("webhook 200s with warn when integrationId is unknown", async () => {
  const { api, dispatchCalls } = makeApi();
  const registry = createInstanceRegistry();
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx(
    "int-unknown",
    { "x-telegram-bot-api-secret-token": "anything" },
    {}
  );
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, undefined);
  assert.deepEqual(first.body, { ok: true });
  assert.equal(dispatchCalls.length, 0);
});

test("webhook 401s when integration has no webhook secret", async () => {
  const { api } = makeApi();
  const registry = createInstanceRegistry();
  registry.set("int-1", { webhookSecret: "", botUsername: "" });
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx(
    "int-1",
    { "x-telegram-bot-api-secret-token": "anything" },
    {}
  );
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 401);
});

test("webhook 401s when header missing", async () => {
  const { api } = makeApi();
  const registry = createInstanceRegistry();
  registry.set("int-1", { webhookSecret: "s3cret", botUsername: "" });
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx("int-1", {}, {});
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 401);
});

test("webhook 401s when header mismatches", async () => {
  const { api } = makeApi();
  const registry = createInstanceRegistry();
  registry.set("int-1", { webhookSecret: "s3cret", botUsername: "" });
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx(
    "int-1",
    { "x-telegram-bot-api-secret-token": "wrong" },
    {}
  );
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 401);
});

test("webhook 200s and skips dispatch when payload has no chat", async () => {
  const { api, dispatchCalls } = makeApi();
  const registry = createInstanceRegistry();
  registry.set("int-1", { webhookSecret: "s3cret", botUsername: "" });
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx(
    "int-1",
    { "x-telegram-bot-api-secret-token": "s3cret" },
    { update_id: 1 }
  );
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.deepEqual(first.body, { ok: true });
  assert.equal(dispatchCalls.length, 0);
});

test("webhook 200s when body is unparseable JSON", async () => {
  const { api, dispatchCalls } = makeApi();
  const registry = createInstanceRegistry();
  registry.set("int-1", { webhookSecret: "s3cret", botUsername: "" });
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx(
    "int-1",
    { "x-telegram-bot-api-secret-token": "s3cret" },
    null,
    true
  );
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.deepEqual(first.body, { ok: true });
  assert.equal(dispatchCalls.length, 0);
});

test("webhook builds ChatMessageEvent and dispatches on a DM text message", async () => {
  const { api, dispatchCalls, fetchCredentialsCalls } = makeApi();
  const registry = createInstanceRegistry();
  registry.set("int-1", { webhookSecret: "s3cret", botUsername: "" });
  const handler = makeWebhookHandler({ api, registry });
  const payload = {
    update_id: 99,
    message: {
      message_id: 7,
      date: 1234,
      from: {
        id: 555,
        first_name: "Alice",
        username: "alice_doe",
      },
      chat: { id: 555, type: "private" },
      text: "hello",
    },
  };
  const { ctx, calls } = makeCtx(
    "int-1",
    { "x-telegram-bot-api-secret-token": "s3cret" },
    payload
  );
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.deepEqual(first.body, { ok: true });
  assert.equal(dispatchCalls.length, 1);
  assert.equal(fetchCredentialsCalls.length, 1);
  assert.equal(fetchCredentialsCalls[0], "int-1");
  const event = dispatchCalls[0]?.event;
  assert.ok(event);
  assert.equal(event.integrationId, "int-1");
  assert.equal(event.text, "hello");
  assert.equal(event.channelId, "555");
  assert.equal(event.threadId, "telegram:555");
  assert.equal(event.isDM, true);
  assert.equal(event.isMention, false);
  assert.equal(event.userName, "alice_doe");
  assert.equal(event.chatId, "555");
  assert.equal(typeof event.arrivalAt, "number");
  assert.ok(event.threadJson);
  // multimodal fields are present even when empty so the default workflow's
  // template references resolve to []
  assert.ok(Array.isArray(event.imageUrls));
  assert.ok(Array.isArray(event.fileUrls));
  assert.ok(Array.isArray(event.audioUrls));
  assert.ok(Array.isArray(event.videoUrls));
});

test("webhook detects @mention against configured botUsername", async () => {
  const { api, dispatchCalls } = makeApi();
  const registry = createInstanceRegistry();
  registry.set("int-1", { webhookSecret: "s3cret", botUsername: "my_bot" });
  const handler = makeWebhookHandler({ api, registry });
  const payload = {
    update_id: 100,
    message: {
      message_id: 8,
      date: 1234,
      from: { id: 555, username: "alice_doe" },
      chat: { id: -100123, type: "supergroup" },
      text: "hey @my_bot please reply",
      entities: [{ type: "mention", offset: 4, length: 7 }],
    },
  };
  const { ctx } = makeCtx(
    "int-1",
    { "x-telegram-bot-api-secret-token": "s3cret" },
    payload
  );
  await handler(ctx);
  const event = dispatchCalls[0]?.event;
  assert.ok(event);
  assert.equal(event.isDM, false);
  assert.equal(event.isMention, true);
  assert.equal(event.channelId, "-100123");
});

test("webhook resolves photo file URL via getFile and populates imageUrls", async () => {
  const { api, fetchCalls, dispatchCalls } = makeApi({
    fileResponses: { photo123: "photos/file_99.jpg" },
  });
  const registry = createInstanceRegistry();
  registry.set("int-1", { webhookSecret: "s3cret", botUsername: "" });
  const handler = makeWebhookHandler({ api, registry });
  const payload = {
    update_id: 101,
    message: {
      message_id: 9,
      date: 1234,
      from: { id: 555 },
      chat: { id: 555, type: "private" },
      photo: [
        { file_id: "small", file_size: 100 },
        { file_id: "photo123", file_size: 4000 },
      ],
    },
  };
  const { ctx } = makeCtx(
    "int-1",
    { "x-telegram-bot-api-secret-token": "s3cret" },
    payload
  );
  await handler(ctx);
  const event = dispatchCalls[0]?.event;
  assert.ok(event);
  assert.equal(event.imageUrls?.length, 1);
  const image = event.imageUrls?.[0];
  assert.ok(image);
  assert.equal(image.url, "https://api.telegram.org/file/botT/photos/file_99.jpg");
  // sanity: we called getFile against the largest photo only
  const getFileCalls = fetchCalls.filter((c) => c.url.includes("getFile"));
  assert.equal(getFileCalls.length, 1);
  assert.match(getFileCalls[0]?.url ?? "", /photo123/);
});
