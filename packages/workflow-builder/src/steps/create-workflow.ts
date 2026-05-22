// wfCreateWorkflowStep — registry port of
// plugins/workflow-builder/steps/create-workflow.
//
// Replaces the first-party `aiAgentStep` + seed agent invocation with a
// direct `api.llm.call` (system + user message). The seed-agent + dynamic
// PLUGIN_ACTIONS catalog injection is not yet reachable from a registry
// plugin (no host hook for "load agent by slug" / "render plugin action
// catalog"), so the host's default model is used with a static system
// prompt that captures the schema requirements.
//
// The INSERT into `workflows` uses `api.db.write`. `workflows` is a core
// (tupiflow-owned) table — this plugin is publisher="tupiflow" so the
// 4e.3 host gate allows core-table writes (see brief).
//
// Heavy graph validation (`validateGeneratedWorkflow`, the zod
// `workflowGraphSchema`) lives in tupiflow-internal modules the registry
// shim cannot import. We do minimal structural validation here (name +
// nodes/edges arrays) and rely on the host's own workflow load path to
// reject malformed graphs at execution time. See PHASE_4D_SEEDED_GAPS.md
// for the deferred validator surface.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfCreateWorkflowInput = {
  workflowDescription?: string;
};

interface GeneratedWorkflow {
  name: string;
  description?: string;
  nodes: unknown[];
  edges: unknown[];
}

const MAX_GENERATION_ATTEMPTS = 3;
const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateId(): string {
  // 21-char nanoid-style id, matches the host's `generateId()` convention
  // (lib/utils/id.ts) without pulling in nanoid as a dep.
  const bytes = new Uint8Array(21);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += ID_ALPHABET[(bytes[i] ?? 0) % ID_ALPHABET.length];
  }
  return out;
}

const SYSTEM_PROMPT = [
  "You generate workflow definitions for the tupiflow visual workflow builder.",
  "Output a single JSON object — no markdown fences, no prose.",
  "",
  "Schema:",
  "{",
  '  "name": string (required, non-empty),',
  '  "description": string (optional),',
  '  "nodes": array of node objects,',
  '  "edges": array of edge objects',
  "}",
  "",
  "Each node has: id (string), position {x,y}, data {",
  '  label: string,',
  '  type: "trigger" | "action",',
  '  config: object (must include "actionType" for actions; triggers include "triggerType": "Manual" | "Webhook" | "Schedule" | "Chat Message")',
  "}.",
  "Each edge has: id (string), source (node id), target (node id).",
  "",
  "There must be exactly one trigger node. All other nodes are actions.",
  "Edges form a directed acyclic graph rooted at the trigger.",
].join("\n");

const FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(FENCE_RE);
  return match ? (match[1] ?? "").trim() : trimmed;
}

type ParseOutcome =
  | { ok: true; value: GeneratedWorkflow }
  | { ok: false; error: string };

function validateGenerated(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Output is not a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    return { ok: false, error: "Missing or empty 'name' field" };
  }
  if (!Array.isArray(obj.nodes)) {
    return { ok: false, error: "'nodes' must be an array" };
  }
  if (!Array.isArray(obj.edges)) {
    return { ok: false, error: "'edges' must be an array" };
  }
  const triggerCount = obj.nodes.filter((n) => {
    const data =
      n && typeof n === "object" ? (n as { data?: unknown }).data : undefined;
    return (
      data &&
      typeof data === "object" &&
      (data as { type?: unknown }).type === "trigger"
    );
  }).length;
  if (triggerCount !== 1) {
    return {
      ok: false,
      error: `Workflow must contain exactly one trigger node, found ${triggerCount}.`,
    };
  }
  return {
    ok: true,
    value: {
      name: obj.name,
      description:
        typeof obj.description === "string" ? obj.description : undefined,
      nodes: obj.nodes,
      edges: obj.edges,
    },
  };
}

function parseAndValidate(raw: string): ParseOutcome {
  const cleaned = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return {
      ok: false,
      error: `Output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return validateGenerated(parsed);
}

function buildRetryPrompt(
  originalDescription: string,
  priorOutput: string,
  error: string
): string {
  return `Original request: ${originalDescription}

Your previous attempt failed validation: ${error}

Your previous output was:
${priorOutput}

Return a corrected workflow as a single JSON object matching the schema. Output ONLY the JSON object — no markdown fences, no prose.`;
}

function extractTriggerType(nodes: unknown[]): string | null {
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const data = (raw as { data?: unknown }).data;
    if (!data || typeof data !== "object") {
      continue;
    }
    if ((data as { type?: unknown }).type !== "trigger") {
      continue;
    }
    const config = (data as { config?: unknown }).config;
    if (!config || typeof config !== "object") {
      return null;
    }
    const triggerType = (config as { triggerType?: unknown }).triggerType;
    return typeof triggerType === "string" && triggerType.length > 0
      ? triggerType
      : null;
  }
  return null;
}

export async function wfCreateWorkflowStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  try {
    const input = ctx.input as WfCreateWorkflowInput;
    const description = input.workflowDescription?.trim();
    if (!description) {
      return {
        success: false,
        error: { message: "workflowDescription is required" },
      };
    }
    const userId = ctx.userId;
    if (!userId) {
      return {
        success: false,
        error: {
          message:
            "create-workflow requires an authenticated user; no userId in context",
        },
      };
    }

    api.logger.info("generating workflow", {
      promptPreview: description.slice(0, 200),
    });

    let userPrompt = description;
    let generated: GeneratedWorkflow | null = null;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      let llmText: string;
      try {
        const llm = await api.llm.call({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        });
        llmText = llm.text;
      } catch (error) {
        return {
          success: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      const outcome = parseAndValidate(llmText);
      if (outcome.ok) {
        generated = outcome.value;
        lastError = null;
        break;
      }
      lastError = outcome.error;
      api.logger.warn("generated workflow failed validation", {
        attempt,
        error: outcome.error,
      });
      if (attempt === MAX_GENERATION_ATTEMPTS) {
        break;
      }
      userPrompt = buildRetryPrompt(description, llmText, outcome.error);
    }

    if (!generated || lastError) {
      return {
        success: false,
        error: {
          message: `Generated workflow failed validation after ${MAX_GENERATION_ATTEMPTS} attempts: ${lastError ?? "unknown error"}`,
        },
      };
    }

    const workflowId = generateId();
    const workflowName = generated.name;
    const workflowDescription = generated.description ?? "";
    const triggerType = extractTriggerType(generated.nodes);

    try {
      await api.db.write(
        `INSERT INTO workflows
          (id, name, description, user_id, nodes, edges, is_valid, validation_error, trigger_type, visibility, is_system, is_enabled)
         VALUES
          ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
        [
          workflowId,
          workflowName,
          workflowDescription,
          userId,
          JSON.stringify(generated.nodes),
          JSON.stringify(generated.edges),
          true,
          null,
          triggerType,
          "private",
          false,
          true,
        ]
      );
    } catch (error) {
      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    api.logger.info("workflow created", {
      id: workflowId,
      nodeCount: generated.nodes.length,
      edgeCount: generated.edges.length,
    });

    return {
      success: true,
      data: {
        id: workflowId,
        name: workflowName,
        description: workflowDescription,
        url: `/workflows/${workflowId}`,
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
