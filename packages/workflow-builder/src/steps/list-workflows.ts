// Registry-port of plugins/workflow-builder/steps/list-workflows.{ts,impl.ts}.
//
// Source reads `workflows` directly via Drizzle and counts nodes/edges per row.
// The registry surface exposes `api.workflow.list()` which returns the list-row
// projection (no nodes/edges, no isEnabled filter). Consequently the registry
// version cannot return `nodeCount`, `edgeCount`, or `trigger` (those need
// nodes + edges). Search is applied client-side over the page items returned
// by the host.

import type {
  RegistryStepInput,
  StepResult,
  WorkflowListItem,
  WorkflowListPage,
} from "@tupiflow-plugins/shared/host-api-types";

interface WfListWorkflowsTypedInput {
  search?: string;
}

export async function wfListWorkflowsStep(
  input: RegistryStepInput
): Promise<StepResult> {
  const { api, ctx } = input;
  const typedInput = (ctx.input ?? {}) as WfListWorkflowsTypedInput;
  try {
    const search = typedInput.search?.trim().toLowerCase();
    const items: WorkflowListItem[] = [];
    let cursor: string | undefined;
    // Walk pages so search applies over the full owned set, not just the
    // first page. Host clamps `limit` to 200.
    // biome-ignore lint/correctness/noConstantCondition: paginate until empty
    while (true) {
      const opts = cursor
        ? { userId: ctx.userId, limit: 200, cursor }
        : { userId: ctx.userId, limit: 200 };
      const page: WorkflowListPage = await api.workflow.list(opts);
      items.push(...page.items);
      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }

    const filtered = search
      ? items.filter((w) => w.name.toLowerCase().includes(search))
      : items;

    return {
      success: true,
      data: {
        workflows: filtered.map((w) => ({
          id: w.id,
          name: w.name,
          description: null,
          visibility: w.visibility,
          // Not available without nodes/edges. Surfaced as null + 0 so the
          // shape is stable for downstream agent consumers.
          nodeCount: 0,
          edgeCount: 0,
          updatedAt: w.updatedAt,
          isSystem: w.isSystem,
          trigger: null,
        })),
        count: filtered.length,
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
