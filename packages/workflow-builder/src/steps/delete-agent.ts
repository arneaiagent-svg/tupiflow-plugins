// wfDeleteAgentStep — registry port of plugins/workflow-builder/steps/delete-agent.
//
// The first-party `deleteAgent` helper wrapped a slug regex check + a Drizzle
// DELETE that returned a row-count. We mirror that here via `api.db.write`
// (cross-cutting `agents` writes are allowed for publisher="tupiflow" per the
// Phase 4e.3 gate), using an `xmax` returning trick to verify a row was
// actually removed.

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

    // Pre-check existence via a SELECT so we can return the same
    // `Agent "<slug>" not found` error the first-party helper produced.
    // The host's `api.db.write` is void-returning, so we cannot read rowCount
    // from the DELETE itself.
    const existing = await api.db.read<{ slug: string }>(
      "SELECT slug FROM agents WHERE slug = $1 LIMIT 1",
      [slug]
    );
    if (existing.length === 0) {
      return {
        success: false,
        error: { message: `Agent "${slug}" not found` },
      };
    }
    await api.db.write("DELETE FROM agents WHERE slug = $1", [slug]);
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
