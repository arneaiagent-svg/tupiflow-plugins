// wfGetWorkflowExecutionsStep — registry port of
// plugins/workflow-builder/steps/get-workflow-executions.
//
// Listing executions for a workflow is not yet exposed on the seeded
// host-API workflow.* namespace (only get / list workflows /
// createExecution / getExecutionLogs are seeded — see
// PHASE_4E_SEEDED_HOST_API.md §2.6). For first-party publisher="tupiflow"
// plugins the host's db.read capability covers the core tables, so we
// query `workflow_executions` directly here and then delegate per-row
// log fetch to api.workflow.getExecutionLogs (which is publisher-gated
// to "tupiflow" in v0).

import type {
  ExecutionLogEntry,
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfGetWorkflowExecutionsInput = {
  workflowId?: string;
  limit?: number | string;
};

interface ExecutionRow {
  id: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  started_at: string | Date;
  completed_at: string | Date | null;
  duration: string | null;
}

function parseLimit(raw: number | string | undefined): number {
  if (raw === undefined || raw === null || raw === "") {
    return 10;
  }
  const n = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return 10;
  }
  return Math.min(Math.floor(n), 50);
}

function toIso(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  // postgres-js returns timestamps as Date by default, but cover the string
  // path just in case the driver was configured otherwise.
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function wfGetWorkflowExecutionsStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  try {
    const input = ctx.input as WfGetWorkflowExecutionsInput;
    const workflowId = input.workflowId?.trim();
    if (!workflowId) {
      return {
        success: false,
        error: { message: "workflowId is required" },
      };
    }

    // Ownership check: api.workflow.get scopes to the caller's userId and
    // returns null on miss / cross-tenant. Cheaper than a custom JOIN here.
    const workflow = await api.workflow.get(workflowId);
    if (!workflow) {
      return {
        success: false,
        error: { message: "Workflow not found or not owned by user." },
      };
    }

    const limit = parseLimit(input.limit);
    const execs = await api.db.read<ExecutionRow>(
      `SELECT id, status, input, output, error, started_at, completed_at, duration
       FROM workflow_executions
       WHERE workflow_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [workflowId, limit]
    );

    if (execs.length === 0) {
      return {
        success: true,
        data: { executions: [], count: 0 },
      };
    }

    const executions = await Promise.all(
      execs.map(async (e) => {
        let logs: ExecutionLogEntry[] = [];
        try {
          logs = await api.workflow.getExecutionLogs(e.id);
        } catch {
          // If the host blocks log access for any reason, return the
          // execution row with an empty log array rather than failing the
          // whole step.
          logs = [];
        }
        return {
          id: e.id,
          status: e.status,
          input: e.input,
          output: e.output,
          error: e.error,
          startedAt: toIso(e.started_at),
          completedAt: toIso(e.completed_at),
          duration: e.duration,
          logs: logs.map((l) => ({
            nodeId: l.nodeId,
            nodeName: l.nodeName,
            nodeType: l.nodeType,
            status: l.status,
            input: l.input,
            output: l.output,
            error: l.error,
            startedAt: l.startedAt,
            completedAt: l.completedAt,
            duration: l.duration,
          })),
        };
      })
    );

    return {
      success: true,
      data: { executions, count: executions.length },
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
