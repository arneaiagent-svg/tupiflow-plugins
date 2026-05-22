// Build script for workflow-builder. Delegates to @tupiflow-plugins/shared's
// buildPlugin helper. The actions set is supplied here because the helper
// does not yet sandbox-introspect the bundle (see TODO in build-helpers.ts).
//
// 22 actions ported from plugins/workflow-builder/ in the tupiflow monorepo.
// Action metadata (slug/label/description/category/stepFunction/outputFields/
// configFields/tool) mirrors plugins/workflow-builder/actions/*.ts; tool
// inputSchemas are hand-translated from Zod to JSON Schema 2020-12 so the
// bundle is dependency-free.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlugin } from "@tupiflow-plugins/shared/build-helpers";

const root = dirname(fileURLToPath(import.meta.url));

const AGENT_TOOL_OVERRIDE_SCHEMA = {
  type: "object",
  description: "Per-tool overrides shadowing plugin defaults at runtime.",
  properties: {
    name: { type: "string", description: "Custom tool name." },
    description: { type: "string", description: "Custom description." },
    inputSchemaJson: { type: "string", description: "Custom JSON Schema (stringified)." },
  },
  additionalProperties: false,
};

const AGENT_TOOL_SCHEMA = {
  type: "object",
  properties: {
    actionId: { type: "string", description: "Full actionId (e.g. 'workflow-builder/list-actions')." },
    enabled: { type: "boolean", description: "Defaults to true." },
    integrationId: { type: "string", description: "Pin tool to a specific integration row." },
    requireApproval: { type: "boolean", description: "Pause for human approval each call." },
    triggerKeywords: {
      type: "array",
      items: { type: "string" },
      description: "Inbound-chat keywords that auto-invoke this tool.",
    },
    override: AGENT_TOOL_OVERRIDE_SCHEMA,
  },
  required: ["actionId"],
  additionalProperties: false,
};

const MCP_TOOL_SELECTION_SCHEMA = {
  type: "object",
  properties: {
    integrationId: { type: "string", description: "Id of an MCP-type integration row." },
    toolNames: {
      type: "array",
      items: { type: "string" },
      description: "Raw tool names the agent is allowed to invoke.",
    },
    approvalToolNames: {
      type: "array",
      items: { type: "string" },
      description: "Subset of toolNames that pause for human approval.",
    },
    overrides: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          description: { type: "string" },
          inputSchemaJson: { type: "string" },
        },
        additionalProperties: false,
      },
      description: "Per-tool overrides keyed by raw tool name.",
    },
  },
  required: ["integrationId", "toolNames"],
  additionalProperties: false,
};

const actions = [
  // workflow-actions.ts
  {
    slug: "create-workflow",
    label: "Create Workflow",
    description:
      "Generate a new workflow in this app from a natural-language description.",
    category: "Workflow Builder",
    stepFunction: "wfCreateWorkflowStep",
    configFields: [
      {
        key: "workflowDescription",
        label: "Workflow description",
        type: "template-textarea",
        required: true,
      },
    ],
    outputFields: [
      { field: "id", description: "New workflow id" },
      { field: "name", description: "Workflow name" },
      { field: "description", description: "Workflow description" },
      { field: "url", description: "Path to open the workflow editor" },
    ],
    tool: {
      name: "create_workflow",
      description:
        "Create a new workflow in the app from a natural-language description. Use this when the user asks to build, generate, or create a workflow. The `workflowDescription` must be complete and self-contained: capture the trigger, actions, integrations, and conditions discussed in the conversation.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          workflowDescription: {
            type: "string",
            minLength: 1,
            description:
              "A full description of the workflow to generate, incorporating any relevant details from the conversation so it stands on its own.",
          },
        },
        required: ["workflowDescription"],
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "list-workflows",
    label: "List Workflows",
    description: "List all workflows owned by the calling user.",
    category: "Workflow Builder",
    stepFunction: "wfListWorkflowsStep",
    configFields: [
      { key: "search", label: "Search", type: "template-input" },
    ],
    outputFields: [
      { field: "workflows", description: "Array of workflow summaries" },
      { field: "count", description: "Number of workflows" },
    ],
    tool: {
      name: "list_workflows",
      description:
        "List workflows owned by the current user. Each entry includes a `trigger` summary with `type` (Manual | Schedule | Webhook | Chat Message), `acceptsInput` (true for Manual and Webhook), and optional `inputSchema` describing the fields execute_workflow can pass.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Optional case-insensitive substring on workflow name.",
          },
        },
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "get-workflow",
    label: "Get Workflow",
    description:
      "Return full workflow data (nodes, edges, structure) by workflowId.",
    category: "Workflow Builder",
    stepFunction: "wfGetWorkflowStep",
    configFields: [
      {
        key: "workflowId",
        label: "Workflow ID",
        type: "template-input",
        required: true,
      },
    ],
    outputFields: [
      { field: "id", description: "Workflow id" },
      { field: "name", description: "Workflow name" },
      { field: "description", description: "Workflow description" },
      { field: "visibility", description: "private | public" },
      { field: "isSystem", description: "System workflow flag" },
      { field: "nodeCount", description: "Number of nodes" },
      { field: "edgeCount", description: "Number of edges" },
      { field: "nodes", description: "Array of React Flow nodes" },
      { field: "edges", description: "Array of React Flow edges" },
      {
        field: "trigger",
        description:
          "Trigger summary { type, acceptsInput, inputSchema? } describing how this workflow can be triggered.",
      },
      { field: "createdAt", description: "ISO timestamp" },
      { field: "updatedAt", description: "ISO timestamp" },
    ],
    tool: {
      name: "get_workflow",
      description:
        "Fetch a single workflow by id with full structure: nodes (with action config), edges, name, description, visibility, timestamps, and a `trigger` summary. The trigger summary reports `type`, `acceptsInput` (Manual/Webhook), and optional `inputSchema` listing the fields execute_workflow can pass.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          workflowId: { type: "string", description: "Workflow id to fetch." },
        },
        required: ["workflowId"],
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "execute-workflow",
    label: "Execute Workflow",
    description:
      "Trigger a workflow execution with an optional input payload. Returns immediately with the executionId.",
    category: "Workflow Builder",
    stepFunction: "wfExecuteWorkflowStep",
    configFields: [
      {
        key: "workflowId",
        label: "Workflow ID",
        type: "template-input",
        required: true,
      },
      { key: "input", label: "Trigger input (JSON)", type: "template-textarea" },
    ],
    outputFields: [
      { field: "executionId", description: "Execution row id" },
      { field: "workflowId", description: "Workflow id executed" },
      { field: "status", description: "Always 'running' on success" },
    ],
    tool: {
      name: "execute_workflow",
      description:
        "Execute a workflow by id with an optional input payload. Only workflows with Manual or Webhook triggers accept input; for Schedule or Chat Message triggers, omit `input`. If unsure what fields the workflow expects, call get_workflow first and read `trigger.inputSchema`. Fire-and-forget: returns the executionId immediately. Poll get_workflow_executions to inspect results.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          workflowId: { type: "string", description: "Workflow id to execute." },
          input: {
            type: "object",
            additionalProperties: true,
            description:
              "Trigger input. Each top-level key becomes available downstream as {{Trigger.<key>}}. Match the keys to the workflow's trigger.inputSchema.",
          },
        },
        required: ["workflowId"],
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "get-workflow-executions",
    label: "Get Workflow Executions",
    description: "Return recent executions for a workflow plus per-node logs.",
    category: "Workflow Builder",
    stepFunction: "wfGetWorkflowExecutionsStep",
    configFields: [
      {
        key: "workflowId",
        label: "Workflow ID",
        type: "template-input",
        required: true,
      },
      { key: "limit", label: "Limit", type: "number" },
    ],
    outputFields: [
      { field: "executions", description: "Array of executions with logs" },
      { field: "count", description: "Number of executions returned" },
    ],
    tool: {
      name: "get_workflow_executions",
      description:
        "Fetch recent executions for a workflow (by workflowId) with status, input/output, error, and per-node execution logs.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          workflowId: { type: "string", description: "Workflow id to inspect." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Max executions to return (1-50, default 10).",
          },
        },
        required: ["workflowId"],
        additionalProperties: false,
      }),
    },
  },

  // agent-actions.ts
  {
    slug: "list-agents",
    label: "List Agents",
    description: "List all agents defined on this host.",
    category: "Workflow Builder",
    stepFunction: "wfListAgentsStep",
    configFields: [],
    outputFields: [
      { field: "agents", description: "Array of agents (slug, name, ...)" },
      { field: "count", description: "Number of agents" },
    ],
    tool: {
      name: "list_agents",
      description:
        "List every agent (system prompt file under /agents). Returns slug, name, description, provider, model.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "create-agent",
    label: "Create Agent",
    description:
      "Create a new agent with system prompt, provider/model, and optional tools, MCP whitelist, KB collections, and run-time settings.",
    category: "Workflow Builder",
    stepFunction: "wfCreateAgentStep",
    configFields: [
      { key: "slug", label: "Slug", type: "template-input", required: true },
      { key: "name", label: "Name", type: "template-input", required: true },
      { key: "description", label: "Description", type: "template-textarea" },
      { key: "provider", label: "Provider", type: "text" },
      { key: "model", label: "Model", type: "text" },
      { key: "body", label: "System prompt", type: "template-textarea" },
      { key: "historyLimit", label: "History limit", type: "number" },
      { key: "maxToolSteps", label: "Max tool steps", type: "number" },
    ],
    outputFields: [
      { field: "slug", description: "Agent slug" },
      { field: "name", description: "Agent name" },
      { field: "toolCount", description: "Number of built-in tools attached" },
      { field: "mcpToolCount", description: "Total raw MCP tool names whitelisted across selections" },
      { field: "kbCollectionCount", description: "Number of KB collections attached" },
      { field: "updatedAt", description: "ISO timestamp" },
    ],
    tool: {
      name: "create_agent",
      description:
        "Create a new agent. Slug must be unique (lowercase letters, digits, hyphens; must start alphanumeric). Use list_tools first to discover valid `tools[].actionId` values. `tools` are built-in actions (full actionId, e.g. 'workflow-builder/list-actions'). `mcpTools` whitelists raw tool names per MCP integration; use list_integrations to find MCP integration ids and list_tools on them to discover names. `kbCollectionIds` grants kb_search/kb_get_document/kb_get_page access to those collections. `approvalTargetIntegrationId` + `approvalTargetChatId` redirect human-approval requests to a private chat instead of the conversation that triggered the run.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          slug: { type: "string", description: "Unique kebab-case slug for the agent." },
          name: { type: "string", description: "Human-readable name." },
          description: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          body: { type: "string" },
          historyLimit: { type: "integer", minimum: 1 },
          maxToolSteps: { type: "integer", minimum: 1 },
          showToolTrace: { type: "boolean" },
          showReasoning: { type: "boolean" },
          approvalTargetIntegrationId: { type: "string" },
          approvalTargetChatId: { type: "string" },
          tools: { type: "array", items: AGENT_TOOL_SCHEMA },
          mcpTools: { type: "array", items: MCP_TOOL_SELECTION_SCHEMA },
          kbCollectionIds: { type: "array", items: { type: "string" } },
        },
        required: ["slug", "name"],
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "update-agent",
    label: "Update Agent",
    description:
      "Update an existing agent's metadata, system prompt, tools, MCP whitelist, KB collections, or run-time settings.",
    category: "Workflow Builder",
    stepFunction: "wfUpdateAgentStep",
    configFields: [
      { key: "slug", label: "Slug", type: "template-input", required: true },
      { key: "name", label: "Name", type: "template-input" },
      { key: "description", label: "Description", type: "template-textarea" },
      { key: "provider", label: "Provider", type: "text" },
      { key: "model", label: "Model", type: "text" },
      { key: "body", label: "System prompt", type: "template-textarea" },
      { key: "historyLimit", label: "History limit", type: "number" },
      { key: "maxToolSteps", label: "Max tool steps", type: "number" },
    ],
    outputFields: [
      { field: "slug", description: "Agent slug" },
      { field: "name", description: "Agent name" },
      { field: "toolCount", description: "Number of built-in tools attached" },
      { field: "mcpToolCount", description: "Total raw MCP tool names whitelisted across selections" },
      { field: "kbCollectionCount", description: "Number of KB collections attached" },
      { field: "updatedAt", description: "ISO timestamp" },
    ],
    tool: {
      name: "update_agent",
      description:
        "Update an existing agent. Only fields you pass are changed; omitted fields are retained. List-shaped fields REPLACE on update — passing `tools`, `mcpTools`, or `kbCollectionIds` overwrites the current list, so include any entries you want to keep. Pass `[]` to clear a list. For nullable scalars (`historyLimit`, `maxToolSteps`, `approvalTargetIntegrationId`, `approvalTargetChatId`), pass `null` to clear, omit to leave unchanged.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          slug: { type: "string", description: "Existing agent slug." },
          name: { type: "string" },
          description: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          body: { type: "string" },
          historyLimit: { type: ["integer", "null"], minimum: 1 },
          maxToolSteps: { type: ["integer", "null"], minimum: 1 },
          showToolTrace: { type: "boolean" },
          showReasoning: { type: "boolean" },
          approvalTargetIntegrationId: { type: ["string", "null"] },
          approvalTargetChatId: { type: ["string", "null"] },
          tools: { type: "array", items: AGENT_TOOL_SCHEMA },
          mcpTools: { type: "array", items: MCP_TOOL_SELECTION_SCHEMA },
          kbCollectionIds: { type: "array", items: { type: "string" } },
        },
        required: ["slug"],
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "delete-agent",
    label: "Delete Agent",
    description:
      "Delete an agent by slug. The 'default' agent is protected and cannot be deleted.",
    category: "Workflow Builder",
    stepFunction: "wfDeleteAgentStep",
    configFields: [
      { key: "slug", label: "Slug", type: "template-input", required: true },
    ],
    outputFields: [
      { field: "slug", description: "Slug deleted" },
      { field: "deleted", description: "Always true on success" },
    ],
    tool: {
      name: "delete_agent",
      description:
        "Delete an agent by slug. The 'default' agent is protected and the call will fail if you target it.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: { slug: { type: "string", description: "Agent slug to delete." } },
        required: ["slug"],
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "launch-agent",
    label: "Launch Agent",
    description:
      "Invoke an agent (subagent call) with a prompt and optional multimodal attachments.",
    category: "Workflow Builder",
    stepFunction: "wfLaunchAgentStep",
    configFields: [
      { key: "agentSlug", label: "Agent slug", type: "text" },
      { key: "userPrompt", label: "Prompt", type: "template-textarea", required: true },
      { key: "imageUrls", label: "Image URLs", type: "template-textarea" },
      { key: "fileUrls", label: "File URLs", type: "template-textarea" },
      { key: "audioUrls", label: "Audio URLs", type: "template-textarea" },
      { key: "videoUrls", label: "Video URLs", type: "template-textarea" },
    ],
    outputFields: [
      { field: "text", description: "Assistant response text" },
      { field: "model", description: "Model id used" },
      { field: "provider", description: "Provider id used" },
      { field: "agentSlug", description: "Agent slug used" },
    ],
    tool: {
      name: "launch_agent",
      description:
        "Run a subagent (multimodal) by slug with a prompt. Pass imageUrls/fileUrls/audioUrls/videoUrls as arrays of https or data URLs. Returns the assistant text plus the resolved provider/model/agentSlug.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          agentSlug: { type: "string", description: "Agent slug to launch (defaults to 'default')." },
          userPrompt: { type: "string", description: "Message to send to the subagent." },
          systemPromptOverride: { type: "string" },
          providerOverride: { type: "string" },
          modelOverride: { type: "string" },
          imageUrls: { type: "array", items: { type: "string" } },
          fileUrls: { type: "array", items: { type: "string" } },
          audioUrls: { type: "array", items: { type: "string" } },
          videoUrls: { type: "array", items: { type: "string" } },
        },
        required: ["userPrompt"],
        additionalProperties: false,
      }),
    },
  },

  // discovery-actions.ts
  {
    slug: "list-actions",
    label: "List Actions",
    description:
      "List every action available in the workflow registry (plugin + system).",
    category: "Workflow Builder",
    stepFunction: "wfListActionsStep",
    configFields: [{ key: "category", label: "Category filter", type: "text" }],
    outputFields: [
      { field: "actions", description: "Array of actions" },
      { field: "count", description: "Number of actions" },
    ],
    tool: {
      name: "list_actions",
      description:
        "List all workflow actions (plugin + system) the AI agent workflow creator can add to a graph. Each entry includes actionId, label, category, integration, and config field keys.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          category: { type: "string", description: "Case-insensitive category filter (e.g. GitHub, AI)." },
        },
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "list-integrations",
    label: "List Integrations",
    description:
      "List integrations the user has configured, with their available actions.",
    category: "Workflow Builder",
    stepFunction: "wfListIntegrationsStep",
    configFields: [{ key: "type", label: "Type filter", type: "text" }],
    outputFields: [
      { field: "integrations", description: "Array of integrations with action lists" },
      { field: "count", description: "Number of integrations" },
    ],
    tool: {
      name: "list_integrations",
      description:
        "List the calling user's configured integrations. Each entry includes integrationId, name, type, label, isManaged, and the actions exposed by that integration plugin (actionId, slug, label, category, isTool). Use this to know which actions the agent can wire into a workflow for the current user's connected services.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          type: { type: "string", description: "Optional case-insensitive exact match on type." },
        },
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "list-connections",
    label: "List Connections",
    description:
      "List available chat-style connections (Telegram, WhatsApp, etc.) for the calling user.",
    category: "Workflow Builder",
    stepFunction: "wfListConnectionsStep",
    configFields: [],
    outputFields: [
      { field: "connections", description: "Array of connection integrations" },
      { field: "count", description: "Number of connections" },
    ],
    tool: {
      name: "list_connections",
      description:
        "List connection integrations (chat bots etc.) configured for the current user. Returns integrationId, type, label, and trigger metadata.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "list-tools",
    label: "List/Search Tools",
    description:
      "Search the AI Agent tool registry. Two modes: lean discovery (slim=true, paginated, no schemas) and full lookup (default, returns inputSchema for each match).",
    category: "Workflow Builder",
    stepFunction: "wfListToolsStep",
    configFields: [
      { key: "query", label: "Search query", type: "template-input" },
      { key: "category", label: "Category filter (exact, case-insensitive)", type: "template-input" },
      { key: "integration", label: "Integration filter (exact, case-insensitive)", type: "template-input" },
      { key: "slim", label: "Slim mode (omit inputSchema)", type: "select" },
      { key: "limit", label: "Limit", type: "number" },
      { key: "offset", label: "Offset", type: "number" },
    ],
    outputFields: [
      { field: "tools", description: "Page of tool entries" },
      { field: "count", description: "Number of rows in this page" },
      { field: "total", description: "Total matches after filtering" },
      { field: "offset", description: "Echoed offset" },
      { field: "limit", description: "Echoed limit (null when unpaged)" },
      { field: "hasMore", description: "True when more pages remain" },
    ],
    tool: {
      name: "list_tools",
      description:
        "Search the AI Agent tool registry. Use slim=true for cheap discovery (omits inputSchema; pair with limit to page through results). Use slim=false (default) when you've narrowed to the tool you want and need its full inputSchema. Matches on name/description/actionId/category/integration.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          query: { type: "string" },
          category: { type: "string" },
          integration: { type: "string" },
          slim: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          offset: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "fetch",
    label: "HTTP Fetch",
    description:
      "Make an HTTP request to a URL and return the parsed response. Generic fetch tool for agents.",
    category: "Workflow Builder",
    stepFunction: "wfFetchStep",
    configFields: [
      { key: "url", label: "URL", type: "template-input", required: true },
      { key: "method", label: "Method", type: "text" },
      { key: "headers", label: "Headers (JSON object)", type: "template-textarea" },
      { key: "query", label: "Query params (JSON object)", type: "template-textarea" },
      { key: "body", label: "Body (string or JSON)", type: "template-textarea" },
      { key: "responseType", label: "Response type", type: "text" },
      { key: "timeoutMs", label: "Timeout (ms)", type: "number" },
      { key: "disableBrowserHeaders", label: "Disable browser headers", type: "select" },
    ],
    outputFields: [
      { field: "status", description: "HTTP status code" },
      { field: "statusText", description: "HTTP status text" },
      { field: "ok", description: "True when status is 2xx" },
      { field: "headers", description: "Response headers" },
      { field: "body", description: "Parsed JSON or raw text" },
      { field: "contentType", description: "Response content-type" },
      { field: "url", description: "Final URL after redirects" },
    ],
    tool: {
      name: "fetch",
      description:
        "Make an HTTP request to any URL. By default sends real Mac Chrome browser headers (User-Agent, Accept, sec-ch-ua, Sec-Fetch-*, etc.) so requests look like a normal browser and avoid generic bot checks. Auto-parses JSON responses. Body can be a string (sent as-is) or an object (JSON-encoded with Content-Type: application/json). Set disableBrowserHeaders=true for raw API calls where the spoofed headers would interfere.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          url: { type: "string", format: "uri", description: "Absolute URL to fetch." },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
          },
          headers: { type: "object", additionalProperties: { type: "string" } },
          query: { type: "object", additionalProperties: { type: "string" } },
          body: {
            description: "Request body (string or object). Ignored for GET/HEAD.",
          },
          responseType: { type: "string", enum: ["auto", "json", "text"] },
          timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
          disableBrowserHeaders: { type: "boolean" },
        },
        required: ["url"],
        additionalProperties: false,
      }),
    },
  },
  // Phase 4f batch 1 — compute-hash: worker contract proof.
  {
    slug: "compute-hash",
    label: "Compute Hash (SHA-256)",
    description:
      "Compute the SHA-256 hex digest of a string in an isolated worker thread. Demonstrates the api.runTask worker contract (pure compute, no network).",
    category: "Workflow Builder",
    stepFunction: "wfComputeHashStep",
    configFields: [
      {
        key: "input",
        label: "Input string",
        type: "template-input",
        required: true,
      },
    ],
    outputFields: [
      { field: "hash", description: "SHA-256 hex digest of the input string" },
      { field: "algorithm", description: "Always 'sha256'" },
      { field: "inputLength", description: "Byte length of the input string" },
    ],
    tool: {
      name: "compute_hash",
      description:
        "Compute the SHA-256 hex digest of a string using an isolated worker thread. Use for deduplication keys, content fingerprinting, or deterministic identifiers. Returns hex string (64 chars).",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          input: {
            type: "string",
            minLength: 0,
            description: "String to hash. Empty string is valid; returns the sha256 of empty.",
          },
        },
        required: ["input"],
        additionalProperties: false,
      }),
    },
  },

  // fetch-article disabled v1: depends on jsdom + @mozilla/readability + turndown.
  // Registry has no requiredNpmDeps manifest field; bundling them blows past
  // the 10 MB bundle cap. Re-enable once either the registry adds dep declaration
  // OR a small jsdom-free implementation lands. Step impl stays in
  // src/steps/fetch-article.ts for now (not imported by src/index.ts).
  {
    slug: "fetch-models",
    label: "Fetch Models (AI Provider)",
    description:
      "List the chat or embedding models exposed by an AI provider integration (type prefix `agents_*`).",
    category: "Workflow Builder",
    stepFunction: "wfFetchModelsStep",
    configFields: [
      {
        key: "modelIntegrationId",
        label: "AI Provider Integration ID",
        type: "template-input",
        required: true,
      },
      { key: "modelType", label: "Model type", type: "select" },
    ],
    outputFields: [
      { field: "models", description: "Array of { id, label } model entries" },
      { field: "source", description: "'live' if fetched from the provider API, 'fallback' otherwise" },
      { field: "providerId", description: "Provider slug (e.g. ai-gateway, openai)" },
      { field: "integrationType", description: "Resolved integration type (agents_<providerId>)" },
      { field: "integrationId", description: "Echoes the input id" },
      { field: "modelType", description: "Echoes the requested model type" },
      { field: "warning", description: "Present when live fetch failed and the fallback list is returned" },
    ],
    tool: {
      name: "fetch_models",
      description:
        'List the models available on an AI provider integration. Pass an `integrationId` whose type begins with `agents_` (e.g. agents_ai-gateway, agents_openai, agents_anthropic) — obtain ids from list_integrations. Returns chat models by default; pass modelType="embeddings" for embedding models. `source` is "live" when fetched from the provider, "fallback" when the static built-in list was used (live fetch failed or no API key). Errors with a clear message if the integration is not an agents_* provider.',
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          modelIntegrationId: { type: "string", minLength: 1 },
          modelType: { type: "string", enum: ["chat", "embeddings"] },
        },
        required: ["modelIntegrationId"],
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "run-js",
    label: "Run JS",
    description:
      "Run a JS snippet in a sandboxed runtime (no network, no I/O, no library imports). Useful for data transformation, parsing, formatting, math, regex, filtering, aggregation.",
    category: "Workflow Builder",
    stepFunction: "wfRunJsStep",
    configFields: [
      { key: "code", label: "Code", type: "template-textarea", required: true },
      { key: "data", label: "Data (template or JSON)", type: "template-textarea" },
      { key: "timeoutMs", label: "Timeout (ms)", type: "number" },
    ],
    outputFields: [
      { field: "", description: "Whatever the snippet returns (must be JSON-serializable)." },
    ],
    tool: {
      name: "run_js",
      description:
        "Run a JS snippet in a sandboxed runtime. Use for data transformation, parsing (JSON, CSV, dates), formatting, math, regex, filtering, or aggregation that no other tool covers. The `data` input auto-resolves handle refs (`ref_xxx`), so this is the cheapest way to reshape large tool outputs before passing them on. Sandbox has NO network, NO I/O, NO library imports, and only `JSON` / `Math` / `Date` / `console.log` globals — do NOT use it to send email, write DB, call APIs, or replace a real action tool. Snippet must `return` a JSON-serializable value. Result wraps as a new handle if large, else returns inline.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          code: { type: "string", minLength: 1 },
          data: {},
          timeoutMs: { type: "integer", minimum: 1, maximum: 10000 },
        },
        required: ["code"],
        additionalProperties: false,
      }),
    },
  },
  {
    slug: "send-error-notification",
    label: "Send Error Notification",
    description:
      "Manually fire the configured error notification channels (webhook, ntfy, Telegram/WhatsApp connection).",
    category: "Workflow Builder",
    stepFunction: "wfSendErrorNotificationStep",
    configFields: [
      { key: "message", label: "Message", type: "template-textarea", required: true },
      { key: "workflowName", label: "Workflow name (optional)", type: "template-input" },
      { key: "workflowId", label: "Workflow id (optional)", type: "template-input" },
      { key: "executionId", label: "Execution id (optional)", type: "template-input" },
    ],
    outputFields: [
      {
        field: "dispatched",
        description:
          "True when at least one channel accepted the message. False with a `reason` when no channel is configured.",
      },
      { field: "reason", description: "Explanation when dispatched is false" },
    ],
    tool: {
      name: "send_error_notification",
      description:
        "Manually fire the configured workflow error notification channels (webhook, ntfy, Telegram/WhatsApp). Bypasses the per-workflow cooldown — use only when the user explicitly asked for a notification.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          message: { type: "string", minLength: 1 },
          workflowName: { type: "string" },
          workflowId: { type: "string" },
          executionId: { type: "string" },
        },
        required: ["message"],
        additionalProperties: false,
      }),
    },
  },

  // takeover-actions.ts
  {
    slug: "request-human-takeover",
    label: "Request Human Takeover",
    description:
      "Hand the conversation over to a human operator. Suppresses AI replies on this thread until the operator releases control from /chat-connections.",
    category: "Workflow Builder",
    stepFunction: "requestHumanTakeoverStep",
    configFields: [
      { key: "integrationId", label: "Connection Integration ID", type: "template-input" },
      { key: "threadId", label: "Thread ID", type: "template-input" },
      { key: "reason", label: "Reason", type: "template-textarea" },
      { key: "notifyMessage", label: "Notification message", type: "template-textarea" },
    ],
    outputFields: [
      { field: "humanControl", description: "Always true on success" },
      { field: "notified", description: "True if a notice was posted to the chat thread" },
      { field: "message", description: "Human-readable status string" },
    ],
    tool: {
      name: "request_human_takeover",
      description:
        "Hand this chat conversation over to a human operator. Call when you cannot help further (sensitive topic, escalation, refund decision, ambiguous request) or when the user explicitly asks for a human. After this returns, do NOT keep replying — the operator will take it from here. The thread's AI replies are suppressed until release.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Short operator-facing summary (1-3 sentences) of what the user wants and why a human is needed. Shown as a banner in /chat-connections so the operator can act without reading scrollback. Also posted verbatim to the user's chat when notifyMessage is empty — keep it neutral and respectful.",
          },
          notifyMessage: {
            type: "string",
            description: "Optional override for the notice posted to the chat user.",
          },
        },
        required: ["reason"],
        additionalProperties: false,
      }),
    },
  },

];

await buildPlugin({
  root,
  srcEntry: "src/index.ts",
  distDir: resolve(root, "dist"),
  actions,
  // Phase 4f batch 1 — compute-hash worker: sha256 of a string.
  // Contract proof: pure compute, no blessed-module imports, no requiredNpmDeps.
  // memLimitMb + timeoutMs are intentionally minimal for a hash-only worker.
  workers: [
    {
      id: "compute-hash",
      entry: "src/workers/compute-hash.mjs",
      memLimitMb: 64,
      timeoutMs: 5000,
    },
  ],
});
