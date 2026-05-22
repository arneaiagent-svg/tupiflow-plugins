// Registry-port of plugins/workflow-builder/steps/list-integrations.{ts,impl.ts}.
//
// v1.1.0 — wired to the Phase 4e.5 batch-1 `api.integrations.list` host
// surface. The host scopes rows to the caller's resolved userId and accepts
// an optional `{ type }` filter. Plugin spec metadata (label, description,
// action list) is still not reachable from a registry sandbox, so those
// fields continue to degrade to the type string / empty values until a
// future surface exposes the in-memory plugin registry.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

interface WfListIntegrationsTypedInput {
  type?: string;
}

export async function wfListIntegrationsStep(
  input: RegistryStepInput
): Promise<StepResult> {
  const { api, ctx } = input;
  const typedInput = (ctx.input ?? {}) as WfListIntegrationsTypedInput;
  try {
    const typeFilter = typedInput.type?.trim().toLowerCase();

    const rows = await api.integrations.list(
      typeFilter ? { type: typeFilter } : undefined
    );

    const enriched = rows.map((r) => ({
      integrationId: r.id,
      name: r.name,
      type: r.type,
      // Plugin spec metadata is not reachable from a registry plugin's
      // sandbox. Surface the type string so downstream agents have a stable
      // label without crashing.
      label: r.type,
      description: "",
      isManaged: Boolean(r.isManaged),
      createdAt: r.createdAt,
      actions: [] as Array<{
        actionId: string;
        slug: string;
        label: string;
        description: string;
        category: string;
        isTool: boolean;
      }>,
    }));

    return {
      success: true,
      data: { integrations: enriched, count: enriched.length },
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
