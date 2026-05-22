// wfUpdateAgentStep — registry port of plugins/workflow-builder/steps/update-agent.
//
// v1.1.0 — wired to the Phase 4e.5 batch-1 `api.agents.update` host surface.
// Scalar columns go through the host wrapper (publisher-gated, cache-invalidated).
// JSONB sub-columns (tools / mcpTools / kbCollectionIds) still use
// `api.db.{read,write}({ schema: "public" })` because the host has no dedicated
// surface for them yet. The existing JSONB rows are read up-front to support the
// "undefined = leave unchanged, provided array = replace" merge semantics that
// the original step enforced, and to report accurate toolCount/mcpToolCount in
// the response regardless of whether the caller touched those fields.

import type {
  AgentListItem,
  AgentUpdatePatch,
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

interface JsonbRow {
  tools: unknown;
  mcp_tools: unknown;
  kb_collection_ids: unknown;
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

    // Read existing JSONB cols up-front for merge logic + consistent count
    // reporting in the response (api.agents.update returns AgentListItem which
    // omits JSONB sub-columns).
    const rows = await api.db.read<JsonbRow>(
      "SELECT tools, mcp_tools, kb_collection_ids FROM agents WHERE slug = $1 LIMIT 1",
      [slug],
      { schema: "public" }
    );
    if (rows.length === 0) {
      return {
        success: false,
        error: { message: `Agent "${slug}" not found` },
      };
    }
    const existingJsonb = rows[0];

    // Build scalar patch — only pass fields that are explicitly provided in
    // the input (undefined means "leave unchanged" at the host layer).
    const patch: AgentUpdatePatch = {};
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (trimmed) {
        patch.name = trimmed;
      }
    }
    if (input.description !== undefined) patch.description = input.description;
    if (input.provider !== undefined) patch.provider = input.provider;
    if (input.model !== undefined) patch.model = input.model;
    if (input.body !== undefined) patch.body = input.body;
    if (input.historyLimit !== undefined) patch.historyLimit = input.historyLimit;
    if (input.maxToolSteps !== undefined) patch.maxToolSteps = input.maxToolSteps;
    if (input.showToolTrace !== undefined)
      patch.showToolTrace = input.showToolTrace === true;
    if (input.showReasoning !== undefined)
      patch.showReasoning = input.showReasoning === true;
    if (input.approvalTargetIntegrationId !== undefined)
      patch.approvalTargetIntegrationId = input.approvalTargetIntegrationId;
    if (input.approvalTargetChatId !== undefined)
      patch.approvalTargetChatId = input.approvalTargetChatId;

    // Update scalars via the host surface (publisher-gated + cache invalidation).
    let agent: AgentListItem;
    try {
      agent = await api.agents.update(slug, patch);
    } catch (err) {
      if (err instanceof Error && err.name === "AgentNotFoundError") {
        return {
          success: false,
          error: { message: `Agent "${slug}" not found` },
        };
      }
      throw err;
    }

    // Merge JSONB cols: provided arrays replace; absent fields preserve
    // existing row state.
    const tools = Array.isArray(input.tools)
      ? sanitizeTools(input.tools)
      : Array.isArray(existingJsonb.tools)
        ? (existingJsonb.tools as AgentToolConfigPersisted[])
        : [];
    const mcpTools = Array.isArray(input.mcpTools)
      ? sanitizeMcpSelections(input.mcpTools)
      : Array.isArray(existingJsonb.mcp_tools)
        ? (existingJsonb.mcp_tools as McpToolSelectionPersisted[])
        : [];
    const kbCollectionIds = Array.isArray(input.kbCollectionIds)
      ? sanitizeKbCollectionIds(input.kbCollectionIds)
      : Array.isArray(existingJsonb.kb_collection_ids)
        ? (existingJsonb.kb_collection_ids as string[])
        : [];

    // Write JSONB cols only when at least one was provided in the input.
    if (
      input.tools !== undefined ||
      input.mcpTools !== undefined ||
      input.kbCollectionIds !== undefined
    ) {
      await api.db.write(
        `UPDATE agents
           SET tools              = $2::jsonb,
               mcp_tools         = $3::jsonb,
               kb_collection_ids = $4::jsonb,
               updated_at        = NOW()
         WHERE slug = $1`,
        [
          slug,
          JSON.stringify(tools),
          JSON.stringify(mcpTools),
          JSON.stringify(kbCollectionIds),
        ],
        { schema: "public" }
      );
    }

    const mcpToolCount = mcpTools.reduce(
      (sum, sel) => sum + sel.toolNames.length,
      0
    );
    return {
      success: true,
      data: {
        slug,
        name: agent.name,
        description: agent.description ?? undefined,
        provider: agent.provider ?? undefined,
        model: agent.model ?? undefined,
        toolCount: tools.length,
        mcpToolCount,
        kbCollectionCount: kbCollectionIds.length,
        updatedAt: agent.updatedAt,
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
