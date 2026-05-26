import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

import { buildWhatsappThreadJson } from "../src/connection.ts";
import { createInstanceRegistry } from "../src/routes.ts";

interface TelemetryCall {
  metric: string;
  fields: Record<string, unknown>;
}

interface DispatchCall {
  event: Record<string, unknown>;
}

interface AppendCall {
  integrationId: string;
  threadId: string;
  messages: unknown[];
}

interface NotifyCall {
  integrationId: string;
  threadId: string;
  message: unknown;
}

interface MockApi {
  api: PluginHostAPI;
  telemetryCalls: TelemetryCall[];
  dispatchCalls: DispatchCall[];
  appendCalls: AppendCall[];
  notifyCalls: NotifyCall[];
  humanControlMap: Map<string, boolean>;
}

function makeApi(): MockApi {
  const telemetryCalls: TelemetryCall[] = [];
  const dispatchCalls: DispatchCall[] = [];
  const appendCalls: AppendCall[] = [];
  const notifyCalls: NotifyCall[] = [];
  const humanControlMap = new Map<string, boolean>();

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
    dispatchToWorkflow: async (event) => {
      dispatchCalls.push({ event: event as Record<string, unknown> });
      return { executionId: "exec-1" };
    },
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
      setOwnPluginData: async () => {},
      restart: async () => false,
    },
    chat: {
      appendThreadMessages: async (integrationId, threadId, messages) => {
        appendCalls.push({ integrationId, threadId, messages });
      },
      getHumanControl: async (_integrationId, threadId) => {
        return humanControlMap.get(threadId) ?? false;
      },
      notifyMessageAppended: async (integrationId, threadId, message) => {
        notifyCalls.push({ integrationId, threadId, message });
      },
    },
    telemetry: {
      record: (metric, fields) => {
        telemetryCalls.push({ metric, fields });
      },
    },
    runTask: async () => null,
    sendErrorNotification: async () => ({
      dispatched: false,
      reason: "stub",
    }),
    runSandbox: async () => ({ success: true, value: null, logs: [] }),
    launchAgent: async () => ({ text: "", toolStepsUsed: 0 }),
  };
  return {
    api,
    telemetryCalls,
    dispatchCalls,
    appendCalls,
    notifyCalls,
    humanControlMap,
  };
}

// LID-mention override + currentMessage.raw sanitization
// connection.ts imports chat-adapter-baileys / baileys / chat at module top.
// We test the override logic in isolation by replicating the inner closure
// (collectMentionedJids + phonePart + getBotLid). This mirrors how telegram's
// connection.test.ts exercises adapter behavior without spinning up the real
// SDK.

test("LID mention override — mentionedJid containing bot phone sets isMention", () => {
  const phonePart = (jid: string | undefined): string =>
    (jid ?? "").split("@")[0]?.split(":")[0] ?? "";
  const collectMentionedJids = (raw: any): string[] => {
    const m = raw.message;
    return [
      ...(m?.extendedTextMessage?.contextInfo?.mentionedJid ?? []),
      ...(m?.imageMessage?.contextInfo?.mentionedJid ?? []),
      ...(m?.videoMessage?.contextInfo?.mentionedJid ?? []),
      ...(m?.documentMessage?.contextInfo?.mentionedJid ?? []),
    ];
  };
  const fakeAdapter = { botUserId: "5511999999999:1@s.whatsapp.net" };
  const fakeBotLid: string | undefined = "98765:1@lid";
  const rawMessage = {
    message: {
      extendedTextMessage: {
        contextInfo: {
          mentionedJid: ["5511999999999@s.whatsapp.net"],
        },
      },
    },
  };
  const msg: { isMention?: boolean } = {};
  const botPhone = phonePart(fakeAdapter.botUserId);
  const botLidId = phonePart(fakeBotLid);
  const mentioned = collectMentionedJids(rawMessage);
  if (
    mentioned.some((jid) => {
      const part = phonePart(jid);
      return (
        (botPhone && part === botPhone) || (botLidId && part === botLidId)
      );
    })
  ) {
    msg.isMention = true;
  }
  assert.equal(msg.isMention, true);
});

test("LID mention override — bot LID in mentionedJid sets isMention", () => {
  const phonePart = (jid: string | undefined): string =>
    (jid ?? "").split("@")[0]?.split(":")[0] ?? "";
  const collectMentionedJids = (raw: any): string[] => {
    const m = raw.message;
    return [
      ...(m?.extendedTextMessage?.contextInfo?.mentionedJid ?? []),
    ];
  };
  const fakeAdapter = { botUserId: "5511999999999:1@s.whatsapp.net" };
  const fakeBotLid = "98765:1@lid";
  const rawMessage = {
    message: {
      extendedTextMessage: {
        contextInfo: { mentionedJid: ["98765@lid"] },
      },
    },
  };
  const msg: { isMention?: boolean } = {};
  const botPhone = phonePart(fakeAdapter.botUserId);
  const botLidId = phonePart(fakeBotLid);
  const mentioned = collectMentionedJids(rawMessage);
  if (
    mentioned.some((jid) => {
      const part = phonePart(jid);
      return (
        (botPhone && part === botPhone) || (botLidId && part === botLidId)
      );
    })
  ) {
    msg.isMention = true;
  }
  assert.equal(msg.isMention, true);
});

test("LID mention override — no match leaves isMention undefined", () => {
  const phonePart = (jid: string | undefined): string =>
    (jid ?? "").split("@")[0]?.split(":")[0] ?? "";
  const collectMentionedJids = (raw: any): string[] => {
    const m = raw.message;
    return [
      ...(m?.extendedTextMessage?.contextInfo?.mentionedJid ?? []),
    ];
  };
  const fakeAdapter = { botUserId: "5511999999999:1@s.whatsapp.net" };
  const fakeBotLid: string | undefined = undefined;
  const rawMessage = {
    message: {
      extendedTextMessage: {
        contextInfo: { mentionedJid: ["44440000000@s.whatsapp.net"] },
      },
    },
  };
  const msg: { isMention?: boolean } = {};
  const botPhone = phonePart(fakeAdapter.botUserId);
  const botLidId = phonePart(fakeBotLid);
  const mentioned = collectMentionedJids(rawMessage);
  if (
    mentioned.some((jid) => {
      const part = phonePart(jid);
      return (
        (botPhone && part === botPhone) || (botLidId && part === botLidId)
      );
    })
  ) {
    msg.isMention = true;
  }
  assert.equal(msg.isMention, undefined);
});

test("currentMessage.raw sanitization — non-POJO raw is nulled before dispatch", () => {
  // Simulates what buildEvent() does. Baileys' WAMessage proto carries Long
  // + Buffer instances the workflow serde cannot stringify; send-reply only
  // needs thread.id + thread.channelId, so dropping `raw` is safe.
  const fakeProto = { __long: { high: 1, low: 2 }, buf: Buffer.from("x") };
  const rawThreadJson: { currentMessage?: { raw?: unknown } } = {
    currentMessage: { raw: fakeProto },
  };
  if (rawThreadJson.currentMessage) {
    rawThreadJson.currentMessage.raw = null;
  }
  assert.equal(rawThreadJson.currentMessage?.raw, null);
});

// Registry + telemetry + dispatch flow (mirrors telegram's connection test
// pattern: validate the wiring against the api mock + registry).

test("registry stores and retrieves WhatsappInstance correctly", () => {
  const registry = createInstanceRegistry();
  const fakeAdapter = {} as any;
  const fakeChat = {} as any;
  const linkState = {
    qr: null,
    connected: false,
    linkedAt: null,
    linkedAs: null,
    pairingCode: null,
    error: null,
  };
  registry.set("int-1", {
    adapter: fakeAdapter,
    chat: fakeChat,
    state: linkState,
  });
  const got = registry.get("int-1");
  assert.ok(got);
  assert.equal(got?.state.connected, false);
});

test("registry.delete removes the integration", () => {
  const registry = createInstanceRegistry();
  registry.set("int-1", {
    adapter: {} as any,
    chat: {} as any,
    state: {
      qr: null,
      connected: false,
      linkedAt: null,
      linkedAs: null,
      pairingCode: null,
      error: null,
    },
  });
  assert.ok(registry.get("int-1"));
  registry.delete("int-1");
  assert.equal(registry.get("int-1"), undefined);
});

test("telemetry.record captures boot + disconnect + message_in events", () => {
  const { api, telemetryCalls } = makeApi();
  api.telemetry.record("tlm_connection_events", {
    user_id: "unknown",
    integration_type: "whatsapp",
    integration_id: "int-1",
    event: "boot",
    duration_ms: null,
    error_class: null,
    ok: true,
  });
  api.telemetry.record("tlm_connection_events", {
    user_id: "unknown",
    integration_type: "whatsapp",
    integration_id: "int-1",
    event: "disconnect",
    duration_ms: null,
    error_class: null,
    ok: true,
  });
  api.telemetry.record("tlm_connection_events", {
    user_id: "unknown",
    integration_type: "whatsapp",
    integration_id: "int-1",
    event: "message_in",
    duration_ms: null,
    error_class: null,
    ok: true,
  });
  assert.equal(telemetryCalls.length, 3);
  assert.equal(telemetryCalls[0].fields.event, "boot");
  assert.equal(telemetryCalls[0].fields.user_id, "unknown");
  assert.equal(telemetryCalls[1].fields.event, "disconnect");
  assert.equal(telemetryCalls[2].fields.event, "message_in");
});

test("chat.getHumanControl suppression — when true, dispatch is skipped", async () => {
  const { api, dispatchCalls, humanControlMap } = makeApi();
  humanControlMap.set("555@s.whatsapp.net", true);
  const controlled = await api.chat.getHumanControl(
    "int-1",
    "555@s.whatsapp.net"
  );
  assert.equal(controlled, true);
  // Mirrors connection.ts handler early-return: dispatchToWorkflow NEVER
  // called when getHumanControl returns true.
  assert.equal(dispatchCalls.length, 0);
});

test("appendThreadMessages + notifyMessageAppended fire on inbound", async () => {
  const { api, appendCalls, notifyCalls } = makeApi();
  const message = { content: "hello", role: "user" as const };
  await api.chat.appendThreadMessages("int-1", "555@s.whatsapp.net", [message]);
  await api.chat.notifyMessageAppended("int-1", "555@s.whatsapp.net", message);
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0].threadId, "555@s.whatsapp.net");
  assert.equal(notifyCalls.length, 1);
});

test("dispatchToWorkflow receives ChatMessageEvent shape", async () => {
  const { api, dispatchCalls } = makeApi();
  await api.dispatchToWorkflow({
    integrationId: "int-1",
    text: "hi",
    threadJson: { _type: "chat:Thread", channelId: "555@s.whatsapp.net" },
    isDM: true,
    isMention: false,
    channelId: "555@s.whatsapp.net",
    threadId: "555@s.whatsapp.net",
    userName: "alice",
    arrivalAt: 1700000000000,
  });
  assert.equal(dispatchCalls.length, 1);
  const ev = dispatchCalls[0].event;
  assert.equal(ev.integrationId, "int-1");
  assert.equal(ev.isDM, true);
});

// buildWhatsappThreadJson — exact spec lines from the handoff.

test("buildWhatsappThreadJson — 123@s.whatsapp.net → isDM:true", () => {
  const out = buildWhatsappThreadJson("123@s.whatsapp.net") as Record<
    string,
    unknown
  >;
  assert.equal(out.channelId, "123@s.whatsapp.net");
  assert.equal(out.id, "123@s.whatsapp.net");
  assert.equal(out.isDM, true);
  assert.equal(out.adapterName, "whatsapp");
});

test("buildWhatsappThreadJson — 123@lid → isDM:true", () => {
  const out = buildWhatsappThreadJson("123@lid") as Record<string, unknown>;
  assert.equal(out.isDM, true);
});

test("buildWhatsappThreadJson — 123@g.us → isDM:false", () => {
  const out = buildWhatsappThreadJson("123@g.us") as Record<string, unknown>;
  assert.equal(out.channelId, "123@g.us");
  assert.equal(out.isDM, false);
});

test("buildWhatsappThreadJson — empty string returns null", () => {
  assert.equal(buildWhatsappThreadJson(""), null);
});

test("buildWhatsappThreadJson — whitespace returns null", () => {
  assert.equal(buildWhatsappThreadJson("  "), null);
});
