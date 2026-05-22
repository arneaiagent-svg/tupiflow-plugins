// wfCreateAgentStep — registry port of plugins/workflow-builder/steps/create-agent.
//
// Original implementation called the host's `agents.ts` helpers (saveAgent,
// saveAgentTools, saveAgentMcpTools, saveAgentKbCollections) which internally
// invoked Drizzle against the cross-cutting `agents` table and warmed
// process-local caches. The registry port reimplements the same writes via
// `api.db.write` (cross-cutting writes allowed for publisher="tupiflow" per
// the Phase 4e.3 gate). The host's agent cache is NOT invalidated here — the
// host owns cache lifecycle and only invalidates on its own writes; that gap
// is acceptable in v0 because every agent read goes through the same
// `api.db.read` surface that respects table-level transaction isolation.

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

export type WfCreateAgentInput = {
  approvalTargetChatId?: string;
  approvalTargetIntegrationId?: string;
  body?: string;
  description?: string;
  historyLimit?: number;
  kbCollectionIds?: string[];
  maxToolSteps?: number;
  mcpTools?: WfMcpToolSelectionInput[];
  model?: string;
  name: string;
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

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

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
    // MCP tools live in the dedicated mcpTools column. Drop any mcp-prefixed
    // entries that leak in from older saves.
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

function sanitizeKbCollectionIds(ids: string[] | undefined): string[] {
  if (!Array.isArray(ids)) {
    return [];
  }
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

export async function wfCreateAgentStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as WfCreateAgentInput;
  try {
    const slug = input.slug?.trim();
    const name = input.name?.trim();
    if (!(slug && name)) {
      return {
        success: false,
        error: { message: "slug and name are required" },
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

    const existing = await api.db.read<{ slug: string }>(
      "SELECT slug FROM agents WHERE slug = $1 LIMIT 1",
      [slug]
    );
    if (existing.length > 0) {
      return {
        success: false,
        error: { message: `Agent "${slug}" already exists` },
      };
    }

    const tools = sanitizeTools(input.tools);
    const mcpTools = sanitizeMcpSelections(input.mcpTools);
    const kbCollectionIds = sanitizeKbCollectionIds(input.kbCollectionIds);

    const description = input.description ?? null;
    const provider = input.provider ?? null;
    const model = input.model ?? null;
    const body = input.body ?? "";
    const historyLimit =
      typeof input.historyLimit === "number" ? input.historyLimit : null;
    const maxToolSteps =
      typeof input.maxToolSteps === "number" ? input.maxToolSteps : null;
    const showToolTrace = input.showToolTrace === true;
    const showReasoning = input.showReasoning === true;
    const approvalTargetIntegrationId =
      input.approvalTargetIntegrationId?.trim() || null;
    const approvalTargetChatId = input.approvalTargetChatId?.trim() || null;

    await api.db.write(
      `INSERT INTO agents (
         slug, name, description, provider, model, body,
         history_limit, max_tool_steps, show_tool_trace, show_reasoning,
         tools, kb_collection_ids, mcp_tools,
         approval_target_integration_id, approval_target_chat_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11::jsonb, $12::jsonb, $13::jsonb,
         $14, $15,
         NOW(), NOW()
       )`,
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

    const rows = await api.db.read<{
      slug: string;
      name: string;
      description: string | null;
      provider: string | null;
      model: string | null;
      updated_at: Date;
    }>(
      "SELECT slug, name, description, provider, model, updated_at FROM agents WHERE slug = $1 LIMIT 1",
      [slug]
    );
    const row = rows[0];
    const updatedAt = row
      ? row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at)
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
