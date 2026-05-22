// wfGetWorkflowStep — registry port of plugins/workflow-builder/steps/get-workflow.
//
// First-party port: uses api.workflow.get (publisher-gated to publisher="tupiflow").
// Trigger-summary derivation is inlined here so the registry plugin stays
// dependency-free; mirrors the source `summarizeTrigger` helper.

import type {
  RegistryStepInput,
  StepResult,
  Workflow,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfGetWorkflowInput = {
  workflowId?: string;
};

interface TriggerSummary {
  acceptsInput: boolean;
  inputSchema?: unknown[];
  type: string;
}

interface GraphNode {
  id: string;
  data?: {
    type?: "trigger" | "action" | "add";
    config?: Record<string, unknown>;
  };
}

interface GraphEdge {
  target: string;
}

function safeParseSchema(raw: unknown): unknown[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeTrigger(
  nodes: GraphNode[],
  edges: GraphEdge[]
): TriggerSummary | null {
  const targets = new Set(edges.map((e) => e.target));
  const trigger = nodes.find(
    (n) => n.data?.type === "trigger" && !targets.has(n.id)
  );
  if (!trigger) {
    return null;
  }
  const config = (trigger.data?.config ?? {}) as Record<string, unknown>;
  const triggerType = (config.triggerType as string) || "Manual";
  const acceptsInput = triggerType === "Manual" || triggerType === "Webhook";
  const schemaRaw =
    triggerType === "Manual"
      ? config.manualSchema
      : triggerType === "Webhook"
        ? config.webhookSchema
        : undefined;
  const inputSchema = safeParseSchema(schemaRaw);
  return { type: triggerType, inputSchema, acceptsInput };
}

export async function wfGetWorkflowStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  try {
    const input = ctx.input as WfGetWorkflowInput;
    const workflowId = input.workflowId?.trim();
    if (!workflowId) {
      return {
        success: false,
        error: { message: "workflowId is required" },
      };
    }

    let w: Workflow | null;
    try {
      w = await api.workflow.get(workflowId);
    } catch (error) {
      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    if (!w) {
      return {
        success: false,
        error: { message: "Workflow not found or not owned by user." },
      };
    }

    const nodes = (Array.isArray(w.nodes) ? w.nodes : []) as GraphNode[];
    const edges = (Array.isArray(w.edges) ? w.edges : []) as GraphEdge[];

    return {
      success: true,
      data: {
        id: w.id,
        name: w.name,
        description: w.description,
        visibility: w.visibility,
        isSystem: w.isSystem,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodes,
        edges,
        trigger: summarizeTrigger(nodes, edges),
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
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
