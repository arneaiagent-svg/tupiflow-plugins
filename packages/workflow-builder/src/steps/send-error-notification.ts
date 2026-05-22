import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfSendErrorNotificationInput = {
  message: string;
  workflowName?: string;
  workflowId?: string;
  executionId?: string;
};

export async function wfSendErrorNotificationStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as WfSendErrorNotificationInput;
  try {
    const message = input.message?.trim();
    if (!message) {
      return {
        success: false,
        error: { message: "message is required" },
      };
    }
    const result = await api.sendErrorNotification({
      message,
      workflowName: input.workflowName || undefined,
      workflowId: input.workflowId || undefined,
      executionId: input.executionId || undefined,
    });
    return {
      success: true,
      data: result,
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
