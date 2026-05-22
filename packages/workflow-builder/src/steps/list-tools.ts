// Registry-port of plugins/workflow-builder/steps/list-tools.{ts,impl.ts}.
//
// Source enumerates every tool-eligible action across every loaded plugin
// via `getToolEligibleActions()` (the in-memory plugin registry). A
// registry plugin runs in a sandbox and has NO access to that registry —
// there is no `api.tools.list()` surface on the PluginHostAPI shim today.
//
// Returns an empty page with `warning` so calling agents can fall back to
// `list-integrations` for per-integration action discovery. Flagged in the
// Phase B port report for host-side follow-up.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

interface WfListToolsTypedInput {
  category?: string;
  integration?: string;
  limit?: number;
  offset?: number;
  query?: string;
  slim?: boolean;
}

const MAX_LIMIT = 200;

function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const n = Math.floor(value);
  if (n < min) {
    return min;
  }
  if (n > max) {
    return max;
  }
  return n;
}

export async function wfListToolsStep(
  input: RegistryStepInput
): Promise<StepResult> {
  const { api, ctx } = input;
  const typedInput = (ctx.input ?? {}) as WfListToolsTypedInput;
  try {
    const offset = clampInt(typedInput.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit =
      typedInput.limit === undefined || typedInput.limit === null
        ? null
        : clampInt(typedInput.limit, MAX_LIMIT, 1, MAX_LIMIT);

    return {
      success: true,
      data: {
        tools: [],
        count: 0,
        total: 0,
        offset,
        limit,
        hasMore: false,
        warning:
          "Tool-eligible actions are not enumerable from a registry plugin sandbox. Use list-integrations to discover per-integration actions.",
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
