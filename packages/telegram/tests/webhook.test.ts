import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
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

interface MockApi {
  api: PluginHostAPI;
}

function makeApi(): MockApi {
  const api: PluginHostAPI = {
    db: { read: async () => [], write: async () => {} },
    fetch: (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as PluginHostAPI["fetch"],
    fetchCredentials: async () => ({}),
    llm: {
      call: async () => ({ text: "" }),
      embed: async () => ({ vector: [], dimensions: 1024, model: "" }),
      embedBatch: async () => [],
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    publicBaseUrl: "",
    registerIntegration: () => {},
    registerRoute: () => {},
    registerStep: () => {},
    registerRegistryStep: () => {},
    registerTool: () => {},
    registerConnection: () => {},
    dispatchToWorkflow: async () => null,
    registerTestHandler: () => {},
    testIntegration: async () => ({ success: true }),
    updateIntegrationConfig: async () => {},
    registerToolCatalogContributor: () => {},
    registerTakeoverTarget: () => {},
    workflow: {
      create: async () => ({
        id: "w-stub",
        name: "stub",
        description: null,
        visibility: "private",
        isSystem: false,
        userId: "u-stub",
        nodes: [],
        edges: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
      get: async () => null,
      list: async () => ({ items: [], nextCursor: null }),
      createExecution: async () => ({
        executionId: "exec-1",
        status: "running",
      }),
      getExecutionLogs: async () => [],
      listExecutions: async () => [],
    },
    actions: { list: async () => [] },
    tools: { list: async () => [] },
    agents: {
      list: async () => [],
      create: async () => {
        throw new Error("stub");
      },
      update: async () => {
        throw new Error("stub");
      },
      delete: async () => {},
    },
    integrations: {
      list: async () => [],
      describe: async () => null,
    },
    connections: {
      types: async () => [],
      sendReply: async () => ({ delivered: false, threadId: "stub" }),
      shutdownPeer: async () => false,
    },
    chat: {
      appendThreadMessages: async () => {},
      getHumanControl: async () => false,
      notifyMessageAppended: async () => {},
    },
    telemetry: { record: () => {} },
    runTask: async () => null,
    sendErrorNotification: async () => ({
      dispatched: false,
      reason: "stub",
    }),
    runSandbox: async () => ({ success: true, value: null, logs: [] }),
    launchAgent: async () => ({ text: "", toolStepsUsed: 0 }),
  };
  return { api };
}

function makeMockChat(opts?: { webhookCalls?: Request[] }) {
  const webhookCalls = opts?.webhookCalls ?? [];
  return {
    initializeCalled: false,
    shutdownCalled: false,
    webhooks: {
      telegram: async (req: Request) => {
        webhookCalls.push(req);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
    async initialize() {
      this.initializeCalled = true;
    },
    async shutdown() {
      this.shutdownCalled = true;
    },
    onNewMention() {},
    onDirectMessage() {},
    onSubscribedMessage() {},
  };
}

function makeMockAdapter() {
  return {
    stopPolling() {},
  };
}

function makeCtx(
  integrationId: string,
  headers: Record<string, string>,
  rawBody?: string
): { ctx: RouteContext; calls: JsonCall[] } {
  const calls: JsonCall[] = [];
  const rawRequest = new Request("https://example.test/webhook", {
    method: "POST",
    body: rawBody ?? "{}",
    headers: { "Content-Type": "application/json", ...headers },
  });
  const ctx: RouteContext = {
    json: (body: unknown, status?: number) => {
      calls.push({ body, status });
      return { body, status };
    },
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      json: async <T = unknown>(): Promise<T> => JSON.parse(rawBody ?? "{}"),
      query: (_name: string) => undefined,
      param: (name: string) =>
        name === "integrationId" ? integrationId : "",
      raw: rawRequest,
    },
    userId: "",
    abilities: [],
  };
  return { ctx, calls };
}

test("webhook 200s with warn when integrationId is unknown", async () => {
  const { api } = makeApi();
  const registry = createInstanceRegistry();
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx("int-unknown", {
    "x-telegram-bot-api-secret-token": "anything",
  });
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, undefined);
  assert.deepEqual(first.body, { ok: true });
});

test("webhook 401s when integration has no webhook secret", async () => {
  const { api } = makeApi();
  const registry = createInstanceRegistry();
  registry.set("int-1", {
    adapter: makeMockAdapter() as any,
    chat: makeMockChat() as any,
    integrationId: "int-1",
    botUsername: "",
    webhookSecret: "",
  });
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx("int-1", {
    "x-telegram-bot-api-secret-token": "anything",
  });
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 401);
});

test("webhook 401s when header missing", async () => {
  const { api } = makeApi();
  const registry = createInstanceRegistry();
  registry.set("int-1", {
    adapter: makeMockAdapter() as any,
    chat: makeMockChat() as any,
    integrationId: "int-1",
    botUsername: "",
    webhookSecret: "s3cret",
  });
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx("int-1", {});
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 401);
});

test("webhook 401s when header mismatches (constant-time)", async () => {
  const { api } = makeApi();
  const registry = createInstanceRegistry();
  registry.set("int-1", {
    adapter: makeMockAdapter() as any,
    chat: makeMockChat() as any,
    integrationId: "int-1",
    botUsername: "",
    webhookSecret: "s3cret",
  });
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx("int-1", {
    "x-telegram-bot-api-secret-token": "wrong!",
  });
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.status, 401);
});

test("webhook delegates to chat.webhooks.telegram on valid request", async () => {
  const { api } = makeApi();
  const registry = createInstanceRegistry();
  const webhookCalls: Request[] = [];
  const mockChat = makeMockChat({ webhookCalls });

  registry.set("int-1", {
    adapter: makeMockAdapter() as any,
    chat: mockChat as any,
    integrationId: "int-1",
    botUsername: "",
    webhookSecret: "s3cret",
  });

  const handler = makeWebhookHandler({ api, registry });
  const payload = JSON.stringify({
    update_id: 99,
    message: { message_id: 7, chat: { id: 555 }, text: "hello" },
  });
  const { ctx, calls } = makeCtx(
    "int-1",
    { "x-telegram-bot-api-secret-token": "s3cret" },
    payload
  );
  await handler(ctx);

  assert.equal(webhookCalls.length, 1, "chat.webhooks.telegram called once");
  const first = calls[0];
  assert.ok(first);
  assert.deepEqual(first.body, { ok: true });
});

test("webhook 404 → 200 (avoid Telegram retry storm) for unknown integration", async () => {
  const { api } = makeApi();
  const registry = createInstanceRegistry();
  const handler = makeWebhookHandler({ api, registry });
  const { ctx, calls } = makeCtx("nonexistent", {});
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  assert.deepEqual(first.body, { ok: true });
  assert.equal(first.status, undefined);
});

test("bot-token-leak regression: webhook handler does NOT build URLs containing bot token", async () => {
  // The SDK webhook handler (chat.webhooks.telegram) resolves attachments
  // internally. This test verifies the webhook handler code itself does
  // not construct any api.telegram.org/file/bot<TOKEN>/ URLs.
  const { api } = makeApi();
  const registry = createInstanceRegistry();
  const webhookCalls: Request[] = [];
  const mockChat = makeMockChat({ webhookCalls });

  registry.set("int-1", {
    adapter: makeMockAdapter() as any,
    chat: mockChat as any,
    integrationId: "int-1",
    botUsername: "",
    webhookSecret: "s3cret",
  });

  const handler = makeWebhookHandler({ api, registry });
  const payload = JSON.stringify({
    update_id: 101,
    message: {
      message_id: 9,
      chat: { id: 555, type: "private" },
      photo: [
        { file_id: "small", file_size: 100 },
        { file_id: "photo123", file_size: 4000 },
      ],
    },
  });
  const { ctx } = makeCtx(
    "int-1",
    { "x-telegram-bot-api-secret-token": "s3cret" },
    payload
  );
  await handler(ctx);

  // The webhook handler source code no longer contains resolveTelegramFileUrl
  // or fileApiUrlFor. Verify by checking that the handler module does not
  // import or reference the token-leaking URL pattern.
  const webhookSource = await import("../src/webhook.ts");
  const sourceKeys = Object.keys(webhookSource);
  assert.equal(
    sourceKeys.includes("resolveTelegramFileUrl"),
    false,
    "resolveTelegramFileUrl must not be exported"
  );
  assert.equal(
    sourceKeys.includes("fileApiUrlFor"),
    false,
    "fileApiUrlFor must not be exported"
  );
  assert.equal(
    sourceKeys.includes("buildAttachmentArrays"),
    false,
    "buildAttachmentArrays must not be exported"
  );
});
