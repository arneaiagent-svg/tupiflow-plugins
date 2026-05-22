// Registry-port of plugins/workflow-builder/steps/list-connections.{ts,impl.ts}.
//
// Source impl filters `integrations` to rows whose `type` is registered as a
// connection plugin (e.g. telegram, whatsapp). The list of connection plugin
// types lives on the in-memory plugin registry which the registry plugin
// cannot reach. We hard-code the known first-party connection types — the
// caller can pass an explicit `types` filter to override / extend the set.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

interface WfListConnectionsTypedInput {
  types?: string[];
}

interface IntegrationRow {
  id: string;
  name: string;
  type: string;
}

const DEFAULT_CONNECTION_TYPES = ["telegram", "whatsapp"] as const;

export async function wfListConnectionsStep(
  input: RegistryStepInput
): Promise<StepResult> {
  const { api, ctx } = input;
  const typedInput = (ctx.input ?? {}) as WfListConnectionsTypedInput;
  try {
    const connectionTypes =
      typedInput.types && typedInput.types.length > 0
        ? typedInput.types
        : [...DEFAULT_CONNECTION_TYPES];

    const rows = await api.db.read<IntegrationRow>(
      `SELECT id, name, type
       FROM public.integrations
       WHERE user_id = $1 AND type = ANY($2::text[])
       ORDER BY name ASC`,
      [ctx.userId, connectionTypes]
    );

    const enriched = rows.map((r) => ({
      integrationId: r.id,
      integrationName: r.name,
      integrationType: r.type,
      // Plugin spec metadata (label / triggerType / triggerLabel) is not
      // reachable from a registry plugin's sandbox. Surface the type string
      // so downstream agents have a stable label.
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
