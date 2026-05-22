import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

import {
  buildTelegramThreadJson,
  makeStartInstance,
} from "../src/connection.ts";
import { createInstanceRegistry } from "../src/webhook.ts";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

interface MockApi {
  api: PluginHostAPI;
  fetchCredentialsCalls: string[];
  fetchCalls: FetchCall[];
}

function makeApi(args: {
  creds: Record<string, string | undefined>;
  publicBaseUrl?: string;
  telegramResponse?: () => Response;
}): MockApi {
  const fetchCredentialsCalls: string[] = [];
  const fetchCalls: FetchCall[] = [];
  const api: PluginHostAPI = {
    db: { read: async () => [], write: async () => {} },
    fetch: (async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";
      let parsedBody: unknown = null;
      if (typeof init?.body === "string") {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      fetchCalls.push({ url, method, body: parsedBody });
      return args.telegramResponse
        ? args.telegramResponse()
        : new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }) as PluginHostAPI["fetch"],
    fetchCredentials: async (id: string) => {
      fetchCredentialsCalls.push(id);
      return args.creds;
    },
    llm: {
      call: async () => ({ text: "" }),
      embed: async () => ({ vector: [], dimensions: 1024, model: "" }),
      embedBatch: async () => [],
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    publicBaseUrl: args.publicBaseUrl ?? "",
    registerIntegration: () => {},
    registerRoute: () => {},
    registerStep: () => {},
    registerRegistryStep: () => {},
    registerTool: () => {},
    registerConnection: () => {},
    dispatchToWorkflow: async () => null,
    // Phase 4e.2 stubs — connection test does not exercise these surfaces.
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
      createExecution: async () => ({ executionId: "exec-1", status: "running" }),
      getExecutionLogs: async () => [],
      listExecutions: async () => [],
    },
    actions: {
      list: async () => [],
    },
    tools: {
      list: async () => [],
    },
    agents: {
      list: async () => [],
      create: async () => {
        throw new Error("stub");
      },
      update: async () => {
        throw new Error("stub");
      },
      delete: async () => {
        /* stub */
      },
    },
    integrations: {
      list: async () => [],
      describe: async () => null,
    },
    connections: {
      types: async () => [],
    },
    // Phase 4f batch 1 stub — connection test does not exercise runTask.
    runTask: async () => null,
    // Phase 4e.5 batch 3 stub — connection test does not exercise sendErrorNotification.
    sendErrorNotification: async () => ({
      dispatched: false,
      reason: "stub",
    }),
  };
  return { api, fetchCredentialsCalls, fetchCalls };
}

test("startInstance calls fetchCredentials with the integrationId", async () => {
  const { api, fetchCredentialsCalls } = makeApi({
    creds: { TELEGRAM_BOT_API_KEY: "T" },
  });
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  const instance = await startInstance({
    integrationId: "int-1",
    config: { webhookSecret: "s", botUsername: "my_bot" },
  });
  assert.equal(fetchCredentialsCalls.length, 1);
  assert.equal(fetchCredentialsCalls[0], "int-1");
  assert.equal(instance.integrationId, "int-1");
});

test("startInstance reads the verbatim TELEGRAM_BOT_API_KEY credential", async () => {
  const { api } = makeApi({ creds: { TELEGRAM_BOT_API_KEY: "ABC" } });
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  const instance = await startInstance({
    integrationId: "int-2",
    config: { webhookSecret: "x", botUsername: "" },
  });
  const handle = instance.handle as { botToken: string };
  assert.equal(handle.botToken, "ABC");
});

test("startInstance throws when TELEGRAM_BOT_API_KEY credential is missing", async () => {
  const { api } = makeApi({ creds: {} });
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  await assert.rejects(
    startInstance({
      integrationId: "int-3",
      config: { webhookSecret: "x", botUsername: "" },
    }),
    /TELEGRAM_BOT_API_KEY/
  );
});

test("startInstance populates the per-integration registry with webhook secret", async () => {
  const { api } = makeApi({ creds: { TELEGRAM_BOT_API_KEY: "T" } });
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  await startInstance({
    integrationId: "int-4",
    config: { webhookSecret: "s3cret", botUsername: "my_bot" },
  });
  const state = registry.get("int-4");
  assert.ok(state);
  assert.equal(state.webhookSecret, "s3cret");
  assert.equal(state.botUsername, "my_bot");
});

test("startInstance calls telegram-api setWebhook when publicBaseUrl is set", async () => {
  const { api, fetchCalls } = makeApi({
    creds: { TELEGRAM_BOT_API_KEY: "TOK" },
    publicBaseUrl: "https://app.example.com",
  });
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  const instance = await startInstance({
    integrationId: "int-wh",
    config: { webhookSecret: "shh", botUsername: "" },
  });
  const setWebhook = fetchCalls.find((c) => c.url.endsWith("/setWebhook"));
  assert.ok(setWebhook, "setWebhook should have been called");
  assert.equal(
    setWebhook.url,
    "https://api.telegram.org/botTOK/setWebhook"
  );
  assert.deepEqual(setWebhook.body, {
    url: "https://app.example.com/plugins/telegram/webhook/int-wh",
    secret_token: "shh",
  });
  const handle = instance.handle as { webhookAutoRegistered: boolean };
  assert.equal(handle.webhookAutoRegistered, true);
});

test("startInstance skips setWebhook when publicBaseUrl is empty", async () => {
  const { api, fetchCalls } = makeApi({
    creds: { TELEGRAM_BOT_API_KEY: "TOK" },
    publicBaseUrl: "",
  });
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  const instance = await startInstance({
    integrationId: "int-skip",
    config: { webhookSecret: "x", botUsername: "" },
  });
  assert.equal(fetchCalls.length, 0);
  const handle = instance.handle as { webhookAutoRegistered: boolean };
  assert.equal(handle.webhookAutoRegistered, false);
});

test("shutdown removes the integration from the registry and calls deleteWebhook", async () => {
  const { api, fetchCalls } = makeApi({
    creds: { TELEGRAM_BOT_API_KEY: "TOK" },
    publicBaseUrl: "https://app.example.com",
  });
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  const instance = await startInstance({
    integrationId: "int-5",
    config: { webhookSecret: "s", botUsername: "" },
  });
  assert.ok(registry.get("int-5"));
  fetchCalls.length = 0;
  await instance.shutdown();
  assert.equal(registry.get("int-5"), undefined);
  const deleteWebhook = fetchCalls.find((c) =>
    c.url.endsWith("/deleteWebhook")
  );
  assert.ok(deleteWebhook, "deleteWebhook should be called on shutdown");
  assert.equal(
    deleteWebhook.url,
    "https://api.telegram.org/botTOK/deleteWebhook"
  );
});

test("shutdown does not call deleteWebhook when auto-register was skipped", async () => {
  const { api, fetchCalls } = makeApi({
    creds: { TELEGRAM_BOT_API_KEY: "TOK" },
    publicBaseUrl: "",
  });
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  const instance = await startInstance({
    integrationId: "int-6",
    config: { webhookSecret: "s", botUsername: "" },
  });
  fetchCalls.length = 0;
  await instance.shutdown();
  assert.equal(fetchCalls.length, 0);
});

test("buildTelegramThreadJson handles plain channel ids", () => {
  const out = buildTelegramThreadJson("123") as Record<string, unknown>;
  assert.equal(out.channelId, "123");
  assert.equal(out.id, "telegram:123");
  assert.equal(out.isDM, true);
});

test("buildTelegramThreadJson preserves supergroup topic suffix", () => {
  const out = buildTelegramThreadJson("-100456:42") as Record<string, unknown>;
  assert.equal(out.channelId, "-100456");
  assert.equal(out.id, "telegram:-100456:42");
  assert.equal(out.isDM, false);
});

test("buildTelegramThreadJson returns null on blank input", () => {
  assert.equal(buildTelegramThreadJson(""), null);
  assert.equal(buildTelegramThreadJson("   "), null);
});
