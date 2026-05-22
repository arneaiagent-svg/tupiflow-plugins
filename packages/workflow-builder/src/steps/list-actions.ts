// Registry-port of plugins/workflow-builder/steps/list-actions.{ts,impl.ts}.
//
// Source enumerates every action across every loaded plugin via
// `getAllActions()` (the in-memory plugin registry). A registry plugin runs
// in a sandbox and has NO access to that registry — there is no
// `api.actions.list()` surface on the PluginHostAPI shim today.
//
// We surface the system actions (host built-ins) so the step continues to
// return useful data for the most common discovery cases. A `warning` flag
// is set when the plugin action enumeration is omitted so calling agents
// can decide whether to escalate. Flagged in the Phase B port report for
// host-side follow-up.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

interface WfListActionsTypedInput {
  category?: string;
}

const SYSTEM_ACTIONS = [
  {
    actionId: "HTTP Request",
    label: "HTTP Request",
    description: "Make an HTTP request.",
    category: "System",
    integration: "system",
    configKeys: ["httpMethod", "endpoint", "httpHeaders", "httpBody"],
    isTool: false,
  },
  {
    actionId: "Database Query",
    label: "Database Query",
    description: "Run a SQL query against the configured database.",
    category: "System",
    integration: "system",
    configKeys: ["dbQuery", "dbSchema"],
    isTool: false,
  },
  {
    actionId: "Condition",
    label: "Condition",
    description: "Branch based on a boolean expression.",
    category: "System",
    integration: "system",
    configKeys: ["condition"],
    isTool: false,
  },
  {
    actionId: "AI Agent",
    label: "AI Agent",
    description: "Invoke a configured AI agent with a prompt.",
    category: "System",
    integration: "system",
    configKeys: [
      "agentSlug",
      "userPrompt",
      "providerOverride",
      "modelOverride",
    ],
    isTool: false,
  },
] as const;

export async function wfListActionsStep(
  input: RegistryStepInput
): Promise<StepResult> {
  const { api, ctx } = input;
  const typedInput = (ctx.input ?? {}) as WfListActionsTypedInput;
  try {
    const filter = typedInput.category?.trim().toLowerCase();
    const all = [...SYSTEM_ACTIONS];
    const filtered = filter
      ? all.filter((a) => a.category.toLowerCase().includes(filter))
      : all;
    return {
      success: true,
      data: {
        actions: filtered,
        count: filtered.length,
        warning:
          "Plugin actions are not enumerable from a registry plugin sandbox. Only built-in system actions are listed. Use list-integrations to discover per-integration actions.",
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
