// Canonical PluginHostAPI type for tupiflow registry plugins.
//
// The consumer-side (tupiflow runtime) provides the concrete implementation
// at runtime via dynamic import. This file is the contract every plugin
// bundle codes against. Keep in sync with
// tupiflow/backend/src/lib/plugin-runtime/host-api.ts.
//
// Phase 4a.2 (api.registerConnection + api.dispatchToWorkflow) is
// intentionally NOT declared here — those methods are not implemented
// host-side yet. Tracked in PLUGIN_TIERS.md.

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
 * Database accessor. Both `read` and `write` execute inside a transaction
 * the host scopes to `plugin_<name>` via `SET LOCAL search_path`. The
 * `params` slot is reserved; the host currently rejects non-empty params
 * (inline values into `rawSql` until parameterized queries land).
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

export type PluginHostAPI = {
  db: PluginDb;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  fetchCredentials(
    integrationId: string
  ): Promise<Record<string, string | undefined>>;
  llm: {
    call(args: LlmCallArgs): Promise<LlmCallResult>;
  };
  logger: PluginLogger;
  registerIntegration(spec: IntegrationSpec): void;
  registerRoute(method: HttpMethod, path: string, handler: RouteHandler): void;
  registerStep(id: string, fn: StepHandler): void;
  // `schema` is typed `unknown` here because the shim is dependency-free.
  // The host accepts a `ZodTypeAny`; plugins importing zod themselves get
  // structural compatibility at the call site.
  registerTool(id: string, schema: unknown, fn: ToolHandler): void;
};
