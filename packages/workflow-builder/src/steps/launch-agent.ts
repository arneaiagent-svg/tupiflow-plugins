// wfLaunchAgentStep — registry port of plugins/workflow-builder/steps/launch-agent.
//
// The first-party implementation delegated to the host's
// `aiAgentStep` (backend/src/lib/steps/ai-agent/index.ts), which loads the
// referenced agent's system prompt, provider, model, tool whitelist, MCP
// selections, and KB collections from the `agents` table, then drives a full
// agent loop (LLM call + tool-call dispatch + multimodal attachment binding).
//
// The current PluginHostAPI exposes `api.llm.call` only — there is no
// `api.launchAgent` (or equivalent) surface in
// `@tupiflow-plugins/shared/host-api-types`. A best-effort fallback that
// loaded `agents.body` from the DB and passed it as the system message would
// SILENTLY drop tool dispatch, MCP whitelist enforcement, KB retrieval, and
// multimodal binding — which is dangerous (subagent calls would appear to
// work but only return raw LLM output without tools or memory).
//
// Per the porting brief: when the host does not expose a clean surface, emit
// a console.warn and return an error result so the gap is visible at
// integration time. This is tracked in the Phase B handoff for the host team.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

type Multimodal = string | string[] | undefined;

export type WfLaunchAgentInput = {
  agentSlug?: string;
  userPrompt: string;
  systemPromptOverride?: string;
  providerOverride?: string;
  modelOverride?: string;
  imageUrls?: Multimodal;
  fileUrls?: Multimodal;
  audioUrls?: Multimodal;
  videoUrls?: Multimodal;
};

export async function wfLaunchAgentStep({
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as WfLaunchAgentInput;
  try {
    if (!input.userPrompt?.trim()) {
      return {
        success: false,
        error: { message: "userPrompt is required" },
      };
    }
    console.warn(
      "wfLaunchAgentStep: the host does not expose a `launchAgent` / subagent surface in PluginHostAPI yet. " +
        "Calling api.llm.call alone would skip tool dispatch, MCP whitelist, KB retrieval, and multimodal binding — " +
        "so this step returns an error until the host adds a dedicated subagent API. " +
        `(workflow=${ctx.workflowId} execution=${ctx.executionId} node=${ctx.nodeId})`
    );
    return {
      success: false,
      error: {
        message:
          "wfLaunchAgentStep is not yet available in the registry build: " +
          "PluginHostAPI does not expose a subagent-runner surface (full agent loop with tool dispatch, MCP whitelist, KB retrieval, multimodal). " +
          "Tracked as a Phase B host-api gap; falling back to api.llm.call alone would silently drop those behaviors.",
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
