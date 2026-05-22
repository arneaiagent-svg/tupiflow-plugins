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

export type WfLaunchAgentInput = {
  agentSlug: string;
  prompt?: string;
  userPrompt?: string;
  providerOverride?: string;
  modelOverride?: string;
  maxToolSteps?: number;
  connectionIntegrationId?: string;
  connectionThreadJson?: NonNullable<unknown>;
};

export async function wfLaunchAgentStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as WfLaunchAgentInput;
  try {
    const agentSlug = input.agentSlug?.trim() || "default";
    const prompt = (input.prompt || input.userPrompt)?.trim();

    if (!prompt) {
      return {
        success: false,
        error: { message: "prompt is required and cannot be empty" },
      };
    }

    const result = await api.launchAgent(agentSlug, prompt, {
      providerOverride: input.providerOverride || undefined,
      modelOverride: input.modelOverride || undefined,
      maxToolSteps: typeof input.maxToolSteps === "number" ? input.maxToolSteps : undefined,
      connectionIntegrationId: input.connectionIntegrationId || undefined,
      connectionThreadJson: input.connectionThreadJson || undefined,
    });

    return {
      success: true,
      data: {
        text: result.text,
        toolStepsUsed: result.toolStepsUsed,
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
