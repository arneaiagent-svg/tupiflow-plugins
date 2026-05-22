import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfRunJsInput = {
  code: string;
  data?: unknown;
  timeoutMs?: number;
};

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 10_000;

export async function wfRunJsStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as WfRunJsInput;
  const code = typeof input.code === "string" ? input.code : "";
  if (!code) {
    return {
      success: false,
      error: { message: "code is required" },
    };
  }
  const timeoutMs =
    typeof input.timeoutMs === "number"
      ? Math.min(
          MAX_TIMEOUT_MS,
          Math.max(MIN_TIMEOUT_MS, Math.floor(input.timeoutMs))
        )
      : undefined;
  try {
    const result = await api.runSandbox(
      code,
      { data: input.data ?? null },
      { timeoutMs }
    );
    if (result.success) {
      return {
        success: true,
        data: {
          success: true,
          value: result.value,
          logs: result.logs,
        },
      };
    } else {
      return {
        success: false,
        error: {
          message: result.error.message,
        },
      };
    }
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
