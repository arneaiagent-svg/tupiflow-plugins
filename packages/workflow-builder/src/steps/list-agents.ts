// Registry-port of plugins/workflow-builder/steps/list-agents.{ts,impl.ts}.
//
// v1.1.0 — wired to the Phase 4e.5 batch-1 `api.agents.list` host surface.
// The host returns `AgentListItem[]` already shaped for this step (slug,
// name, description, provider, model, body, history/tool/approval scalars,
// updatedAt). The `tools` JSONB column is intentionally NOT part of that
// projection, so the old `toolCount` derivation is dropped in 1.1.0 — JSONB
// access for agent rows gets a dedicated host path in a later phase.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export async function wfListAgentsStep({
  api,
}: RegistryStepInput): Promise<StepResult> {
  try {
    const items = await api.agents.list();
    const agents = items.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description ?? undefined,
      provider: r.provider ?? undefined,
      model: r.model ?? undefined,
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
