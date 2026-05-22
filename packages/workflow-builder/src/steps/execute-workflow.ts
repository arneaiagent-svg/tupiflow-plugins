// wfExecuteWorkflowStep — registry port of
// plugins/workflow-builder/steps/execute-workflow.
//
// Replaces direct db.insert(workflowExecutions) + workflow SDK start() with
// api.workflow.createExecution. The host implementation owns ownership checks,
// validation, disabled-plugin guards, and the actual durable-workflow start
// call (PHASE_4E_SEEDED_HOST_API.md §2.6).

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfExecuteWorkflowInput = {
  workflowId?: string;
  input?: Record<string, unknown>;
};

export async function wfExecuteWorkflowStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  try {
    const stepInput = ctx.input as WfExecuteWorkflowInput;
    const workflowId = stepInput.workflowId?.trim();
    if (!workflowId) {
      return {
        success: false,
        error: { message: "workflowId is required" },
      };
    }

    if (ctx.workflowId && ctx.workflowId === workflowId) {
      return {
        success: false,
        error: {
          message: "Workflow cannot execute itself (would loop forever).",
        },
      };
    }

    const triggerInput = stepInput.input ?? {};

    let result: { executionId: string; status: "running" };
    try {
      result = await api.workflow.createExecution({
        workflowId,
        input: triggerInput,
      });
    } catch (error) {
      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    return {
      success: true,
      data: {
        executionId: result.executionId,
        workflowId,
        status: result.status,
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
