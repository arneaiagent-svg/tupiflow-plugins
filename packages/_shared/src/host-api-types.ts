// Canonical PluginHostAPI type for tupiflow registry plugins.
//
// The consumer-side (tupiflow runtime) provides the concrete implementation
// at runtime via dynamic import. This file is the contract every plugin
// bundle codes against. Keep in sync with tupiflow's host-api.ts.

export type StepResult =
  | { success: true; data: unknown }
  | { success: false; error: { message: string } };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteContext = {
  json: (body: unknown, status?: number) => unknown;
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

export type PluginHostAPI = {
  registerIntegration(spec: IntegrationSpec): void;
  registerStep(id: string, fn: StepHandler): void;
  registerTool(id: string, schema: unknown, fn: ToolHandler): void;
  registerRoute(method: HttpMethod, path: string, handler: RouteHandler): void;
};
