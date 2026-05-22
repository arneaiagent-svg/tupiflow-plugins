// wfDeleteAgentStep — registry port of plugins/workflow-builder/steps/delete-agent.
//
// v1.1.0 — wired to the Phase 4e.5 batch-1 `api.agents.delete` host surface.
// The host invalidates its agent cache and throws `AgentNotFoundError`
// (name === "AgentNotFoundError") when the row is missing; we catch by
// the error's `.name` to preserve the original error message text.
//
// Local guards retained: slug regex and the `default` protected-slug check
// remain client-side because they encode product semantics not enforced by
// the host surface.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfDeleteAgentInput = { slug: string };

const PROTECTED_SLUGS = new Set(["default"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function wfDeleteAgentStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as WfDeleteAgentInput;
  try {
    const slug = input.slug?.trim();
    if (!slug) {
      return {
        success: false,
        error: { message: "slug is required" },
      };
    }
    if (!SLUG_RE.test(slug)) {
      return {
        success: false,
        error: {
          message:
            "Invalid slug: must be lowercase letters, digits, or hyphens",
        },
      };
    }
    if (PROTECTED_SLUGS.has(slug)) {
      return {
        success: false,
        error: {
          message: `Agent "${slug}" is protected and cannot be deleted.`,
        },
      };
    }

    try {
      await api.agents.delete(slug);
    } catch (error) {
      const name =
        error instanceof Error ? error.name : undefined;
      if (name === "AgentNotFoundError") {
        return {
          success: false,
          error: { message: `Agent "${slug}" not found` },
        };
      }
      throw error;
    }
    return {
      success: true,
      data: { slug, deleted: true },
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
