// Registry-port of plugins/workflow-builder/steps/list-connections.{ts,impl.ts}.
//
// v1.1.0 — wired to the Phase 4e.5 batch-1 `api.connections.types` host
// surface. The host returns the integrationType strings of every registered
// connection plugin. The caller's tenant integrations are then fetched via
// `api.integrations.list()` and filtered to those types. The caller can still
// pass an explicit `types` override to narrow / expand the set beyond the
// live catalog (useful for testing or non-standard connection plugins not yet
// registered on this boot).

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

interface WfListConnectionsTypedInput {
  types?: string[];
}

export async function wfListConnectionsStep(
  input: RegistryStepInput
): Promise<StepResult> {
  const { api, ctx } = input;
  const typedInput = (ctx.input ?? {}) as WfListConnectionsTypedInput;
  try {
    // Caller-supplied override takes precedence; fall back to live catalog.
    let connectionTypes: string[];
    if (typedInput.types && typedInput.types.length > 0) {
      connectionTypes = typedInput.types;
    } else {
      connectionTypes = await api.connections.types();
    }

    const typeSet = new Set(connectionTypes.map((t) => t.toLowerCase()));

    // Fetch all tenant integrations and filter to connection types.
    const allRows = await api.integrations.list();
    const rows = allRows.filter((r) => typeSet.has(r.type.toLowerCase()));

    const enriched = rows.map((r) => ({
      integrationId: r.id,
      integrationName: r.name,
      integrationType: r.type,
      // Plugin spec metadata (label / triggerType / triggerLabel) is not
      // reachable from a registry plugin's sandbox.
      integrationLabel: r.type,
      triggerType: "",
      triggerLabel: "",
    }));

    return {
      success: true,
      data: { connections: enriched, count: enriched.length },
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
