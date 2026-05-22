// wfUpdateAgentStep — registry port of plugins/workflow-builder/steps/update-agent.
//
// Same translation pattern as create-agent.ts: the original called the host's
// `agents.ts` helpers (saveAgent + saveAgentTools / saveAgentMcpTools /
// saveAgentKbCollections) which wrote to the cross-cutting `agents` table.
// We perform a SELECT-then-UPDATE here through `api.db.read` / `api.db.write`
// to preserve the "undefined = leave unchanged, null = clear" semantics the
// upstream `mergeNullable` helper enforces.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export interface WfAgentToolOverrideInput {
  description?: string;
  inputSchemaJson?: string;
  name?: string;
}

export interface WfAgentToolInput {
  actionId: string;
  enabled?: boolean;
  integrationId?: string;
  override?: WfAgentToolOverrideInput;
  requireApproval?: boolean;
  triggerKeywords?: string[];
}

export interface WfMcpToolOverrideInput {
  description?: string;
  inputSchemaJson?: string;
}

export interface WfMcpToolSelectionInput {
  approvalToolNames?: string[];
  integrationId: string;
  overrides?: Record<string, WfMcpToolOverrideInput>;
  toolNames: string[];
}

export type WfUpdateAgentInput = {
  approvalTargetChatId?: string | null;
  approvalTargetIntegrationId?: string | null;
  body?: string;
  description?: string;
  historyLimit?: number | null;
  kbCollectionIds?: string[];
  maxToolSteps?: number | null;
  mcpTools?: WfMcpToolSelectionInput[];
  model?: string;
  name?: string;
  provider?: string;
  showReasoning?: boolean;
  showToolTrace?: boolean;
  slug: string;
  tools?: WfAgentToolInput[];
};

interface AgentToolConfigPersisted {
  actionId: string;
  enabled: boolean;
  integrationId?: string;
  requireApproval?: boolean;
  triggerKeywords?: string[];
  override?: WfAgentToolOverrideInput;
}

interface McpToolSelectionPersisted {
  approvalToolNames?: string[];
  integrationId: string;
  overrides?: Record<string, WfMcpToolOverrideInput>;
  toolNames: string[];
}

interface AgentRowRaw {
  slug: string;
  name: string;
  description: string | null;
  provider: string | null;
  model: string | null;
  body: string | null;
  history_limit: number | null;
  max_tool_steps: number | null;
  show_tool_trace: boolean | null;
  show_reasoning: boolean | null;
  tools: unknown;
  kb_collection_ids: unknown;
  mcp_tools: unknown;
  approval_target_integration_id: string | null;
  approval_target_chat_id: string | null;
  updated_at: Date | string;
}

function sanitizeTools(
  tools: WfAgentToolInput[] | undefined
): AgentToolConfigPersisted[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const out: AgentToolConfigPersisted[] = [];
  for (const t of tools) {
    if (!t || typeof t.actionId !== "string" || !t.actionId) {
      continue;
    }
    if (t.actionId.startsWith("mcp:")) {
      continue;
    }
    const cfg: AgentToolConfigPersisted = {
      actionId: t.actionId,
      enabled: t.enabled !== false,
    };
    if (t.integrationId) {
      cfg.integrationId = t.integrationId;
    }
    if (t.requireApproval === true) {
      cfg.requireApproval = true;
    }
    if (Array.isArray(t.triggerKeywords)) {
      const kws = t.triggerKeywords
        .filter((k): k is string => typeof k === "string")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      if (kws.length > 0) {
        cfg.triggerKeywords = kws;
      }
    }
    if (t.override && typeof t.override === "object") {
      cfg.override = t.override;
    }
    out.push(cfg);
  }
  return out;
}

function sanitizeMcpSelections(
  selections: WfMcpToolSelectionInput[] | undefined
): McpToolSelectionPersisted[] {
  if (!Array.isArray(selections)) {
    return [];
  }
  const out: McpToolSelectionPersisted[] = [];
  const seenIntegrations = new Set<string>();
  for (const s of selections) {
    if (
      !s ||
      typeof s.integrationId !== "string" ||
      !s.integrationId ||
      seenIntegrations.has(s.integrationId)
    ) {
      continue;
    }
    seenIntegrations.add(s.integrationId);
    const rawNames = Array.isArray(s.toolNames) ? s.toolNames : [];
    const dedupedNames: string[] = [];
    const nameSet = new Set<string>();
    for (const name of rawNames) {
      if (typeof name === "string" && name && !nameSet.has(name)) {
        nameSet.add(name);
        dedupedNames.push(name);
      }
    }
    const sel: McpToolSelectionPersisted = {
      integrationId: s.integrationId,
      toolNames: dedupedNames,
    };
    if (Array.isArray(s.approvalToolNames)) {
      const allowed = new Set(dedupedNames);
      const dedupedApproval: string[] = [];
      const approvalSet = new Set<string>();
      for (const name of s.approvalToolNames) {
        if (
          typeof name === "string" &&
          allowed.has(name) &&
          !approvalSet.has(name)
        ) {
          approvalSet.add(name);
          dedupedApproval.push(name);
        }
      }
      if (dedupedApproval.length > 0) {
        sel.approvalToolNames = dedupedApproval;
      }
    }
    if (s.overrides && typeof s.overrides === "object") {
      sel.overrides = s.overrides;
    }
    out.push(sel);
  }
  return out;
}

function sanitizeKbCollectionIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function mergeNullable<T>(
  next: T | null | undefined,
  existing: T | null
): T | null {
  if (next === undefined) {
    return existing;
  }
  return next;
}

export async function wfUpdateAgentStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as WfUpdateAgentInput;
  try {
    const slug = input.slug?.trim();
    if (!slug) {
      return {
        success: false,
        error: { message: "slug is required" },
      };
    }
    const rows = await api.db.read<AgentRowRaw>(
      `SELECT slug, name, description, provider, model, body,
              history_limit, max_tool_steps, show_tool_trace, show_reasoning,
              tools, kb_collection_ids, mcp_tools,
              approval_target_integration_id, approval_target_chat_id, updated_at
         FROM agents WHERE slug = $1 LIMIT 1`,
      [slug]
    );
    const existing = rows[0];
    if (!existing) {
      return {
        success: false,
        error: { message: `Agent "${slug}" not found` },
      };
    }

    const name = input.name?.trim() || existing.name;
    const description =
      input.description === undefined ? existing.description : input.description;
    const provider =
      input.provider === undefined ? existing.provider : input.provider;
    const model = input.model === undefined ? existing.model : input.model;
    const body = input.body === undefined ? (existing.body ?? "") : input.body;
    const historyLimit = mergeNullable(input.historyLimit, existing.history_limit);
    const maxToolSteps = mergeNullable(input.maxToolSteps, existing.max_tool_steps);
    const showToolTrace =
      input.showToolTrace === undefined
        ? existing.show_tool_trace === true
        : input.showToolTrace === true;
    const showReasoning =
      input.showReasoning === undefined
        ? existing.show_reasoning === true
        : input.showReasoning === true;
    const approvalTargetIntegrationId = mergeNullable(
      input.approvalTargetIntegrationId,
      existing.approval_target_integration_id
    );
    const approvalTargetChatId = mergeNullable(
      input.approvalTargetChatId,
      existing.approval_target_chat_id
    );

    // Tools / mcpTools / kbCollectionIds: provided arrays REPLACE the row's
    // current value; absent fields preserve the existing row state. The
    // upstream helpers performed each as a separate UPDATE; we fold them all
    // into one statement here.
    const tools = Array.isArray(input.tools)
      ? sanitizeTools(input.tools)
      : Array.isArray(existing.tools)
        ? (existing.tools as AgentToolConfigPersisted[])
        : [];
    const mcpTools = Array.isArray(input.mcpTools)
      ? sanitizeMcpSelections(input.mcpTools)
      : Array.isArray(existing.mcp_tools)
        ? (existing.mcp_tools as McpToolSelectionPersisted[])
        : [];
    const kbCollectionIds = Array.isArray(input.kbCollectionIds)
      ? sanitizeKbCollectionIds(input.kbCollectionIds)
      : Array.isArray(existing.kb_collection_ids)
        ? (existing.kb_collection_ids as string[])
        : [];

    await api.db.write(
      `UPDATE agents SET
         name = $2,
         description = $3,
         provider = $4,
         model = $5,
         body = $6,
         history_limit = $7,
         max_tool_steps = $8,
         show_tool_trace = $9,
         show_reasoning = $10,
         tools = $11::jsonb,
         kb_collection_ids = $12::jsonb,
         mcp_tools = $13::jsonb,
         approval_target_integration_id = $14,
         approval_target_chat_id = $15,
         updated_at = NOW()
       WHERE slug = $1`,
      [
        slug,
        name,
        description,
        provider,
        model,
        body,
        historyLimit,
        maxToolSteps,
        showToolTrace,
        showReasoning,
        JSON.stringify(tools),
        JSON.stringify(kbCollectionIds),
        JSON.stringify(mcpTools),
        approvalTargetIntegrationId,
        approvalTargetChatId,
      ]
    );

    const refreshed = await api.db.read<{ updated_at: Date | string }>(
      "SELECT updated_at FROM agents WHERE slug = $1 LIMIT 1",
      [slug]
    );
    const updatedAt = refreshed[0]?.updated_at
      ? refreshed[0].updated_at instanceof Date
        ? refreshed[0].updated_at.toISOString()
        : String(refreshed[0].updated_at)
      : new Date().toISOString();

    const mcpToolCount = mcpTools.reduce(
      (sum, sel) => sum + sel.toolNames.length,
      0
    );
    return {
      success: true,
      data: {
        slug,
        name,
        description: description ?? undefined,
        provider: provider ?? undefined,
        model: model ?? undefined,
        toolCount: tools.length,
        mcpToolCount,
        kbCollectionCount: kbCollectionIds.length,
        updatedAt,
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
