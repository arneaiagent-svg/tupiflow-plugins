// Type-level fixture. Verifies the shim PluginHostAPI surface is rich
// enough for a non-trivial plugin to type-check end-to-end:
//
//   - api.fetchCredentials(integrationId)
//   - api.db.read(sql)
//   - api.fetch(url)
//   - api.registerRoute(method, path, handler) — handler reads ctx.req.header()
//
// This file is loaded by `tsc --noEmit` via the package's `type-check`
// script; if any of the calls below stop type-checking, the build fails.
//
// There is no runtime assertion — the file is type-only. The trailing
// `void usage` reference exists solely to satisfy `noUnusedLocals` style
// checks if anyone enables them; `usage` is `unknown` to avoid runtime
// import side-effects.

import {
  MissingNpmDepError,
  NpmDepNotAllowedError,
  WorkerCapabilityDeniedError,
  WorkerNotFoundError,
  WorkerTimeoutError,
} from "./host-api-types.ts";
import type {
  Action,
  ActionsSpec,
  AgentCreateSpec,
  AgentListItem,
  AgentUpdatePatch,
  ButtonSpec,
  CardSpec,
  ChatMessage,
  ChatMessageEvent,
  ConnectionInstance,
  ConnectionSendReplyResult,
  ConnectionSendReplySpec,
  CreateExecutionResult,
  DbCallOpts,
  EmbedArgs,
  EmbedResult,
  ExecutionLogEntry,
  IntegrationConfigPatch,
  IntegrationListItem,
  IntegrationSpec,
  LaunchAgentOpts,
  LaunchAgentResult,
  PluginHostAPI,
  RegistryStepInput,
  RouteContext,
  SandboxOpts,
  SandboxResult,
  StepResult,
  TakeoverTargetSpec,
  TestIntegrationResult,
  TestIntegrationSpec,
  Tool,
  ToolCatalogContext,
  ToolCatalogEntry,
  WorkerSpec,
  Workflow,
  WorkflowCreateSpec,
  WorkflowExecution,
  WorkflowListPage,
} from "./host-api-types.ts";

// biome-ignore lint/correctness/noUnusedVariables: type-level fixture
async function _registerPluginFixture(api: PluginHostAPI): Promise<void> {
  // integration registration — existing surface
  api.registerIntegration({
    type: "fixture",
    label: "Fixture",
    formFields: [],
    actions: [
      {
        slug: "echo",
        label: "Echo",
        stepFunction: "echoStep",
      },
    ],
  });

  // step registration — handler returns a StepResult
  api.registerStep("echoStep", async (input: unknown): Promise<StepResult> => {
    api.logger.info("echo step invoked", { input });
    return { success: true, data: input };
  });

  // tool registration with an opaque schema
  api.registerTool("fixture_echo", { type: "object" }, async (input: unknown) => {
    return input;
  });

  // route registration — handler reads ctx.req.header / .json / .query / .param / .raw
  // plus the Phase 4e.2 §2.3 RouteContext.userId / abilities additions
  api.registerRoute("POST", "/hook", async (ctx: RouteContext) => {
    const auth: string | undefined = ctx.req.header("authorization");
    const id: string = ctx.req.param("id");
    const limit: string | undefined = ctx.req.query("limit");
    const body: unknown = await ctx.req.json();
    const raw: Request = ctx.req.raw;
    const callerId: string = ctx.userId;
    const callerAbilities: string[] = ctx.abilities;
    const canUpdateIntegration: boolean = ctx.abilities.includes(
      "update:Integration",
    );
    void auth;
    void id;
    void limit;
    void body;
    void raw;
    void callerId;
    void callerAbilities;
    void canUpdateIntegration;
    return ctx.json({ ok: true }, 200);
  });

  // db / fetch / fetchCredentials / llm — newly added surface
  const rows: unknown[] = await api.db.read("SELECT 1");
  void rows;
  await api.db.write("UPDATE x SET y = 1");
  const creds: Record<string, string | undefined> = await api.fetchCredentials("int-123");
  void creds;
  const response: Response = await api.fetch("https://example.com");
  void response;
  const llmResult = await api.llm.call({
    model: "anthropic/claude-haiku-4-5-20251001",
    prompt: "hi",
    maxTokens: 16,
  });
  const text: string = llmResult.text;
  void text;
  api.logger.warn("done");
  api.logger.error("done", { context: "fixture" });

  // Phase 4b — llm.embed + llm.embedBatch (gated on existing llm.call cap)
  const embedOpts: EmbedArgs = {
    model: "openai/text-embedding-3-small",
    providerIntegrationId: "int-openai-1",
  };
  const embedResult: EmbedResult = await api.llm.embed("hello world", embedOpts);
  const vector: number[] = embedResult.vector;
  const dimensions: number = embedResult.dimensions;
  const embedModel: string = embedResult.model;
  void vector;
  void dimensions;
  void embedModel;

  // also accept the zero-arg opts form
  const embedNoOpts: EmbedResult = await api.llm.embed("just text");
  void embedNoOpts;

  const embedBatchResult: EmbedResult[] = await api.llm.embedBatch(
    ["a", "b", "c"],
    embedOpts,
  );
  const first: EmbedResult | undefined = embedBatchResult[0];
  void first;

  // construct a fake matching value to assert structural compat
  const fakeEmbed: EmbedResult = {
    vector: [0.1, 0.2, 0.3],
    dimensions: 1024,
    model: "openai/text-embedding-3-small",
  };
  void fakeEmbed;

  // Phase 4a.2 — connection lifecycle + workflow dispatch
  api.registerConnection({
    startInstance: async ({
      integrationId,
      config,
    }): Promise<ConnectionInstance> => {
      void config;
      return {
        integrationId,
        handle: { opaque: true },
        shutdown: async () => {
          /* tear down */
        },
      };
    },
    buildThreadJson: (chatId: string) => ({ adapterName: "fixture", chatId }),
    replyActionId: "fixture/send-reply",
  });

  const event: ChatMessageEvent = {
    integrationId: "int-1",
    text: "hi",
    threadJson: { id: "fixture:1" },
    isDM: true,
    isMention: false,
    channelId: "ch-1",
    threadId: "fixture:1",
    userName: "alice",
    arrivalAt: Date.now(),
    imageUrls: [],
    fileUrls: [],
    audioUrls: [],
    videoUrls: [],
  };
  const dispatched: { executionId: string } | null = await api.dispatchToWorkflow(event);
  void dispatched;

  // Phase 4e.2 §2.1 — testIntegration + registerTestHandler
  api.registerTestHandler(async ({ integrationId, credentials, opts }) => {
    void integrationId;
    void credentials;
    void opts;
    const result: TestIntegrationResult = { success: true };
    return result;
  });
  const testSpec: TestIntegrationSpec = {
    integrationType: "fixture",
    integrationId: "int-fixture-1",
    opts: { testModelId: "gpt-4o" },
  };
  const testResult: TestIntegrationResult = await api.testIntegration(testSpec);
  void testResult;

  // Phase 4e.2 §2.2 — updateIntegrationConfig (deep-merge into pluginData)
  const patch: IntegrationConfigPatch = {
    pluginData: {
      cachedTools: [{ name: "search", description: "do search" }],
      toolsRefreshedAt: new Date().toISOString(),
    },
  };
  await api.updateIntegrationConfig("int-fixture-1", patch);

  // Phase 4e.2 §2.4 — registerToolCatalogContributor
  api.registerToolCatalogContributor(
    async (ctx: ToolCatalogContext): Promise<ToolCatalogEntry[]> => {
      void ctx.userId;
      void ctx.integrationId;
      return [
        {
          entryKey: `${ctx.integrationId}:echo`,
          actionId: `fixture:${ctx.integrationId}:echo`,
          actionLabel: "Echo",
          category: "Fixture",
          integrationId: ctx.integrationId,
          integrationLabel: "Fixture",
          configured: true,
          tool: {
            name: "fixture__echo",
            description: "Echo input back unchanged.",
            inputSchemaJson: '{"type":"object"}',
          },
        },
      ];
    },
  );

  // Phase 4e.2 §2.5 — registerTakeoverTarget
  const takeoverSpec: TakeoverTargetSpec = {
    label: "Request human takeover",
    description: "Hand the conversation over to a human operator.",
  };
  api.registerTakeoverTarget("fixture/request-human-takeover", takeoverSpec);

  // Phase 4e.2 §2.6 — api.workflow.{get, list, createExecution, getExecutionLogs}
  const workflow: Workflow | null = await api.workflow.get("wf-1");
  if (workflow !== null) {
    const ownerId: string = workflow.userId;
    // nodes is optional (WorkflowNode[] | undefined) since batch 2
    const nodeCount: number = workflow.nodes?.length ?? 0;
    void ownerId;
    void nodeCount;
  }
  const page: WorkflowListPage = await api.workflow.list({
    userId: "user-1",
    limit: 50,
    cursor: undefined,
  });
  const items = page.items;
  const nextCursor: string | null = page.nextCursor;
  void items;
  void nextCursor;
  const exec: CreateExecutionResult = await api.workflow.createExecution({
    workflowId: "wf-1",
    input: { greeting: "hello" },
  });
  void exec;
  const logs: ExecutionLogEntry[] = await api.workflow.getExecutionLogs(
    exec.executionId,
  );
  void logs;

  // Phase 4e.2 §2.7 — registerRegistryStep with the RegistryStepInput envelope
  api.registerRegistryStep(
    "fixture/registry-step",
    async ({ api: stepApi, ctx }: RegistryStepInput): Promise<StepResult> => {
      const workflowId: string = ctx.workflowId;
      const userId: string = ctx.userId;
      void workflowId;
      void userId;
      stepApi.logger.info("registry step invoked", { nodeId: ctx.nodeId });
      return { success: true, data: ctx.input };
    },
  );

  // Phase 4e.5 batch 1 — db opts.schema + 7 new wrappers
  const dbOpts: DbCallOpts = { schema: "public" };
  const publicRows: unknown[] = await api.db.read(
    "SELECT id FROM workflows WHERE user_id = $1",
    ["u-1"],
    dbOpts,
  );
  void publicRows;
  await api.db.write(
    "UPDATE agents SET name = $1 WHERE slug = $2",
    ["Renamed", "support-bot"],
    { schema: "public" },
  );

  // §4e.5 api.workflow.create — publisher-gated
  const createSpec: WorkflowCreateSpec = {
    name: "Generated flow",
    nodes: [],
    edges: [],
    visibility: "private",
  };
  const created: Workflow = await api.workflow.create(createSpec);
  void created;

  // §4e.5 api.agents.{list,create,update,delete} — list reuses db.read,
  // mutations publisher-gated. Slug must match /^[a-z0-9][a-z0-9-]*$/.
  const agents: AgentListItem[] = await api.agents.list({
    slugPrefix: "support",
  });
  void agents;
  const newAgentSpec: AgentCreateSpec = {
    slug: "demo-agent",
    name: "Demo agent",
    body: "system prompt",
    historyLimit: 20,
    showToolTrace: true,
  };
  const newAgent: AgentListItem = await api.agents.create(newAgentSpec);
  void newAgent;
  const agentPatch: AgentUpdatePatch = { name: "Renamed" };
  const updated: AgentListItem = await api.agents.update(
    "demo-agent",
    agentPatch,
  );
  void updated;
  await api.agents.delete("demo-agent");

  // §4e.5 api.integrations.list — tenant-scoped
  const integrations: IntegrationListItem[] = await api.integrations.list({
    type: "telegram",
  });
  void integrations;

  // §4e.5 api.connections.types — read-only catalog
  const connectionTypes: string[] = await api.connections.types();
  void connectionTypes;

  // Phase 4f batch 1 — api.runTask + WorkerSpec + named errors
  const workerSpec: WorkerSpec = {
    id: "parse-html",
    entry: "workers/parse-html.mjs",
    memLimitMb: 128,
    timeoutMs: 10_000,
  };
  void workerSpec;
  // Zero-opts form (no memLimitMb / timeoutMs).
  const minimalWorker: WorkerSpec = {
    id: "noop",
    entry: "workers/noop.mjs",
  };
  void minimalWorker;
  const taskResult: unknown = await api.runTask("parse-html", { html: "" });
  void taskResult;
  const taskResultWithOpts: unknown = await api.runTask(
    "parse-html",
    { html: "" },
    { timeoutMs: 5_000 },
  );
  void taskResultWithOpts;
  // Each named error is constructible and structurally an Error.
  const notFound: Error = new WorkerNotFoundError("parse-html");
  const timedOut: Error = new WorkerTimeoutError("parse-html", 10_000);
  const denied: Error = new WorkerCapabilityDeniedError();
  void notFound;
  void timedOut;
  void denied;

  // Phase 4f batch 2 — MissingNpmDepError + NpmDepNotAllowedError type-level
  // construction + custom-field reads. Both forms of MissingNpmDepError
  // (with and without installedVersion) must compile.
  const missingNotInstalled: MissingNpmDepError = new MissingNpmDepError(
    "jsdom",
    "^22.0.0",
  );
  const missingName: string = missingNotInstalled.depName;
  const missingRange: string = missingNotInstalled.declaredRange;
  const missingInstalled: string | undefined = missingNotInstalled.installedVersion;
  void missingName;
  void missingRange;
  void missingInstalled;

  const missingOutOfRange: MissingNpmDepError = new MissingNpmDepError(
    "@mozilla/readability",
    "^0.5.0",
    "0.4.4",
  );
  const installed: string | undefined = missingOutOfRange.installedVersion;
  void installed;

  const notAllowed: NpmDepNotAllowedError = new NpmDepNotAllowedError(
    "left-pad",
  );
  const notAllowedName: string = notAllowed.depName;
  void notAllowedName;

  // Structural-Error compat (parallel to the worker errors above).
  const missingAsError: Error = missingNotInstalled;
  const notAllowedAsError: Error = notAllowed;
  void missingAsError;
  void notAllowedAsError;

  // Phase 4e.5 batch 2 — new host surfaces
  // workflow.listExecutions
  const executions: WorkflowExecution[] = await api.workflow.listExecutions({
    workflowId: "wf-1",
    limit: 25,
  });
  void executions;

  // api.actions.list
  const actions: Action[] = await api.actions.list();
  void actions;

  // api.tools.list
  const tools: Tool[] = await api.tools.list();
  void tools;

  // api.integrations.describe — returns IntegrationSpec | null
  const spec: IntegrationSpec | null = await api.integrations.describe("telegram");
  if (spec !== null) {
    const iType: string = spec.type;
    const iLabel: string = spec.label;
    void iType;
    void iLabel;
  }

  // Phase 4e.5 batch 5 — api.runSandbox type verification
  const sandboxOpts: SandboxOpts = { timeoutMs: 2000, memoryLimitMb: 64 };
  const sandResult: SandboxResult = await api.runSandbox("return 42;", { data: {} }, sandboxOpts);
  if (sandResult.success) {
    const val: unknown = sandResult.value;
    const logs: string[] = sandResult.logs;
    void val;
    void logs;
  } else {
    const errKind: string = sandResult.error.kind;
    const errMsg: string = sandResult.error.message;
    const logs: string[] = sandResult.logs;
    void errKind;
    void errMsg;
    void logs;
  }

  // Phase 4e.5 batch 4b — api.connections.sendReply type verification
  const sendReplySpec: ConnectionSendReplySpec = {
    integrationId: "connection-1",
    threadJson: "{}",
    text: "Hello, reply!",
  };
  const sendReplyResult: ConnectionSendReplyResult = await api.connections.sendReply(sendReplySpec);
  const delivered: boolean = sendReplyResult.delivered;
  const msgId: string | undefined = sendReplyResult.messageId;
  const threadId: string = sendReplyResult.threadId;
  void delivered;
  void msgId;
  void threadId;

  // Phase 4e.5 batch 4a — api.launchAgent type verification
  const launchOpts: LaunchAgentOpts = {
    providerOverride: "openai",
    modelOverride: "gpt-5-mini",
    connectionIntegrationId: "connection-1",
    connectionThreadJson: "{}",
    maxToolSteps: 5,
  };
  const launchResult: LaunchAgentResult = await api.launchAgent("my-agent", "Hello agent!", launchOpts);
  const responseText: string = launchResult.text;
  const toolSteps: number = launchResult.toolStepsUsed;
  void responseText;
  void toolSteps;

  // Phase 4e.5 batch 5b — api.chat.* surfaces
  const inboundMessage: ChatMessage = {
    role: "user",
    content: "hi from telegram",
    createdAt: new Date().toISOString(),
  };
  const multimodalMessage: ChatMessage = {
    role: "assistant",
    source: "ai",
    content: [
      { type: "text", text: "see attached" },
      { type: "image", image: "https://example.com/foo.png" },
    ],
  };
  void multimodalMessage;
  const humanControlled: boolean = await api.chat.getHumanControl(
    "int-telegram-1",
    "thread-1"
  );
  void humanControlled;
  await api.chat.appendThreadMessages(
    "int-telegram-1",
    "thread-1",
    [inboundMessage],
    "operator-user-1",
    { adapterName: "telegram", chatId: "1" }
  );
  await api.chat.notifyMessageAppended(
    "int-telegram-1",
    "thread-1",
    inboundMessage
  );

  // Phase 4e.5 batch 5b — api.telemetry.record
  api.telemetry.record("tlm_connection_events", {
    integrationId: "int-telegram-1",
    kind: "inbound",
  });

  // Phase 4e.5 batch 5b — api.connections.shutdownPeer
  const peerShutdown: boolean = await api.connections.shutdownPeer(
    "int-telegram-1"
  );
  void peerShutdown;

  // Phase 4e.5 batch 5b — sendReply discriminated-union variants
  const replyButton: ButtonSpec = {
    kind: "url",
    text: "Docs",
    url: "https://example.com",
  };
  const replyCard: CardSpec = {
    text: "Pick an option",
    buttons: [replyButton, { kind: "callback", text: "Yes", data: "yes" }],
  };
  const replyActions: ActionsSpec = {
    text: "Choose one",
    buttons: [{ kind: "webapp", text: "Open", url: "https://example.com" }],
  };
  const cardSpec: ConnectionSendReplySpec = {
    integrationId: "connection-1",
    card: replyCard,
  };
  const actionsSpec: ConnectionSendReplySpec = {
    integrationId: "connection-1",
    threadJson: { adapterName: "telegram", chatId: "1" },
    actions: replyActions,
  };
  const cardResult: ConnectionSendReplyResult = await api.connections.sendReply(cardSpec);
  const actionsResult: ConnectionSendReplyResult = await api.connections.sendReply(actionsSpec);
  void cardResult;
  void actionsResult;
}

export const __fixtureMarker = true;
