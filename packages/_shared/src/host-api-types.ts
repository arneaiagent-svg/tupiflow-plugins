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

export type RouteContext = {
  /** Build a JSON response body. Mirrors Hono `c.json(body, status?)`. */
  json: (body: unknown, status?: number) => unknown;
  /** Request-side accessors. Mirrors Hono `c.req.*`. */
  req: RouteRequest;
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
};
