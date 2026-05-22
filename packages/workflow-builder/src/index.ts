// workflow-builder — registry-installable port of plugins/workflow-builder
// from the tupiflow first-party tree. Phase A: scaffold + integration spec +
// takeover target registration. Step registration lands in Phase B.
//
// Publisher: `tupiflow` (publisher-gated workflow.read methods rely on this).
// Capabilities exposed: takeover.register, workflow.read, workflow.write,
// db.read, db.write, llm.call, secrets.read, net.fetch.

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

const actions = [
  // workflow CRUD
  {
    slug: "create-workflow",
    label: "Create Workflow",
    description:
      "Generate a new workflow in this app from a natural-language description.",
    category: "Workflow Builder",
    stepFunction: "wfCreateWorkflowStep",
  },
  {
    slug: "list-workflows",
    label: "List Workflows",
    description: "List all workflows owned by the calling user.",
    category: "Workflow Builder",
    stepFunction: "wfListWorkflowsStep",
  },
  {
    slug: "get-workflow",
    label: "Get Workflow",
    description: "Return full workflow data (nodes, edges, structure) by workflowId.",
    category: "Workflow Builder",
    stepFunction: "wfGetWorkflowStep",
  },
  {
    slug: "execute-workflow",
    label: "Execute Workflow",
    description:
      "Trigger a workflow execution with an optional input payload. Returns immediately with the executionId.",
    category: "Workflow Builder",
    stepFunction: "wfExecuteWorkflowStep",
  },
  {
    slug: "get-workflow-executions",
    label: "Get Workflow Executions",
    description: "Return recent executions for a workflow plus per-node logs.",
    category: "Workflow Builder",
    stepFunction: "wfGetWorkflowExecutionsStep",
  },

  // agents
  {
    slug: "list-agents",
    label: "List Agents",
    description: "List all agents defined on this host.",
    category: "Workflow Builder",
    stepFunction: "wfListAgentsStep",
  },
  {
    slug: "create-agent",
    label: "Create Agent",
    description:
      "Create a new agent with system prompt, provider/model, and optional tools, MCP whitelist, KB collections, and run-time settings.",
    category: "Workflow Builder",
    stepFunction: "wfCreateAgentStep",
  },
  {
    slug: "update-agent",
    label: "Update Agent",
    description:
      "Update an existing agent's metadata, system prompt, tools, MCP whitelist, KB collections, or run-time settings.",
    category: "Workflow Builder",
    stepFunction: "wfUpdateAgentStep",
  },
  {
    slug: "delete-agent",
    label: "Delete Agent",
    description:
      "Delete an agent by slug. The 'default' agent is protected and cannot be deleted.",
    category: "Workflow Builder",
    stepFunction: "wfDeleteAgentStep",
  },
  {
    slug: "launch-agent",
    label: "Launch Agent",
    description:
      "Invoke an agent (subagent call) with a prompt and optional multimodal attachments.",
    category: "Workflow Builder",
    stepFunction: "wfLaunchAgentStep",
  },

  // discovery
  {
    slug: "list-actions",
    label: "List Actions",
    description:
      "List every action available in the workflow registry (plugin + system).",
    category: "Workflow Builder",
    stepFunction: "wfListActionsStep",
  },
  {
    slug: "list-integrations",
    label: "List Integrations",
    description:
      "List integrations the user has configured, with their available actions.",
    category: "Workflow Builder",
    stepFunction: "wfListIntegrationsStep",
  },
  {
    slug: "list-connections",
    label: "List Connections",
    description:
      "List available chat-style connections (Telegram, WhatsApp, etc.) for the calling user.",
    category: "Workflow Builder",
    stepFunction: "wfListConnectionsStep",
  },
  {
    slug: "list-tools",
    label: "List/Search Tools",
    description:
      "Search the AI Agent tool registry. Two modes: lean discovery (slim=true, paginated, no schemas) and full lookup (default, returns inputSchema for each match).",
    category: "Workflow Builder",
    stepFunction: "wfListToolsStep",
  },
  {
    slug: "fetch",
    label: "HTTP Fetch",
    description:
      "Make an HTTP request to a URL and return the parsed response. Generic fetch tool for agents.",
    category: "Workflow Builder",
    stepFunction: "wfFetchStep",
  },
  {
    slug: "fetch-article",
    label: "Fetch Article (Readable)",
    description:
      "Fetch ONE URL and return the readable article body as markdown. Single-page extraction only — does not crawl, does not follow links, does not dump site structure.",
    category: "Workflow Builder",
    stepFunction: "wfFetchArticleStep",
  },
  {
    slug: "fetch-models",
    label: "Fetch Models (AI Provider)",
    description:
      "List the chat or embedding models exposed by an AI provider integration (type prefix `agents_*`).",
    category: "Workflow Builder",
    stepFunction: "wfFetchModelsStep",
  },
  {
    slug: "run-js",
    label: "Run JS",
    description:
      "Run a JS snippet in a sandboxed runtime (no network, no I/O, no library imports). Useful for data transformation, parsing, formatting, math, regex, filtering, aggregation.",
    category: "Workflow Builder",
    stepFunction: "wfRunJsStep",
  },
  {
    slug: "send-error-notification",
    label: "Send Error Notification",
    description:
      "Manually fire the configured error notification channels (webhook, ntfy, Telegram/WhatsApp connection).",
    category: "Workflow Builder",
    stepFunction: "wfSendErrorNotificationStep",
  },

  // takeover
  {
    slug: "request-human-takeover",
    label: "Request Human Takeover",
    description:
      "Hand the conversation over to a human operator. Suppresses AI replies on this thread until the operator releases control from /chat-connections.",
    category: "Workflow Builder",
    stepFunction: "requestHumanTakeoverStep",
  },

  // notes / test
  {
    slug: "generate-test-payload",
    label: "Generate Test Payload",
    description:
      "Produce a synthetic payload of a target size. Used to exercise agent-handle tier boundaries (inline, JSONB, S3, 50 MB cap).",
    category: "Workflow Builder",
    stepFunction: "generateTestPayloadStep",
  },
  {
    slug: "write-note",
    label: "Write Note",
    description:
      "Write a note string to the local filesystem. Used as a test sink for agent-handle copy-paste detection.",
    category: "Workflow Builder",
    stepFunction: "writeNoteStep",
  },
];

export function registerPlugin(api: PluginHostAPI): void {
  api.registerIntegration({
    type: "workflow-builder",
    label: "Workflow Builder",
    actions,
    formFields: [],
  });

  // Replaces the first-party
  // `registerTakeoverAction("workflow-builder/request-human-takeover")` call.
  // Manifest `takeoverTargets[]` lists the matching `actionId` so the
  // registry allOf clause is satisfied (capability `takeover.register`).
  api.registerTakeoverTarget("request-human-takeover", {
    label: "Request human takeover",
    description:
      "Hand the conversation over to a human operator from a chat connection workflow.",
  });

  // TODO Phase B: api.registerRegistryStep(...) calls for each of the 22 steps
  // (wfCreateWorkflowStep, wfListWorkflowsStep, wfGetWorkflowStep,
  //  wfExecuteWorkflowStep, wfGetWorkflowExecutionsStep, wfListAgentsStep,
  //  wfCreateAgentStep, wfUpdateAgentStep, wfDeleteAgentStep, wfLaunchAgentStep,
  //  wfListActionsStep, wfListIntegrationsStep, wfListConnectionsStep,
  //  wfListToolsStep, wfFetchStep, wfFetchArticleStep, wfFetchModelsStep,
  //  wfRunJsStep, wfSendErrorNotificationStep, requestHumanTakeoverStep,
  //  generateTestPayloadStep, writeNoteStep). Implementations rewired to use
  //  api.workflow.*, api.fetchCredentials, api.llm.call, api.db.{read,write}.
  // TODO Phase B: api.registerTool(...) calls for the tool-eligible actions.
}
