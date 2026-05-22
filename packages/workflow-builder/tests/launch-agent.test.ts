import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PluginHostAPI, RegistryStepInput } from "@tupiflow-plugins/shared/host-api-types";
import { wfLaunchAgentStep } from "../src/steps/launch-agent.ts";

function makeMockCtx(input: Record<string, unknown>): RegistryStepInput {
  return {
    api: {
      launchAgent: async (slug: string, prompt: string, opts?: any) => {
        if (slug === "throw-error") {
          throw new Error("Simulated host API error");
        }
        return {
          text: `Launched agent ${slug} with prompt: ${prompt}. opts: ${JSON.stringify(opts)}`,
          toolStepsUsed: 42,
        };
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
}

test("wfLaunchAgentStep - success flow with options", async () => {
  const input = makeMockCtx({
    agentSlug: "my-agent",
    prompt: "Hello, agent!",
    providerOverride: "openai",
    modelOverride: "gpt-4",
    maxToolSteps: 5,
    connectionIntegrationId: "conn-123",
    connectionThreadJson: { active: true },
  });

  const result = await wfLaunchAgentStep(input);

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data, {
      text: 'Launched agent my-agent with prompt: Hello, agent!. opts: {"providerOverride":"openai","modelOverride":"gpt-4","maxToolSteps":5,"connectionIntegrationId":"conn-123","connectionThreadJson":{"active":true}}',
      toolStepsUsed: 42,
    });
  }
});

test("wfLaunchAgentStep - backward compatibility with userPrompt", async () => {
  const input = makeMockCtx({
    agentSlug: "my-agent",
    userPrompt: "Hello from userPrompt!",
    providerOverride: "openai",
    modelOverride: "gpt-4",
  });

  const result = await wfLaunchAgentStep(input);

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data, {
      text: 'Launched agent my-agent with prompt: Hello from userPrompt!. opts: {"providerOverride":"openai","modelOverride":"gpt-4"}',
      toolStepsUsed: 42,
    });
  }
});

test("wfLaunchAgentStep - defaults agentSlug to default if missing", async () => {
  const input = makeMockCtx({
    prompt: "Hello",
  });

  const result = await wfLaunchAgentStep(input);

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data, {
      text: 'Launched agent default with prompt: Hello. opts: {}',
      toolStepsUsed: 42,
    });
  }
});

test("wfLaunchAgentStep - validation fails if prompt is missing", async () => {
  const input = makeMockCtx({
    agentSlug: "my-agent",
  });

  const result = await wfLaunchAgentStep(input);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /prompt is required/);
  }
});

test("wfLaunchAgentStep - throws error from host API", async () => {
  const input = makeMockCtx({
    agentSlug: "throw-error",
    prompt: "Do something",
  });

  const result = await wfLaunchAgentStep(input);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /Simulated host API error/);
  }
});
