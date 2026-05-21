// Canonical PluginHostAPI type for tupiflow registry plugins.
//
// The consumer-side (tupiflow runtime) provides the concrete implementation
// at runtime via dynamic import. This file is the contract every plugin
// bundle codes against. Keep in sync with
// tupiflow/backend/src/lib/plugin-runtime/host-api.ts.
//
// Phase 4a.2 (api.registerConnection + api.dispatchToWorkflow) is declared
// below. The host-side implementation lands in tupiflow per
// tupiflow/docs/registry/PHASE_4A2_LIFECYCLE.md.
//
// Phase 4e.2 adds the seven seeded host-API surfaces required by the Tier 1
// ports (ai-providers, mcp, workflow-builder). Spec:
// tupiflow/docs/registry/PHASE_4E_SEEDED_HOST_API.md.

export type StepResult =
  | { success: true; data: unknown }
  | { success: false; error: { message: string } };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Request-side contract handed to a plugin route handler. Mirrors the shape
 * of Hono's `c.req` since the host mounts plugin sub-routers into a Hono
 * app. Keep this minimal — only fields plugins are guaranteed to be able
 * to use are listed; everything else is reachable via `req.raw`.
 */
export type RouteRequest = {
  header(name: string): string | undefined;
  json<T = unknown>(): Promise<T>;
  query(name: string): string | undefined;
  param(name: string): string;
  raw: Request;
};

/**
 * Per-request context handed to a plugin route handler.
 *
 * `userId` + `abilities` are populated when the plugin's manifest declares
 * the `route.context.user` capability (Phase 4e.2 §2.3). Without that
 * capability the host populates both with empty values (the host-side
 * auth middleware still runs internally; the capability only gates
 * exposure on the shim, preserving least privilege). The handler MUST
 * check `userId === ""` before relying on the identity.
 *
 * Ability strings follow tupiflow's `<action>:<Resource>` convention
 * (e.g. "update:Integration"). The host enforces the format at populate
 * time with a runtime assertion.
 */
export type RouteContext = {
  /** Build a JSON response body. Mirrors Hono `c.json(body, status?)`. */
  json: (body: unknown, status?: number) => unknown;
  /** Request-side accessors. Mirrors Hono `c.req.*`. */
  req: RouteRequest;
  /**
   * Authenticated user id, when the host's auth middleware has populated it.
   * Empty string for unauthenticated public webhook routes and for plugins
   * that do NOT declare the `route.context.user` capability.
   */
  userId: string;
  /**
   * Abilities granted to the authenticated user. Shape mirrors the host's
   * existing `requireAbility(action, resource)` posture. Empty array when
   * `userId` is empty or the plugin lacks `route.context.user`.
   */
  abilities: string[];
};

export type RouteHandler = (ctx: RouteContext) => unknown;

export type StepHandler = (input: unknown) => Promise<StepResult>;

export type ToolHandler = (input: unknown) => Promise<unknown>;

export type IntegrationSpec = {
  type: string;
  label: string;
  actions: Array<{
    slug: string;
    label: string;
    description?: string;
    category?: string;
    stepFunction: string;
  }>;
  formFields: unknown[];
};

/**
 * LLM call arguments. Mirrors the canonical host shape; pass either
 * `prompt` or `messages` (host enforces semantics).
 */
export type LlmCallArgs = {
  model?: string;
  prompt?: string;
  messages?: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  maxTokens?: number;
  temperature?: number;
};

export type LlmCallResult = {
  text: string;
};

/**
 * Embedding call arguments. `model` overrides the host default for the
 * call; `providerIntegrationId` is required when `model` is set and the
 * host cannot infer the provider from the customer's default config.
 */
export type EmbedArgs = {
  model?: string;
  providerIntegrationId?: string;
};

/**
 * Embedding call result.
 *
 * `dimensions` is informational in v0 — always `EMBEDDING_DIM` (1024).
 * The field is reserved for v1 per-plugin column allocation (see design
 * doc PHASE_4B_HOST_GAPS.md §1.4).
 */
export type EmbedResult = {
  vector: number[];
  dimensions: number;
  model: string;
};

/**
 * Database accessor. Both `read` and `write` execute inside a transaction
 * the host scopes to `plugin_<name>` via `SET LOCAL search_path`. The plugin
 * never sees tables outside its own schema; SET LOCAL is per-tx and never
 * leaks across pool borrows (verified by host e2e against real Postgres).
 *
 * Use `$1, $2, ...` placeholders in `rawSql` and pass the matching values
 * positionally in `params`. The host forwards the array straight to the
 * underlying Postgres driver (`postgres-js` `.unsafe(rawSql, params)`); there
 * is NO host-side escape or sanitization layer.
 *
 * What `$N` binding DOES handle:
 * - Strings, numbers, booleans, `null`, `Date`, `Buffer` — passed through
 *   to postgres-js's native encoder.
 * - JS arrays mapped to PostgreSQL array literals when the column is an
 *   array type.
 * - SQL-injection-safe escaping of every bound VALUE.
 *
 * What `$N` binding DOES NOT handle — plugin author responsibility:
 * - `jsonb` / `json` columns. `postgres-js`'s `unsafe()` path does NOT
 *   auto-serialize JS objects (that auto-serializer lives on the tagged-
 *   template `sql\`\`` API which this surface bypasses to preserve the
 *   caller's `$N` numbering). Pre-`JSON.stringify` the object and cast in
 *   SQL: `INSERT … VALUES ($1, $2::jsonb)`. Reads return jsonb as
 *   already-parsed JS objects (the postgres-js receive path DOES parse).
 * - `ILIKE` pattern semantics. Binding escapes `'` in a value; it does
 *   not escape the LIKE/ILIKE meta-chars `%`, `_`, `\`. If the value is a
 *   user-supplied search term used in `WHERE col ILIKE $1`, escape the
 *   meta-chars on the plugin side first.
 * - Application-level type validation. Validate every value's shape
 *   (length cap, JSON schema, etc.) at the boundary before binding —
 *   `$N` only handles SQL safety, not whether the value belongs there.
 */
export type PluginDb = {
  read<T = unknown>(rawSql: string, params?: unknown[]): Promise<T[]>;
  write(rawSql: string, params?: unknown[]): Promise<void>;
};

export type PluginLogger = {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
};

/**
 * Inbound chat-message attachment carried by `ChatMessageEvent`. The host
 * forwards the populated arrays straight into the auto-generated default
 * workflow's AI Agent node for multimodal binding. Plugins SHOULD populate
 * the dedicated `imageUrls / fileUrls / audioUrls / videoUrls` array that
 * matches the attachment kind so the default workflow's template
 * references resolve correctly (see PHASE_4A2_LIFECYCLE.md §1).
 */
export type ChatAttachment = {
  url: string;
  filename?: string;
  mediaType?: string;
};

/**
 * Payload `api.dispatchToWorkflow` accepts. Shape mirrors the host-side
 * `ChatMessageEvent` (`tupiflow/backend/src/plugins/registry-types.ts`)
 * exactly and is the implicit contract every connection-trigger workflow
 * depends on (see PHASE_4A2_LIFECYCLE.md §3.1). Plugins MUST populate
 * `integrationId`, `text`, `threadJson`, `channelId`, `threadId`, and
 * `userName` — every downstream node in the auto-generated default
 * workflow relies on those fields.
 *
 * The multimodal URL fields (`imageUrls`, `fileUrls`, `audioUrls`,
 * `videoUrls`) are NOT decorative. The default workflow's AI Agent node
 * binds them via template references; omitting them silently degrades the
 * end-user multimodal experience on the agent's default flow.
 */
export type ChatMessageEvent = {
  integrationId: string;
  text: string;
  threadJson: unknown;
  isDM: boolean;
  isMention: boolean;
  channelId: string;
  threadId: string;
  chatId?: string;
  userName: string;
  arrivalAt?: number;
  imageUrls?: ChatAttachment[];
  fileUrls?: ChatAttachment[];
  audioUrls?: ChatAttachment[];
  videoUrls?: ChatAttachment[];
};

/**
 * Opaque per-integration handle returned by `ConnectionSpec.startInstance`.
 * The `handle` slot is plugin-private closure state the host never
 * inspects; the host only invokes `shutdown` at config-update, integration
 * delete, plugin uninstall, and graceful host-stop times.
 */
export type ConnectionInstance = {
  integrationId: string;
  handle?: unknown;
  shutdown: () => Promise<void>;
};

/**
 * Connection lifecycle declaration passed to `api.registerConnection`.
 *
 * - `startInstance` fires on integration-row INSERT, config-UPDATE
 *   (after the previous instance's `shutdown`), and on host boot for
 *   every active integration row of the plugin's type.
 * - `buildThreadJson` is optional; the host calls it when it needs to
 *   reconstruct the adapter-serialized Thread JSON for a raw chat id
 *   (e.g. for chat-takeover replies originating outside the workflow).
 * - `replyActionId` defaults to `${integrationType}/send-reply`. Bind
 *   only if the plugin exposes its reply step under a non-default id.
 */
export type ConnectionSpec = {
  startInstance: (args: {
    integrationId: string;
    config: Record<string, unknown>;
  }) => Promise<ConnectionInstance>;
  buildThreadJson?: (chatId: string) => Record<string, unknown> | null;
  replyActionId?: string;
};

// ---------------------------------------------------------------------------
// Phase 4e.2 — seeded host-API expansions (§2 of PHASE_4E_SEEDED_HOST_API.md)
// ---------------------------------------------------------------------------

/**
 * §2.1 — Argument shape for `api.testIntegration`. The plugin passes the
 * integration's type + row id; the host fetches credentials and dispatches
 * to the plugin-registered handler. `opts` carries plugin-specific extras
 * (e.g. `testModelId` for ai-providers).
 */
export type TestIntegrationSpec = {
  integrationType: string;
  integrationId: string;
  opts?: Record<string, unknown>;
};

/**
 * §2.1 — Result returned by both `api.testIntegration` (caller side) and
 * the plugin's registered `TestHandler` (callee side). `detail` is
 * optional structured context for the operator-facing test log.
 */
export type TestIntegrationResult = {
  success: boolean;
  error?: string;
  detail?: Record<string, unknown>;
};

/**
 * §2.1 — Plugin-registered test handler. Invoked by the host with already-
 * decrypted credentials; plaintext NEVER crosses the api boundary from
 * caller → host. Capability: `integration.test`.
 */
export type TestHandler = (args: {
  integrationId: string;
  credentials: Record<string, string | undefined>;
  opts?: Record<string, unknown>;
}) => Promise<TestIntegrationResult>;

/**
 * §2.2 — Patch shape accepted by `api.updateIntegrationConfig`. The host
 * deep-merges the patch into the integration row's `config.pluginData`
 * subtree ONLY: any top-level key outside `pluginData`, any nested JSON
 * depth > 4, or any object key starting with `$` (reserved) is rejected
 * with `ConfigPatchSchemaError`. Reuses the `secrets.read` capability
 * (no new cap; ownership scope mirrors `fetchCredentials`).
 */
export type IntegrationConfigPatch = Record<string, unknown>;

/**
 * §2.4 — Per-`(plugin, integrationId)` context the host hands to a
 * registered tool-catalog contributor. The builder is invoked once per
 * owned integration row.
 */
export type ToolCatalogContext = {
  userId: string;
  integrationId: string;
};

/**
 * §2.4 — Single entry returned by a tool-catalog contributor. `entryKey`
 * is unique within a single builder return — duplicates trigger
 * last-write-wins + a warn log. The host caches results per
 * `(pluginName, integrationId)` with auto-invalidation on
 * `api.updateIntegrationConfig` for the same row.
 */
export type ToolCatalogEntry = {
  entryKey: string;
  actionId: string;
  actionLabel: string;
  category: string;
  integrationId: string;
  integrationLabel: string;
  configured: boolean;
  unavailableReason?: string;
  tool: {
    name: string;
    description: string;
    /** JSON Schema 2020-12, pre-serialized. */
    inputSchemaJson: string;
  };
};

/**
 * §2.4 — Tool-catalog contributor signature. Capability:
 * `tool-registry.contribute`. Manifest MUST also set
 * `toolCatalogContributor: true` (registry allOf enforces).
 */
export type ToolCatalogContributor = (
  ctx: ToolCatalogContext
) => Promise<ToolCatalogEntry[]>;

/**
 * §2.5 — Display spec for a takeover target the plugin registers via
 * `api.registerTakeoverTarget`. The plugin declares the target id only;
 * the host owns routing via the agent row's
 * `approvalTargetIntegrationId / approvalTargetChatId` columns.
 * Capability: `takeover.register`. Manifest `takeoverTargets[]` MUST
 * list the corresponding `actionId` (registry allOf enforces).
 */
export type TakeoverTargetSpec = {
  label: string;
  description?: string;
};

/**
 * §2.6 — Workflow row shape returned by `api.workflow.get`. Trusted
 * first-party only in v0: the host publisher-gates the read-side methods
 * (`get`, `list`, `getExecutionLogs`) to
 * `manifest.identity.publisher === "tupiflow"` and throws
 * `WorkflowReadPublisherDeniedError` for third-party callers.
 */
export type Workflow = {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  isSystem: boolean;
  userId: string;
  /** Full React Flow shape. Trusted first-party only in v0 — see §2.6.4. */
  nodes: unknown[];
  edges: unknown[];
  createdAt: string;
  updatedAt: string;
};

/**
 * §2.6 — List-row projection returned by `api.workflow.list`.
 */
export type WorkflowListItem = Pick<
  Workflow,
  "id" | "name" | "visibility" | "isSystem" | "createdAt" | "updatedAt"
>;

/**
 * §2.6 — Options accepted by `api.workflow.list`. `userId` defaults to the
 * caller's resolved user id; an override requires the `admin:Workflow`
 * ability. `limit` is clamped to 200 (host does not throw on overflow).
 * `cursor` is opaque (base64(JSON({updatedAt, id}))) — plugins treat it
 * as a string.
 */
export type WorkflowListOpts = {
  userId?: string;
  limit?: number;
  cursor?: string;
};

/**
 * §2.6 — Page returned by `api.workflow.list`.
 */
export type WorkflowListPage = {
  items: WorkflowListItem[];
  nextCursor: string | null;
};

/**
 * §2.6 — Argument shape for `api.workflow.createExecution`.
 */
export type CreateExecutionSpec = {
  workflowId: string;
  input?: Record<string, unknown>;
};

/**
 * §2.6 — Result returned by `api.workflow.createExecution`.
 */
export type CreateExecutionResult = {
  executionId: string;
  status: "running";
};

/**
 * §2.6 — Single node log entry returned by `api.workflow.getExecutionLogs`.
 */
export type ExecutionLogEntry = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  duration: string | null;
};

/**
 * §2.7 — Per-step execution context handed to registry-installable step
 * handlers via the `RegistryStepInput` envelope. Disjoint by design from
 * the host-internal `BundledStepContext`: registry plugins reach the host
 * surface via `api.*`, not via direct DB / logger handles.
 *
 * `workflowId` + `executionId` are empty for direct tool-test invocations.
 * `userId` is resolved before the step runs and is never empty in v0
 * (host throws `StepContextUnresolvableError` otherwise).
 */
export type RegistryStepContext = {
  workflowId: string;
  executionId: string;
  userId: string;
  nodeId: string;
  /** Adapter-serialized thread JSON when triggered from a chat connection. */
  threadJson?: unknown;
  /** Trigger payload merged with prior nodes' outputs. */
  input: Record<string, unknown>;
};

/**
 * §2.7 — Envelope passed to a `RegistryStepHandler`. The first positional
 * argument bundles `{api, ctx}`; per-step typed input is the second
 * positional argument supplied by the step's typed wrapper at the call
 * site.
 *
 * Dispatch contract: the host routes registry-installable steps via the
 * separate `registerRegistryStep(id, fn)` method on `PluginHostAPI` (not
 * arity detection on the legacy `registerStep`). Arrow functions with
 * destructured single params report `fn.length === 1` in both shapes,
 * so arity-based dispatch is unreliable. See §2.7.1.
 */
export type RegistryStepInput = {
  api: PluginHostAPI;
  ctx: RegistryStepContext;
};

/**
 * §2.7 — Handler signature for registry-installable steps. The shim's
 * `StepResult` is non-generic (`data: unknown`); per-step typed wrappers
 * narrow at the call site by combining `RegistryStepInput` with the
 * step's own typed input field set.
 */
export type RegistryStepHandler = (
  input: RegistryStepInput
) => Promise<StepResult>;

export type PluginHostAPI = {
  db: PluginDb;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  fetchCredentials(
    integrationId: string
  ): Promise<Record<string, string | undefined>>;
  llm: {
    call(args: LlmCallArgs): Promise<LlmCallResult>;
    /**
     * Compute an embedding for a single string. Gated on the existing
     * `llm.call` capability — no new capability is introduced (see
     * PHASE_4B_HOST_GAPS.md §1.2). `EmbedResult.dimensions` is
     * informational in v0 and always equals `EMBEDDING_DIM` (1024);
     * the field is reserved for v1 per-plugin column allocation
     * (PHASE_4B_HOST_GAPS.md §1.4).
     */
    embed(text: string, opts?: EmbedArgs): Promise<EmbedResult>;
    /**
     * Compute embeddings for a batch of strings. Gated on the existing
     * `llm.call` capability — no new capability is introduced (see
     * PHASE_4B_HOST_GAPS.md §1.2). The host forwards to its native
     * batched embedding path; prefer this over looping `embed()` when
     * embedding more than one value. `EmbedResult.dimensions` is
     * informational in v0 and always equals `EMBEDDING_DIM` (1024);
     * the field is reserved for v1 per-plugin column allocation
     * (PHASE_4B_HOST_GAPS.md §1.4).
     */
    embedBatch(values: string[], opts?: EmbedArgs): Promise<EmbedResult[]>;
  };
  logger: PluginLogger;
  /**
   * Absolute public URL of the customer's tupiflow host (no trailing slash),
   * e.g. `https://app.acme.com`. Sourced from the env var
   * `TUPIFLOW_PUBLIC_BASE_URL` (falls back to `BETTER_AUTH_URL`). Plugins use
   * this to build absolute callback URLs handed to upstream services — most
   * commonly the webhook URL passed to a provider's `setWebhook`-style API
   * from `startInstance`.
   *
   * Empty string if neither env var is set. Plugins that depend on this MUST
   * check for empty and fail loudly in `startInstance` so misconfiguration is
   * visible at integration save time rather than at first inbound event.
   */
  publicBaseUrl: string;
  registerIntegration(spec: IntegrationSpec): void;
  registerRoute(method: HttpMethod, path: string, handler: RouteHandler): void;
  /**
   * Register a step handler.
   *
   * When `id` matches the connection's `replyActionId` pattern (default
   * `${integrationType}/send-reply`), the step's input handler MUST accept
   * `{ text, integrationId, threadJson }` because the auto-generated
   * default workflow binds those exact field names on the send-reply node
   * (see PHASE_4A2_LIFECYCLE.md §3.1). Wrong argument names will pass type
   * checks, the workflow will run green, and the reply will silently no-op.
   */
  registerStep(id: string, fn: StepHandler): void;
  /**
   * Register a step handler that needs the registry-installable `{api, ctx}`
   * envelope (Phase 4e.2 §2.7). The host routes dispatch via the registry
   * the id lands in — explicit second method, NOT arity detection on
   * `registerStep` (arrow-destructure ambiguity makes `fn.length`
   * unreliable). No new capability — type-only contract.
   */
  registerRegistryStep(id: string, fn: RegistryStepHandler): void;
  // `schema` is typed `unknown` here because the shim is dependency-free.
  // The host accepts a `ZodTypeAny`; plugins importing zod themselves get
  // structural compatibility at the call site.
  registerTool(id: string, schema: unknown, fn: ToolHandler): void;
  /**
   * Declare a connection-lifecycle handler set for the plugin's integration
   * type. The host invokes `spec.startInstance` on integration INSERT,
   * config UPDATE, and boot reconciliation; `instance.shutdown` runs on
   * config UPDATE (before re-start), DELETE, and plugin uninstall. Capability
   * `connection.lifecycle` is required (see PHASE_4A2_LIFECYCLE.md §2).
   */
  registerConnection(spec: ConnectionSpec): void;
  /**
   * Dispatch an inbound chat message into the workflow trigger system.
   * Returns `{executionId}` on success, `null` for duplicate / no-target
   * cases (the host de-duplicates by `integrationId + arrivalAt`).
   *
   * NEVER call this from inside an `api.db.write` transaction. The host
   * implementation opens its own `workflowExecutions` insert outside any
   * caller transaction (see `tupiflow/backend/src/lib/connection-dispatcher.ts`),
   * which deadlocks against a plugin-scoped tx still holding rows.
   * Capability `workflow.dispatch` is required (see PHASE_4A2_LIFECYCLE.md §5).
   */
  dispatchToWorkflow(
    event: ChatMessageEvent
  ): Promise<{ executionId: string } | null>;
  /**
   * §2.1 — Register the plugin's "test connection" handler. Capability:
   * `integration.test`. Exactly one plugin per `integrationType` may
   * register; the second registration throws `TestHandlerCollisionError`
   * at the host. The host invokes the handler with decrypted credentials
   * fetched via the same path `api.fetchCredentials` uses.
   */
  registerTestHandler(fn: TestHandler): void;
  /**
   * §2.1 — Dispatch a connection test against the integration row's
   * registered `TestHandler`. Ungated (every plugin can trigger a test);
   * the host rejects unknown `integrationType` values with
   * `TestHandlerNotFoundError`. Credential access is the privileged
   * surface, not test dispatch — gating both would force callers (e.g.
   * a workflow-builder smoke-test action) to declare capabilities they
   * never use meaningfully.
   */
  testIntegration(spec: TestIntegrationSpec): Promise<TestIntegrationResult>;
  /**
   * §2.2 — Deep-merge `patch` into the integration row's
   * `config.pluginData` subtree. Reuses the `secrets.read` capability
   * (ownership scope symmetric with `fetchCredentials`); cross-tenant or
   * cross-type writes throw `IntegrationOwnershipError` /
   * `IntegrationTypeMismatchError`. Any top-level patch key outside
   * `pluginData`, any nested depth > 4, or any object key starting with
   * `$` is rejected with `ConfigPatchSchemaError`. Host auto-invalidates
   * the integration cache + the §2.4 tool-catalog-contributor cache for
   * the same row after a successful write — there is no public
   * `api.invalidateCache(key)` surface.
   */
  updateIntegrationConfig(
    integrationId: string,
    patch: IntegrationConfigPatch
  ): Promise<void>;
  /**
   * §2.4 — Register a builder that returns dynamic agent-tool entries
   * per `(plugin, integrationId)` pair. Capability:
   * `tool-registry.contribute`. Manifest MUST also set
   * `toolCatalogContributor: true`. The host iterates the plugin's owned
   * integrations and calls the builder once per row; results are cached
   * per `(pluginName, integrationId)` and invalidated on
   * `api.updateIntegrationConfig` for the same row, integration DELETE,
   * plugin uninstall/reload, or a 5-minute TTL.
   */
  registerToolCatalogContributor(fn: ToolCatalogContributor): void;
  /**
   * §2.5 — Register a takeover target the agent runtime may route control
   * flow to. Capability: `takeover.register`. The `actionId` MUST match
   * an entry in the manifest's `takeoverTargets[]` array (registry allOf
   * enforces non-empty when the capability is declared) AND a previously
   * registered step id — the host throws `TakeoverTargetUnknownStepError`
   * on a mismatch. Routing is host-owned via the agent row's
   * `approvalTargetIntegrationId / approvalTargetChatId` columns; the
   * plugin does NOT supply a `routeToChat(ctx)` handler.
   */
  registerTakeoverTarget(actionId: string, spec: TakeoverTargetSpec): void;
  /**
   * §2.6 — Workflow CRUD namespace. `get`, `list`, and `getExecutionLogs`
   * require capability `workflow.read` AND `manifest.identity.publisher
   * === "tupiflow"` (third-party publishers throw
   * `WorkflowReadPublisherDeniedError`). `createExecution` requires
   * capability `workflow.write` (which runtime-implies `workflow.read`
   * via the host's `IMPLIED_BY` map) and is NOT publisher-gated.
   * All methods scope to the caller's resolved `userId`; cross-tenant
   * reads return `null`/`[]` (host posture matches first-party "not
   * found or not owned"). `list({userId: otherId})` requires the
   * `admin:Workflow` ability.
   */
  workflow: {
    get(workflowId: string): Promise<Workflow | null>;
    list(opts?: WorkflowListOpts): Promise<WorkflowListPage>;
    createExecution(spec: CreateExecutionSpec): Promise<CreateExecutionResult>;
    getExecutionLogs(executionId: string): Promise<ExecutionLogEntry[]>;
  };
};
