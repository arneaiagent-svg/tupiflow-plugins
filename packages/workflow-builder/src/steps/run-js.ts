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
  const _timeoutMs =
    typeof input.timeoutMs === "number"
      ? Math.min(
          MAX_TIMEOUT_MS,
          Math.max(MIN_TIMEOUT_MS, Math.floor(input.timeoutMs))
        )
      : undefined;
  try {
    return {
      success: false,
      error: {
        message:
          "wfRunJsStep is not yet available in the registry build: the sandboxed JS executor (quickjs-emscripten) has not been ported. Tracked as a Phase B blocker.",
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
