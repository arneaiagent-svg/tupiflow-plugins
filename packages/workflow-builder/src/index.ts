// workflow-builder — registry-installable port of plugins/workflow-builder
// from the tupiflow first-party tree.
//
// Publisher: `tupiflow` (publisher-gated workflow.read methods rely on this).
// Capabilities exposed: takeover.register, workflow.read, workflow.write,
// db.read, db.write, llm.call, secrets.read, net.fetch.

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

import { wfComputeHashStep } from "./steps/compute-hash.ts";
import { wfCreateAgentStep } from "./steps/create-agent.ts";
import { wfCreateWorkflowStep } from "./steps/create-workflow.ts";
import { wfDeleteAgentStep } from "./steps/delete-agent.ts";
import { wfExecuteWorkflowStep } from "./steps/execute-workflow.ts";
import { wfFetchArticleStep } from "./steps/fetch-article.ts";
import { wfFetchModelsStep } from "./steps/fetch-models.ts";
import { wfFetchStep } from "./steps/fetch.ts";
import { wfGetWorkflowExecutionsStep } from "./steps/get-workflow-executions.ts";
import { wfGetWorkflowStep } from "./steps/get-workflow.ts";
import { wfLaunchAgentStep } from "./steps/launch-agent.ts";
import { wfListActionsStep } from "./steps/list-actions.ts";
import { wfListAgentsStep } from "./steps/list-agents.ts";
import { wfListConnectionsStep } from "./steps/list-connections.ts";
import { wfListIntegrationsStep } from "./steps/list-integrations.ts";
import { wfListToolsStep } from "./steps/list-tools.ts";
import { wfListWorkflowsStep } from "./steps/list-workflows.ts";
import { requestHumanTakeoverStep } from "./steps/request-human-takeover.ts";
import { wfRunJsStep } from "./steps/run-js.ts";
import { wfSendErrorNotificationStep } from "./steps/send-error-notification.ts";
import { wfUpdateAgentStep } from "./steps/update-agent.ts";

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

  // workers (4f batch 1 contract proof)
  {
    slug: "compute-hash",
    label: "Compute Hash (SHA-256)",
    description:
      "Compute the SHA-256 hex digest of a string in an isolated worker thread. Demonstrates the api.runTask worker contract (pure compute, no network).",
    category: "Workflow Builder",
    stepFunction: "wfComputeHashStep",
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
];

export function registerPlugin(api: PluginHostAPI): void {
  api.registerIntegration({
    type: "workflow-builder",
    label: "Workflow Builder",
    actions,
    formFields: [],
  });

  api.registerTakeoverTarget("workflow-builder/request-human-takeover", {
    label: "Request human takeover",
    description:
      "Hand the conversation over to a human operator from a chat connection workflow.",
  });

  api.registerRegistryStep("wfCreateWorkflowStep", wfCreateWorkflowStep);
  api.registerRegistryStep("wfListWorkflowsStep", wfListWorkflowsStep);
  api.registerRegistryStep("wfGetWorkflowStep", wfGetWorkflowStep);
  api.registerRegistryStep("wfExecuteWorkflowStep", wfExecuteWorkflowStep);
  api.registerRegistryStep("wfGetWorkflowExecutionsStep", wfGetWorkflowExecutionsStep);

  api.registerRegistryStep("wfListAgentsStep", wfListAgentsStep);
  api.registerRegistryStep("wfCreateAgentStep", wfCreateAgentStep);
  api.registerRegistryStep("wfUpdateAgentStep", wfUpdateAgentStep);
  api.registerRegistryStep("wfDeleteAgentStep", wfDeleteAgentStep);
  api.registerRegistryStep("wfLaunchAgentStep", wfLaunchAgentStep);

  api.registerRegistryStep("wfListActionsStep", wfListActionsStep);
  api.registerRegistryStep("wfListIntegrationsStep", wfListIntegrationsStep);
  api.registerRegistryStep("wfListConnectionsStep", wfListConnectionsStep);
  api.registerRegistryStep("wfListToolsStep", wfListToolsStep);
  api.registerRegistryStep("wfFetchStep", wfFetchStep);
  api.registerRegistryStep("wfFetchArticleStep", wfFetchArticleStep);
  api.registerRegistryStep("wfFetchModelsStep", wfFetchModelsStep);
  api.registerRegistryStep("wfRunJsStep", wfRunJsStep);
  api.registerRegistryStep("wfSendErrorNotificationStep", wfSendErrorNotificationStep);

  api.registerRegistryStep("requestHumanTakeoverStep", requestHumanTakeoverStep);

  // 4f batch 1 — compute-hash worker contract proof
  api.registerRegistryStep("wfComputeHashStep", wfComputeHashStep);
}
