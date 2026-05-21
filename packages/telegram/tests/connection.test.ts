import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

import {
  buildTelegramThreadJson,
  makeStartInstance,
} from "../src/connection.ts";
import { createInstanceRegistry } from "../src/webhook.ts";

interface MockApi {
  api: PluginHostAPI;
  fetchCredentialsCalls: string[];
}

function makeApi(creds: Record<string, string | undefined>): MockApi {
  const fetchCredentialsCalls: string[] = [];
  const api: PluginHostAPI = {
    db: { read: async () => [], write: async () => {} },
    fetch: (async () => new Response("{}")) as PluginHostAPI["fetch"],
    fetchCredentials: async (id: string) => {
      fetchCredentialsCalls.push(id);
      return creds;
    },
    llm: { call: async () => ({ text: "" }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerIntegration: () => {},
    registerRoute: () => {},
    registerStep: () => {},
    registerTool: () => {},
    registerConnection: () => {},
    dispatchToWorkflow: async () => null,
  };
  return { api, fetchCredentialsCalls };
}

test("startInstance calls fetchCredentials with the integrationId", async () => {
  const { api, fetchCredentialsCalls } = makeApi({ botToken: "T" });
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

test("startInstance reads TELEGRAM_BOT_API_KEY as a fallback credential key", async () => {
  const { api } = makeApi({ TELEGRAM_BOT_API_KEY: "ABC" });
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  const instance = await startInstance({
    integrationId: "int-2",
    config: { webhookSecret: "x", botUsername: "" },
  });
  const handle = instance.handle as { botToken: string };
  assert.equal(handle.botToken, "ABC");
});

test("startInstance throws when no bot token credential is present", async () => {
  const { api } = makeApi({});
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  await assert.rejects(
    startInstance({
      integrationId: "int-3",
      config: { webhookSecret: "x", botUsername: "" },
    }),
    /missing botToken/
  );
});

test("startInstance populates the per-integration registry with webhook secret", async () => {
  const { api } = makeApi({ botToken: "T" });
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

test("shutdown removes the integration from the registry", async () => {
  const { api } = makeApi({ botToken: "T" });
  const registry = createInstanceRegistry();
  const startInstance = makeStartInstance({ api, registry });
  const instance = await startInstance({
    integrationId: "int-5",
    config: { webhookSecret: "s", botUsername: "" },
  });
  assert.ok(registry.get("int-5"));
  await instance.shutdown();
  assert.equal(registry.get("int-5"), undefined);
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
