// wfCreateAgentStep — registry port of plugins/workflow-builder/steps/create-agent.
//
// v1.1.0 — wired to the Phase 4e.5 batch-1 `api.agents.create` host surface.
// Scalar columns (slug, name, provider, model, body, etc.) go through the host
// wrapper which is publisher-gated and handles agent-cache invalidation.
// JSONB sub-columns (tools, mcp_tools, kb_collection_ids) are written via a
// separate `api.db.write({ schema: "public" })` call because the host has no
// dedicated surface for them yet (scheduled for a later phase).
//
// Local guards retained: slug regex and the `default` protected-slug check
// remain client-side for cleaner error messages than AgentSpecInvalidError.

import type {
  AgentCreateSpec,
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

    // Pre-check for duplicates — gives a clean error message instead of
    // surfacing the raw Postgres unique-constraint text from api.agents.create.
    const existing = await api.db.read<{ slug: string }>(
      "SELECT slug FROM agents WHERE slug = $1 LIMIT 1",
      [slug],
      { schema: "public" }
    );
    if (existing.length > 0) {
      return {
        success: false,
        error: { message: `Agent "${slug}" already exists` },
      };
    }

    const spec: AgentCreateSpec = {
      slug,
      name,
      description: input.description,
      provider: input.provider,
      model: input.model,
      body: input.body ?? "",
      historyLimit:
        typeof input.historyLimit === "number" ? input.historyLimit : null,
      maxToolSteps:
        typeof input.maxToolSteps === "number" ? input.maxToolSteps : null,
      showToolTrace: input.showToolTrace === true,
      showReasoning: input.showReasoning === true,
      approvalTargetIntegrationId:
        input.approvalTargetIntegrationId?.trim() || null,
      approvalTargetChatId: input.approvalTargetChatId?.trim() || null,
    };

    const agent = await api.agents.create(spec);

    // JSONB sub-columns (tools / mcpTools / kbCollectionIds) go through a
    // separate UPDATE because api.agents.create is scalar-only in 4e.5 batch 1.
    const tools = sanitizeTools(input.tools);
    const mcpTools = sanitizeMcpSelections(input.mcpTools);
    const kbCollectionIds = sanitizeKbCollectionIds(input.kbCollectionIds);

    if (tools.length > 0 || mcpTools.length > 0 || kbCollectionIds.length > 0) {
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
        name,
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
