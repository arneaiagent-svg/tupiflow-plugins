import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  PluginHostAPI,
  RouteContext,
} from "@tupiflow-plugins/shared/host-api-types";

import {
  createInstanceRegistry,
  makeWhatsappQrHandler,
  makeWhatsappResetHandler,
} from "../src/routes.ts";
import { getLinkStates } from "../src/link-state.ts";

interface JsonCall {
  body: unknown;
  status: number | undefined;
}

function makeCtx(opts: {
  integrationId: string;
  abilities?: string[];
  userId?: string;
}): { ctx: RouteContext; calls: JsonCall[] } {
  const calls: JsonCall[] = [];
  const ctx: RouteContext = {
    json: (body: unknown, status?: number) => {
      calls.push({ body, status });
      return { body, status };
    },
    req: {
      header: () => undefined,
      json: (async () => ({})) as RouteContext["req"]["json"],
      query: () => undefined,
      param: (name: string) =>
        name === "integrationId" ? opts.integrationId : "",
      raw: new Request("https://example.test/"),
    },
    userId: opts.userId ?? "user-1",
    abilities: opts.abilities ?? ["read:Integration", "update:Integration"],
  };
  return { ctx, calls };
}

function makeApi(opts?: {
  runTaskImpl?: (workerId: string, input: unknown) => Promise<unknown>;
  restartImpl?: (id: string) => Promise<boolean>;
  restartUndefined?: boolean;
  integrationsList?: Array<{
    id: string;
    userId: string;
    name: string;
    type: string;
    isManaged: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
}): PluginHostAPI {
  const integrationsList =
    opts?.integrationsList ?? [
      {
        id: "int-1",
        userId: "user-1",
        name: "WA Test",
        type: "whatsapp",
        isManaged: false,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ];
  const baseConnections = {
    types: async () => [],
    sendReply: async () => ({ delivered: false, threadId: "stub" }),
    shutdownPeer: async () => false,
    setOwnPluginData: async () => {},
  } as PluginHostAPI["connections"];
  const connections = opts?.restartUndefined
    ? baseConnections
    : {
        ...baseConnections,
        restart:
          opts?.restartImpl ??
          (async () => true),
      };
  return {
    db: { read: async () => [], write: async () => {} },
    fetch: (async () =>
      new Response(JSON.stringify({ ok: true }))) as PluginHostAPI["fetch"],
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
    registerAgentToolRuntimeOverrides: () => {},
    registerTakeoverTarget: () => {},
    workflow: {
      create: async () => ({
        id: "w",
        name: "n",
        description: null,
        visibility: "private",
        isSystem: false,
        userId: "u",
        nodes: [],
        edges: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
      get: async () => null,
      list: async () => ({ items: [], nextCursor: null }),
      createExecution: async () => ({
        executionId: "x",
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
      list: async () => integrationsList,
      describe: async () => null,
    },
    connections,
    chat: {
      appendThreadMessages: async () => {},
      getHumanControl: async () => false,
      notifyMessageAppended: async () => {},
    },
    telemetry: { record: () => {} },
    runTask: opts?.runTaskImpl ?? (async () => null),
    sendErrorNotification: async () => ({ dispatched: false, reason: "" }),
    runSandbox: async () => ({ success: true, value: null, logs: [] }),
    launchAgent: async () => ({ text: "", toolStepsUsed: 0 }),
  };
}

// Make sure CONNECTION_CHAT_DATABASE_URL is empty so wipeChatStateForIntegration
// early-returns instead of attempting a real postgres() connection. The test
// runner inherits the developer's env, so we explicitly delete it per test
// that touches the reset path.
function clearChatDbUrl(): () => void {
  const prev = process.env.CONNECTION_CHAT_DATABASE_URL;
  delete process.env.CONNECTION_CHAT_DATABASE_URL;
  return () => {
    if (prev !== undefined) {
      process.env.CONNECTION_CHAT_DATABASE_URL = prev;
    }
  };
}

// Isolate WHATSAPP_SESSION_DIR so reset-path tests cannot rmSync a real
// Baileys session directory if the developer has the env var set.
function withTempSessionDir(): () => void {
  const prev = process.env.WHATSAPP_SESSION_DIR;
  const tmp = mkdtempSync(join(tmpdir(), "whatsapp-sessions-"));
  process.env.WHATSAPP_SESSION_DIR = tmp;
  return () => {
    if (prev === undefined) {
      delete process.env.WHATSAPP_SESSION_DIR;
    } else {
      process.env.WHATSAPP_SESSION_DIR = prev;
    }
    rmSync(tmp, { recursive: true, force: true });
  };
}

// QR handler tests

test("QR — no link-state returns connected:false with error message", async () => {
  // Wipe the global link-state map before the test so no leftover state from
  // a sibling test leaks in.
  getLinkStates().clear();
  const api = makeApi();
  const registry = createInstanceRegistry();
  const handler = makeWhatsappQrHandler({ api, registry });
  const { ctx, calls } = makeCtx({ integrationId: "int-1" });
  await handler(ctx);
  const first = calls[0];
  assert.ok(first);
  const body = first.body as Record<string, unknown>;
  assert.equal(body.connected, false);
  assert.match(String(body.error), /not running/i);
});

test("QR — with state.qr set, calls api.runTask('whatsapp-qr-encode',{text,margin,scale}) and returns qrDataUrl", async () => {
  getLinkStates().clear();
  getLinkStates().set("int-1", {
    qr: "QR-PAYLOAD-XYZ",
    connected: false,
    linkedAt: null,
    linkedAs: null,
    pairingCode: null,
    error: null,
  });
  let runTaskInput: any = null;
  let runTaskId: string | null = null;
  const api = makeApi({
    runTaskImpl: async (workerId, input) => {
      runTaskId = workerId;
      runTaskInput = input;
      return { ok: true, dataUrl: "data:image/png;base64,FAKE" };
    },
  });
  const registry = createInstanceRegistry();
  const handler = makeWhatsappQrHandler({ api, registry });
  const { ctx, calls } = makeCtx({ integrationId: "int-1" });
  await handler(ctx);
  assert.equal(runTaskId, "whatsapp-qr-encode");
  assert.equal(runTaskInput.text, "QR-PAYLOAD-XYZ");
  assert.equal(runTaskInput.margin, 1);
  assert.equal(runTaskInput.scale, 6);
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(body.qrDataUrl, "data:image/png;base64,FAKE");
  getLinkStates().clear();
});

test("QR — state.connected:true returns linkedAs and qrDataUrl:null", async () => {
  getLinkStates().clear();
  getLinkStates().set("int-1", {
    qr: null,
    connected: true,
    linkedAt: 1,
    linkedAs: "5511999999999",
    pairingCode: null,
    error: null,
  });
  const api = makeApi();
  const registry = createInstanceRegistry();
  const handler = makeWhatsappQrHandler({ api, registry });
  const { ctx, calls } = makeCtx({ integrationId: "int-1" });
  await handler(ctx);
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(body.connected, true);
  assert.equal(body.linkedAs, "5511999999999");
  assert.equal(body.qrDataUrl, null);
  getLinkStates().clear();
});

test("QR — missing required ability returns 403", async () => {
  const api = makeApi();
  const registry = createInstanceRegistry();
  const handler = makeWhatsappQrHandler({ api, registry });
  const { ctx, calls } = makeCtx({
    integrationId: "int-1",
    abilities: [],
  });
  await handler(ctx);
  assert.equal(calls[0].status, 403);
});

// Reset handler tests

test("Reset — feature-detect api.connections.restart undefined returns 500 with descriptive error", async () => {
  const restore = clearChatDbUrl();
  try {
    const api = makeApi({ restartUndefined: true });
    const registry = createInstanceRegistry();
    const handler = makeWhatsappResetHandler({ api, registry });
    const { ctx, calls } = makeCtx({ integrationId: "int-1" });
    await handler(ctx);
    assert.equal(calls[0].status, 500);
    const body = calls[0].body as Record<string, unknown>;
    assert.match(String(body.error), /restart/);
    assert.match(String(body.error), /upgrade tupiflow/);
  } finally {
    restore();
  }
});

test("Reset — happy path calls api.connections.restart and returns success", async () => {
  const restore = clearChatDbUrl();
  const restoreSessionDir = withTempSessionDir();
  try {
    const restartCalls: string[] = [];
    const api = makeApi({
      restartImpl: async (id: string) => {
        restartCalls.push(id);
        return true;
      },
    });
    const registry = createInstanceRegistry();
    const handler = makeWhatsappResetHandler({ api, registry });
    const { ctx, calls } = makeCtx({ integrationId: "int-1" });
    await handler(ctx);
    assert.equal(restartCalls.length, 1);
    assert.equal(restartCalls[0], "int-1");
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.success, true);
  } finally {
    restoreSessionDir();
    restore();
  }
});

test("Reset — IntegrationOwnershipError thrown by restart surfaces as 403", async () => {
  const restore = clearChatDbUrl();
  const restoreSessionDir = withTempSessionDir();
  try {
    const api = makeApi({
      restartImpl: async () => {
        const err = new Error("not yours");
        err.name = "IntegrationOwnershipError";
        throw err;
      },
    });
    const registry = createInstanceRegistry();
    const handler = makeWhatsappResetHandler({ api, registry });
    const { ctx, calls } = makeCtx({ integrationId: "int-1" });
    await handler(ctx);
    assert.equal(calls[0].status, 403);
  } finally {
    restoreSessionDir();
    restore();
  }
});

test("Reset — missing update:Integration ability returns 403", async () => {
  const api = makeApi();
  const registry = createInstanceRegistry();
  const handler = makeWhatsappResetHandler({ api, registry });
  const { ctx, calls } = makeCtx({
    integrationId: "int-1",
    abilities: ["read:Integration"],
  });
  await handler(ctx);
  assert.equal(calls[0].status, 403);
});

test("Reset — caller does NOT own integration returns 404 BEFORE wipe", async () => {
  const restore = clearChatDbUrl();
  const restoreSessionDir = withTempSessionDir();
  try {
    // integrations.list returns empty → caller does not own int-foreign.
    // Reset MUST return 404 without invoking restart() or rmSync.
    const restartCalls: string[] = [];
    const api = makeApi({
      integrationsList: [],
      restartImpl: async (id: string) => {
        restartCalls.push(id);
        return true;
      },
    });
    const registry = createInstanceRegistry();
    const handler = makeWhatsappResetHandler({ api, registry });
    const { ctx, calls } = makeCtx({ integrationId: "int-foreign" });
    await handler(ctx);
    assert.equal(calls[0].status, 404);
    assert.equal(
      restartCalls.length,
      0,
      "restart MUST NOT be called when ownership check fails"
    );
  } finally {
    restoreSessionDir();
    restore();
  }
});

test("Reset — missing integrationId param returns 400", async () => {
  const restore = clearChatDbUrl();
  try {
    const api = makeApi();
    const registry = createInstanceRegistry();
    const handler = makeWhatsappResetHandler({ api, registry });
    const { ctx, calls } = makeCtx({ integrationId: "" });
    await handler(ctx);
    assert.equal(calls[0].status, 400);
  } finally {
    restore();
  }
});
