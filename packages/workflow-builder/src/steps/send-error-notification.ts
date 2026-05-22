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
    return {
      success: false,
      error: {
        message:
          "wfSendErrorNotificationStep is not yet available in the registry build: the host-side sendManualNotification utility (workflow-error-notifier) has not been ported. Tracked as a Phase B blocker.",
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
