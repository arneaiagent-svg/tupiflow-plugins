// Registry-port of plugins/workflow-builder/steps/list-integrations.{ts,impl.ts}.
//
// Reads the cross-cutting `public.integrations` table via the plugin host's
// `api.db.read`. The plugin's `SET LOCAL search_path` is bound to
// `plugin_workflow-builder` so we fully qualify `public.integrations` to
// reach the cross-schema table — the host's plugin role shares the app DB
// user so cross-schema reads succeed at the SQL layer.
//
// Source impl additionally decorated each row with plugin spec metadata
// (label, description, action list) pulled from the in-memory plugin
// registry. The registry plugin has no access to that registry, so those
// fields fall back to type-derived strings and an empty action list.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

interface WfListIntegrationsTypedInput {
  type?: string;
}

interface IntegrationRow {
  id: string;
  name: string;
  type: string;
  is_managed: boolean | null;
  created_at: string | Date;
}

export async function wfListIntegrationsStep(
  input: RegistryStepInput
): Promise<StepResult> {
  const { api, ctx } = input;
  const typedInput = (ctx.input ?? {}) as WfListIntegrationsTypedInput;
  try {
    const typeFilter = typedInput.type?.trim().toLowerCase();

    const rows = await api.db.read<IntegrationRow>(
      `SELECT id, name, type, is_managed, created_at
       FROM public.integrations
       WHERE user_id = $1
       ORDER BY name ASC`,
      [ctx.userId]
    );

    const filtered = typeFilter
      ? rows.filter((r) => r.type.toLowerCase() === typeFilter)
      : rows;

    const enriched = filtered.map((r) => ({
      integrationId: r.id,
      name: r.name,
      type: r.type,
      // Plugin spec metadata is not reachable from a registry plugin's
      // sandbox. Surface the type string so downstream agents have a stable
      // label without crashing.
      label: r.type,
      description: "",
      isManaged: Boolean(r.is_managed),
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : new Date(r.created_at).toISOString(),
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
