// Phase 4f batch 1 — compute-hash step.
//
// Thin step wrapper around the compute-hash worker. Demonstrates the
// api.runTask contract end-to-end: receives a string via the workflow
// config, dispatches to the worker via api.runTask("compute-hash", ...),
// and surfaces the sha256 hex in the step output. Pure-compute pattern
// proof — no DB, no LLM, no network involved.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfComputeHashInput = {
  input: string;
};

export async function wfComputeHashStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const raw = ctx.input as Partial<WfComputeHashInput>;
  const input = raw.input ?? "";

  if (typeof input !== "string") {
    return {
      success: false,
      error: { message: "input must be a string" },
    };
  }

  try {
    const result = (await api.runTask("compute-hash", { input })) as {
      hash: string;
    };
    return {
      success: true,
      data: {
        hash: result.hash,
        algorithm: "sha256",
        inputLength: input.length,
      },
    };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { success: false, error: { message: e.message } };
  }
}
