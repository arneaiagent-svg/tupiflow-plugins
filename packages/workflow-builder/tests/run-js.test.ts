import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PluginHostAPI, RegistryStepInput, SandboxOpts, SandboxResult } from "@tupiflow-plugins/shared/host-api-types";
import { wfRunJsStep } from "../src/steps/run-js.ts";

interface SandboxCall {
  code: string;
  ctx: { data: unknown };
  opts?: SandboxOpts;
}

function makeMockCtx(
  input: Record<string, unknown>,
  sandboxResponse: (call: SandboxCall) => SandboxResult
): { stepInput: RegistryStepInput; calls: SandboxCall[] } {
  const calls: SandboxCall[] = [];
  const stepInput: RegistryStepInput = {
    api: {
      runSandbox: async (code: string, ctx: { data: unknown }, opts?: SandboxOpts) => {
        calls.push({ code, ctx, opts });
        return sandboxResponse({ code, ctx, opts });
      },
    } as unknown as PluginHostAPI,
    ctx: {
      input,
      userId: "u-test",
      nodeId: "n-test",
      workflowId: "w-test",
      executionId: "exec-test",
    },
  };
  return { stepInput, calls };
}

test("wfRunJsStep - success sandbox run", async () => {
  const { stepInput } = makeMockCtx(
    {
      code: "return data.x + 1;",
      data: { x: 41 },
      timeoutMs: 500,
    },
    (call) => {
      return {
        success: true,
        value: 42,
        logs: ["adding 1 to 41"],
      };
    }
  );

  const result = await wfRunJsStep(stepInput);

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data, {
      success: true,
      value: 42,
      logs: ["adding 1 to 41"],
    });
  }
});

test("wfRunJsStep - sandbox execution error returns success: false step result", async () => {
  const { stepInput } = makeMockCtx(
    {
      code: "invalid js",
    },
    (call) => {
      return {
        success: false,
        error: {
          kind: "syntax",
          message: "SyntaxError: Unexpected identifier",
        },
        logs: [],
      };
    }
  );

  const result = await wfRunJsStep(stepInput);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.message, "SyntaxError: Unexpected identifier");
  }
});

test("wfRunJsStep - validation fails if code is missing", async () => {
  const { stepInput } = makeMockCtx({}, () => {
    return { success: true, value: null, logs: [] };
  });

  const result = await wfRunJsStep(stepInput);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /code is required/);
  }
});

test("wfRunJsStep - defensive timeout clamping", async () => {
  // Test clamping huge timeout down to 10,000
  const { stepInput: stepInputHigh, calls: callsHigh } = makeMockCtx(
    {
      code: "const x = 1;",
      timeoutMs: 999999,
    },
    () => ({ success: true, value: null, logs: [] })
  );
  await wfRunJsStep(stepInputHigh);
  assert.equal(callsHigh[0]?.opts?.timeoutMs, 10000);

  // Test clamping tiny timeout up to 1
  const { stepInput: stepInputLow, calls: callsLow } = makeMockCtx(
    {
      code: "const x = 1;",
      timeoutMs: -50,
    },
    () => ({ success: true, value: null, logs: [] })
  );
  await wfRunJsStep(stepInputLow);
  assert.equal(callsLow[0]?.opts?.timeoutMs, 1);
});

test("wfRunJsStep - catch threw exceptions", async () => {
  const { stepInput } = makeMockCtx(
    {
      code: "const x = 1;",
    },
    () => {
      throw new Error("sandbox engine crashed");
    }
  );

  const result = await wfRunJsStep(stepInput);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.message, "sandbox engine crashed");
  }
});
