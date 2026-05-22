// Registry-port of plugins/workflow-builder/steps/list-agents.{ts,impl.ts}.
//
// Source calls `listAgents()` from `backend/src/lib/agents.ts` which selects
// every row from the globally-shared `public.agents` table (agents are NOT
// per-user in v1). The registry plugin reaches that table via fully
// qualified SQL — the plugin role shares the app DB user so cross-schema
// reads succeed at the SQL layer.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

interface AgentRow {
  slug: string;
  name: string;
  description: string | null;
  provider: string | null;
  model: string | null;
  // jsonb — the host's postgres-js receive path parses to JS objects.
  tools: unknown;
}

export async function wfListAgentsStep(
  { api }: RegistryStepInput
): Promise<StepResult> {
  try {
    const rows = await api.db.read<AgentRow>(
      `SELECT slug, name, description, provider, model, tools
       FROM public.agents
       ORDER BY name ASC`
    );

    const agents = rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description ?? undefined,
      provider: r.provider ?? undefined,
      model: r.model ?? undefined,
      toolCount: Array.isArray(r.tools) ? r.tools.length : 0,
    }));

    return {
      success: true,
      data: { agents, count: agents.length },
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
