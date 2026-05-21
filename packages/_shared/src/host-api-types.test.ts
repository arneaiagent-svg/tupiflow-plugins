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

import type {
  ChatMessageEvent,
  ConnectionInstance,
  EmbedArgs,
  EmbedResult,
  PluginHostAPI,
  RouteContext,
  StepResult,
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
  api.registerRoute("POST", "/hook", async (ctx: RouteContext) => {
    const auth: string | undefined = ctx.req.header("authorization");
    const id: string = ctx.req.param("id");
    const limit: string | undefined = ctx.req.query("limit");
    const body: unknown = await ctx.req.json();
    const raw: Request = ctx.req.raw;
    void auth;
    void id;
    void limit;
    void body;
    void raw;
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
}

export const __fixtureMarker = true;
