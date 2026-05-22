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

export type IntegrationRegistrationSpec = {
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

// ---------------------------------------------------------------------------
// Phase 4e.5 batch 2 — catalog.read + extended host surfaces
// ---------------------------------------------------------------------------

/**
 * Catalog-describe response shape returned by `api.integrations.describe`.
 * Capability: `catalog.read`. Describes a registered integration type from
 * the host's integration catalog — distinct from `IntegrationRegistrationSpec`
 * which is passed to `api.registerIntegration` by the plugin at init time.
 */
export interface IntegrationSpec {
  type: string;
  label: string;
  description?: string;
  capabilities?: readonly string[];
  credentialFields?: ReadonlyArray<{
    key: string;
    label: string;
    type: "string" | "secret" | "boolean" | "number";
    required: boolean;
  }>;
}

/**
 * Node in a typed workflow graph. Returned on `Workflow.nodes` when the host
 * populates the richer shape (Phase 4e.5 batch 2). `config` carries
 * node-specific settings; shape is node-type-dependent and opaque to plugins.
 */
export interface WorkflowNode {
  id: string;
  type: string;
  label?: string;
  config?: Record<string, unknown>;
}

/**
 * Directed edge in a typed workflow graph. Returned on `Workflow.edges` when
 * the host populates the richer shape (Phase 4e.5 batch 2).
 */
export interface WorkflowEdge {
  source: string;
  target: string;
  condition?: string;
}

/**
 * Execution row returned by `api.workflow.listExecutions`. Status values mirror
 * the host's `workflow_executions.status` enum. `startedAt` / `completedAt`
 * are ISO-8601 strings. Capability: `workflow.read`.
 */
export interface WorkflowExecution {
  id: string;
  workflowId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  /** ISO-8601 timestamp. */
  startedAt: string;
  /** ISO-8601 timestamp; absent while still running. */
  completedAt?: string;
  error?: string;
}

/**
 * Action row returned by `api.actions.list`. Represents a registered step /
 * action in the host's action catalog. `inputSchema` is a JSON Schema object;
 * plugins treat it as opaque.
 */
export interface Action {
  id: string;
  slug: string;
  label: string;
  description?: string;
  type: string;
  /** JSON Schema; opaque to plugins. */
  inputSchema?: unknown;
}

/**
 * Tool row returned by `api.tools.list`. `owner` identifies whether the tool
 * was registered by the host runtime or by a named plugin.
 */
export interface Tool {
  id: string;
  name: string;
  description?: string;
  /** JSON Schema; opaque to plugins. */
  inputSchema?: unknown;
  owner: { kind: "host" } | { kind: "plugin"; pluginName: string };
}

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
 *
 * Phase 4e.5 — optional `opts.schema` switches the per-tx search_path.
 * Default `"plugin"` (per-plugin sandbox, identical to pre-4e.5 behaviour).
 * `"public"` lets first-party plugins (`manifest.identity.publisher ===
 * "tupiflow"`) reach core tables (`workflows`, `agents`, `integrations`,
 * `workflow_executions`, etc.). Third-party publishers calling with
 * `schema: "public"` are rejected with `DbPublicSchemaPublisherDeniedError`
 * BEFORE any SET LOCAL emits (no information leak via timing or partial-
 * emit). No new capability — the publisher gate is the security boundary.
 */
export type DbCallOpts = {
  schema?: "plugin" | "public";
};

export type PluginDb = {
  read<T = unknown>(
    rawSql: string,
    params?: unknown[],
    opts?: DbCallOpts,
  ): Promise<T[]>;
  write(
    rawSql: string,
    params?: unknown[],
    opts?: DbCallOpts,
  ): Promise<void>;
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
  /**
   * Typed node list (Phase 4e.5 batch 2). Populated by the host in batch 2;
   * older plugins that only reference `Workflow` without iterating nodes are
   * unaffected. Falls back to `unknown[]` on pre-batch-2 host builds.
   */
  nodes?: WorkflowNode[];
  /**
   * Typed edge list (Phase 4e.5 batch 2). Same population semantics as
   * `nodes` above.
   */
  edges?: WorkflowEdge[];
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

// ---------------------------------------------------------------------------
// Phase 4f batch 1 — plugin-defined workers + `api.runTask`
// ---------------------------------------------------------------------------

/**
 * §4f batch 1 — Manifest-declared worker entry. Each declared worker becomes a
 * separate ESM bundle under `workers/<id>.mjs` (built by `buildPlugin`) and is
 * spawned by the host's worker pool via `api.runTask(id, input)`. Workers run
 * in `worker_threads` isolation — they have NO `PluginHostAPI` access (no db,
 * no fetch, no llm) and receive structured-clone input + return structured-
 * clone output. Pure compute.
 *
 * Field semantics:
 * - `id`: matches `/^[a-z0-9][a-z0-9-]*$/` (registry schema regex).
 * - `entry`: source path relative to plugin root; MUST match
 *   `^workers/[a-zA-Z0-9_-]+\.mjs$` after build.
 * - `memLimitMb`: enforced via `Worker({ resourceLimits:
 *   { maxOldGenerationSizeMb } })`. Range 32–1024 (registry schema).
 * - `timeoutMs`: enforced via `Promise.race` against `min(opts.timeoutMs,
 *   manifest.timeoutMs, hostMaxTimeoutMs)`. Range 100–300000.
 */
export interface WorkerSpec {
  id: string;
  entry: string;
  memLimitMb?: number;
  timeoutMs?: number;
}

/**
 * §4f batch 1 — Thrown when `api.runTask(workerId, ...)` is called with a
 * workerId that does not match any entry in the plugin's manifest
 * `workers[]`. The host throws this BEFORE attempting to spawn a worker.
 */
export class WorkerNotFoundError extends Error {
  constructor(workerId: string) {
    super(`Worker not found: ${workerId}`);
    this.name = "WorkerNotFoundError";
  }
}

/**
 * §4f batch 1 — Thrown when a worker exceeds its resolved timeout
 * (`min(opts.timeoutMs, manifest.workers[].timeoutMs, hostMaxTimeoutMs)`).
 * The host calls `worker.terminate()` before throwing.
 */
export class WorkerTimeoutError extends Error {
  constructor(workerId: string, timeoutMs: number) {
    super(`Worker ${workerId} exceeded ${timeoutMs}ms`);
    this.name = "WorkerTimeoutError";
  }
}

/**
 * §4f batch 1 — Thrown when `api.runTask(...)` is invoked without the
 * `worker.run` capability declared in the plugin's manifest. Capability gate
 * runs before workerId lookup.
 */
export class WorkerCapabilityDeniedError extends Error {
  constructor() {
    super("worker.run capability not granted");
    this.name = "WorkerCapabilityDeniedError";
  }
}

/**
 * §4f batch 2 — Thrown by the host installer when a plugin's manifest
 * `requiredNpmDeps` declares a module the host either does not have installed
 * at all (`installedVersion` undefined) or has installed at a version outside
 * the declared semver `declaredRange`. Install fails BEFORE any schema is
 * created; the plugin row is never written. Mirrored shim-side so plugin
 * tooling can catch programmatically.
 */
export class MissingNpmDepError extends Error {
  constructor(
    public readonly depName: string,
    public readonly declaredRange: string,
    public readonly installedVersion?: string,
  ) {
    super(
      `Host missing npm dep: ${depName} (required: ${declaredRange}${
        installedVersion ? `, installed: ${installedVersion}` : ", not installed"
      })`,
    );
    this.name = "MissingNpmDepError";
  }
}

/**
 * §4f batch 2 — Thrown by the shim build helper (and by the registry Go
 * validator at publish) when a plugin declares a `requiredNpmDeps` entry
 * whose key is not on the closed allowlist (`ALLOWED_NPM_DEPS` shim-side,
 * mirrored registry-side). Adding a new allowlist entry requires a PR to
 * both surfaces.
 */
export class NpmDepNotAllowedError extends Error {
  constructor(public readonly depName: string) {
    super(`npm dep ${depName} is not on the registry allowlist`);
    this.name = "NpmDepNotAllowedError";
  }
}

// ---------------------------------------------------------------------------
// Phase 4e.5 batch 1 — agents.* / integrations.list / connections.types /
//                       workflow.create
// ---------------------------------------------------------------------------

/**
 * §4e.5 — Spec accepted by `api.workflow.create`. Publisher-gated to
 * `manifest.identity.publisher === "tupiflow"` (third-party callers throw
 * `CorePublishPublisherDeniedError`). `nodes` / `edges` MUST be arrays; the
 * host does NOT deep-validate the React Flow graph (workflow-runner enforces
 * structure at execution). Reuses `workflow.write` capability.
 */
export type WorkflowCreateSpec = {
  name: string;
  description?: string;
  nodes: unknown[];
  edges: unknown[];
  visibility?: "private" | "public";
  isSystem?: boolean;
};

/**
 * §4e.5 — Per-agent spec for `api.agents.create`. Mirrors the columns the
 * first-party `create-agent` step writes. Only scalar fields are accepted;
 * tools / mcpTools / kbCollectionIds JSONB substructure goes through
 * dedicated host paths in a later phase. `slug` MUST match
 * `/^[a-z0-9][a-z0-9-]*$/`. Publisher-gated.
 */
export type AgentCreateSpec = {
  slug: string;
  name: string;
  description?: string;
  provider?: string;
  model?: string;
  body?: string;
  historyLimit?: number | null;
  maxToolSteps?: number | null;
  showToolTrace?: boolean;
  showReasoning?: boolean;
  approvalTargetIntegrationId?: string | null;
  approvalTargetChatId?: string | null;
};

/** §4e.5 — Patch accepted by `api.agents.update`. Same scalar-only contract. */
export type AgentUpdatePatch = Partial<Omit<AgentCreateSpec, "slug">>;

/**
 * §4e.5 — Slim row projection returned by `api.agents.list / create / update`.
 * Mirrors the first-party `list-agents` step's degraded shape.
 */
export type AgentListItem = {
  slug: string;
  name: string;
  description: string | null;
  provider: string | null;
  model: string | null;
  body: string;
  historyLimit: number | null;
  maxToolSteps: number | null;
  showToolTrace: boolean;
  showReasoning: boolean;
  approvalTargetIntegrationId: string | null;
  approvalTargetChatId: string | null;
  updatedAt: string;
};

export type AgentListFilter = {
  /** Filter by slug prefix; comparison is exact `startsWith`. */
  slugPrefix?: string;
};

/**
 * §4e.5 — Row projection returned by `api.integrations.list`. Always
 * scoped to the caller's resolved userId (`PluginCallContext.userId`); the
 * config / credentials never cross this boundary.
 */
export type IntegrationListItem = {
  id: string;
  userId: string;
  name: string;
  type: string;
  isManaged: boolean;
  createdAt: string;
  updatedAt: string;
};

export type IntegrationListFilter = {
  type?: string;
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

// ---------------------------------------------------------------------------
// Phase 4e.5 batch 3 — notifications.send
// ---------------------------------------------------------------------------

/**
 * §4e.5 batch 3 — manual error-notification dispatch from a plugin step
 * (e.g. workflow-builder's `send-error-notification` action). The host
 * routes the spec into its configured channels (webhook / ntfy / connection
 * via site settings); rate-limit + cooldown that apply to automatic
 * error notifications are intentionally BYPASSED here because the call is
 * user-triggered. Capability: `notifications.send`.
 *
 * `at` is filled in by the host (always wall-clock now). Plugin should not
 * pass it.
 */
export interface ErrorNotificationFailedNode {
  nodeId: string;
  nodeType?: string;
  error: string;
  logs?: string[];
}

export interface ErrorNotificationSpec {
  /** Human-readable error summary. Required, non-empty after trim. */
  message: string;
  workflowId?: string;
  workflowName?: string;
  executionId?: string;
  failedNodes?: ErrorNotificationFailedNode[];
}

export interface ErrorNotificationResult {
  /** True when at least one channel accepted the dispatch. */
  dispatched: boolean;
  /** Populated when `dispatched === false` (no channels configured / dispatch failure). */
  reason?: string;
}

export type SandboxErrorKind =
  | 'timeout'
  | 'oom'
  | 'syntax'
  | 'runtime'
  | 'non_serializable';

export interface SandboxOpts {
  /** Hard cap in ms. Default 1000; max 10000. Lower clamp 1ms. */
  timeoutMs?: number;
  /** Hard cap in MiB. Default 64; max 128. */
  memoryLimitMb?: number;
}

export type SandboxSuccess = {
  success: true;
  value: unknown;
  logs: string[];
};

export type SandboxFailure = {
  success: false;
  error: { kind: SandboxErrorKind; message: string };
  logs: string[];
};

export type SandboxResult = SandboxSuccess | SandboxFailure;

export interface ConnectionSendReplySpec {
  /** Target integration row id (must be a connection-type integration). */
  integrationId: string;
  /**
   * Thread context. If omitted, the host resolves the row default
   * threadJson from connection_thread_history (latest by updatedAt).
   * Plugins that already loaded a row should pass it through to avoid
   * the extra DB read. Typed `unknown` to match the adapter-JSON shape
   * exposed elsewhere (`ChatMessageEvent.threadJson`, `RegistryStepContext.threadJson`);
   * host accepts string or object and serializes as needed.
   */
  threadJson?: unknown;
  /** Message text. Required, non-empty after trim. */
  text: string;
}

export interface ConnectionSendReplyResult {
  /** True when the adapter returned a successful upstream response. */
  delivered: boolean;
  /** Adapter-assigned message id (e.g. Telegram message_id). */
  messageId?: string;
  /** Always returned; matches the resolved thread the post landed in. */
  threadId: string;
}

export interface LaunchAgentOpts {
  /** Optional per-call provider override (e.g. openai). */
  providerOverride?: string;
  /** Optional per-call model override (e.g. gpt-5-mini). */
  modelOverride?: string;
  /** If launching inside an active thread, pass through. */
  connectionIntegrationId?: string;
  /**
   * Adapter-JSON thread context. Typed `unknown` to match
   * `ChatMessageEvent.threadJson` / `RegistryStepContext.threadJson`;
   * host accepts string or object and serializes as needed.
   */
  connectionThreadJson?: unknown;
  /** Hard cap on tool-call iterations. Default/max enforced by host. */
  maxToolSteps?: number;
}

export interface LaunchAgentResult {
  /** Final assistant text after the tool loop terminates. */
  text: string;
  /** Total tool-call iterations consumed. */
  toolStepsUsed: number;
}

export type PluginHostAPI = {
  db: PluginDb;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /**
   * Fetch the credential bag for an integration row. The shape is
   * `Record<string, string | undefined>` — populated keys vary per
   * integration type:
   * - `agents_*` providers (built-in AI provider integrations) return
   *   `apiKey` (when the provider requires one) plus any non-secret
   *   `extraFormFields` declared by the provider spec — notably
   *   `baseURL` for self-hosted runtimes like `agents_ollama` (where
   *   `noApiKey: true` and the bag contains ONLY `baseURL`). Callers
   *   targeting Ollama-style integrations MUST read `creds.baseURL`
   *   alongside (or instead of) `creds.apiKey`.
   * - Runtime-registry plugin integrations return the configKey set
   *   declared in the plugin manifest's `formFields[]`.
   *
   * Ownership-scoped: the call rejects (`CapabilityDeniedError` →
   * surfaced as a thrown error to the plugin) when the row's
   * `integration.type` does not match the calling plugin's owned
   * `integrationType` (manifest `identity.type`). Built-in `agents_*` rows
   * pass the same gate when the calling plugin's manifest owns the
   * corresponding `agents_*` type (e.g. an AI-provider plugin) OR when
   * the plugin's manifest declares it consumes `agents_*` types (workflow
   * builder pattern). Confirm exact ownership rule with the host
   * implementation — the shim documents intent; the host enforces.
   * Capability: `secrets.read`.
   */
  fetchCredentials(
    integrationId: string
  ): Promise<Record<string, string | undefined>>;
  /**
   * §4e.5 batch 3 — dispatch an error notification through the host's
   * configured channels (webhook / ntfy / connection). User-triggered:
   * the host does NOT apply the cooldown / global rate limit it applies to
   * automatic error notifications. Returns `{ dispatched: false, reason }` if
   * no channel is configured. Capability: `notifications.send`.
   */
  sendErrorNotification(spec: ErrorNotificationSpec): Promise<ErrorNotificationResult>;
  /**
   * Phase 4e.5 batch 5 — run user-supplied JavaScript code in a WASM
   * QuickJS sandbox with isolated heap. Stripped globals: fetch,
   * setTimeout, setInterval, clearTimeout, clearInterval, require,
   * process, globalThis. Available: JSON, Math, Date, console.log.
   * User code is wrapped as (function(data){ <code> })(globalThis.data);
   * the return value must be JSON-serializable. Capability: code.sandbox.
   */
  runSandbox(
    code: string,
    ctx: { data: unknown },
    opts?: SandboxOpts
  ): Promise<SandboxResult>;
  /**
   * Phase 4e.5 batch 4a — launch a host-defined agent by slug with a
   * single user prompt. Synchronous: resolves when the agent tool loop
   * returns final text. No slug-prefix gate; capability is the consent
   * boundary. Capability: agent.launch.
   */
  launchAgent(
    slug: string,
    prompt: string,
    opts?: LaunchAgentOpts
  ): Promise<LaunchAgentResult>;
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
  registerIntegration(spec: IntegrationRegistrationSpec): void;
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
   * §4e.5 — Agent CRUD namespace. `list` is read-only and tenant-scoped via
   * the ambient `PluginCallContext` userId (reuses `db.read` capability).
   * `create` / `update` / `delete` are publisher-gated to
   * `manifest.identity.publisher === "tupiflow"`; third-party plugins
   * receive `CorePublishPublisherDeniedError`. Mutations reuse `db.write`
   * — the publisher gate is the security boundary, not a new capability
   * string. After every mutation the host invalidates the process-local
   * agent cache. Slug must match `/^[a-z0-9][a-z0-9-]*$/`; `$`-prefix +
   * prototype-pollution keys are rejected (`AgentSpecInvalidError`).
   * `AgentNotFoundError` for update/delete on a missing row.
   */
  agents: {
    list(filter?: AgentListFilter): Promise<AgentListItem[]>;
    create(spec: AgentCreateSpec): Promise<AgentListItem>;
    update(slug: string, patch: AgentUpdatePatch): Promise<AgentListItem>;
    delete(slug: string): Promise<void>;
  };
  /**
   * §4e.5 — Integration list + catalog-describe namespace. `list` is
   * tenant-scoped via the ambient `PluginCallContext` userId; cross-tenant
   * rows are never returned. Reuses `db.read` capability. Optional `type`
   * filter narrows by integration type (e.g. `"telegram"`).
   *
   * `describe` returns the catalog spec for a registered integration type
   * (registered via `api.registerIntegration`). Returns `null` when the
   * type is unknown. Capability: `catalog.read`.
   */
  integrations: {
    list(filter?: IntegrationListFilter): Promise<IntegrationListItem[]>;
    describe(type: string): Promise<IntegrationSpec | null>;
  };
  /**
   * §4e.5 — Connection-types catalog. Returns the integrationType strings
   * of every plugin that has called `api.registerConnection(spec)`.
   * Read-only catalog data; reuses `db.read` (the data is not user-scoped
   * row content). On a fresh host boot before all plugins have re-registered
   * the list may be empty.
   */
  connections: {
    types(): Promise<string[]>;
    /**
     * Phase 4e.5 batch 4b — post a message into an existing connection
     * thread (Telegram chat, WhatsApp conversation, etc). The host resolves
     * the integration type, dispatches via the registered adapter ThreadImpl,
     * and returns the delivery receipt. Capability: connection.send.
     * Ownership: any plugin with the capability + threadJson may post;
     * threadJson serves as proof of authorized context.
     */
    sendReply(spec: ConnectionSendReplySpec): Promise<ConnectionSendReplyResult>;
  };
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
   *
   * §4e.5 — `create(spec)` creates a workflow row owned by the caller's
   * resolved userId. Publisher-gated; reuses `workflow.write`. Spec is
   * shape-validated (`WorkflowCreateSpecInvalidError`).
   */
  workflow: {
    create(spec: WorkflowCreateSpec): Promise<Workflow>;
    get(workflowId: string): Promise<Workflow | null>;
    list(opts?: WorkflowListOpts): Promise<WorkflowListPage>;
    createExecution(spec: CreateExecutionSpec): Promise<CreateExecutionResult>;
    getExecutionLogs(executionId: string): Promise<ExecutionLogEntry[]>;
    /**
     * List execution rows for a workflow. Capability: `workflow.read`.
     * `limit` defaults to 50, capped at 200 host-side (no throw on overflow).
     * Results are ordered by `startedAt` descending.
     */
    listExecutions(args: {
      workflowId: string;
      limit?: number;
    }): Promise<WorkflowExecution[]>;
  };
  /**
   * §4e.5 batch 2 — Action catalog namespace. Returns every registered action
   * visible to the caller. Read-only; reuses `db.read` capability. Capability:
   * `catalog.read`.
   */
  actions: {
    list(): Promise<Action[]>;
  };
  /**
   * §4e.5 batch 2 — Tool catalog namespace. Returns every registered tool
   * visible to the caller (host-owned + plugin-contributed). Read-only; reuses
   * `db.read` capability. Capability: `catalog.read`.
   */
  tools: {
    list(): Promise<Tool[]>;
  };
  /**
   * §4f batch 1 — Dispatch a unit of work to a plugin-defined worker bundle.
   * The host looks up `workerId` in the plugin's manifest `workers[]`, spawns
   * (or reuses a pooled) `Worker` with `workers/<id>.mjs`, posts `input`, and
   * resolves with the worker's serializable result. The resolved timeout is
   * `min(opts.timeoutMs, manifest.workers[].timeoutMs, hostMaxTimeoutMs)`;
   * on timeout the host terminates the worker and throws
   * `WorkerTimeoutError`. Workers receive structured-clone input + return
   * structured-clone output; they have NO `PluginHostAPI` access (no db, no
   * fetch, no llm — pure compute).
   *
   * Capability: `worker.run`. Manifest `workers[]` MUST list the worker.
   * - Missing capability → `WorkerCapabilityDeniedError`.
   * - Unknown `workerId` → `WorkerNotFoundError`.
   * - Timeout exceeded → `WorkerTimeoutError`.
   */
  runTask(
    workerId: string,
    input: unknown,
    opts?: { timeoutMs?: number }
  ): Promise<unknown>;
};
