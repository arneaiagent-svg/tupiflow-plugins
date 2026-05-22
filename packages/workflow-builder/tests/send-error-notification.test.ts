import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PluginHostAPI, RegistryStepInput, ErrorNotificationSpec } from "@tupiflow-plugins/shared/host-api-types";
import { wfSendErrorNotificationStep } from "../src/steps/send-error-notification.ts";

function makeMockCtx(
  input: Record<string, unknown>,
  notifierResponse: (spec: ErrorNotificationSpec) => any
): { stepInput: RegistryStepInput; calls: ErrorNotificationSpec[] } {
  const calls: ErrorNotificationSpec[] = [];
  const stepInput: RegistryStepInput = {
    api: {
      sendErrorNotification: async (spec: ErrorNotificationSpec) => {
        calls.push(spec);
        return notifierResponse(spec);
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

test("wfSendErrorNotificationStep - success dispatch", async () => {
  const { stepInput, calls } = makeMockCtx(
    {
      message: "Database connection failed",
      workflowName: "Data Sync",
      workflowId: "w-sync",
      executionId: "exec-sync-1",
    },
    (spec) => {
      return { dispatched: true };
    }
  );

  const result = await wfSendErrorNotificationStep(stepInput);

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data, { dispatched: true });
  }

  assert.deepEqual(calls[0], {
    message: "Database connection failed",
    workflowName: "Data Sync",
    workflowId: "w-sync",
    executionId: "exec-sync-1",
  });
});

test("wfSendErrorNotificationStep - validation fails if message is missing", async () => {
  const { stepInput } = makeMockCtx({}, () => ({ dispatched: false }));

  const result = await wfSendErrorNotificationStep(stepInput);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /message is required/);
  }
});

test("wfSendErrorNotificationStep - handle exceptions", async () => {
  const { stepInput } = makeMockCtx(
    {
      message: "An error happened",
    },
    () => {
      throw new Error("Notifier system offline");
    }
  );

  const result = await wfSendErrorNotificationStep(stepInput);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.message, "Notifier system offline");
  }
});
