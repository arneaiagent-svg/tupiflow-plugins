// Public surface of @tupiflow-plugins/shared. Re-exported one symbol at a
// time so the bundle stays tree-shakeable and tupiflow's "no barrel files"
// rule isn't violated by a wildcard re-export. Consumers should prefer
// the subpath exports (e.g. "@tupiflow-plugins/shared/build-helpers") and
// only use this entrypoint when they really need a single import line.

export { buildPlugin } from "./build-helpers.ts";
export type {
  BuildPluginOptions,
  BuildPluginResult,
} from "./build-helpers.ts";

export type {
  AgentCreateSpec,
  AgentListFilter,
  AgentListItem,
  AgentUpdatePatch,
  ChatAttachment,
  ChatMessageEvent,
  ConnectionInstance,
  ConnectionSpec,
  CreateExecutionSpec,
  CreateExecutionResult,
  DbCallOpts,
  EmbedArgs,
  EmbedResult,
  ExecutionLogEntry,
  HttpMethod,
  IntegrationConfigPatch,
  IntegrationListFilter,
  IntegrationListItem,
  IntegrationSpec,
  LlmCallArgs,
  LlmCallResult,
  PluginDb,
  PluginHostAPI,
  PluginLogger,
  RegistryStepContext,
  RegistryStepHandler,
  RegistryStepInput,
  RouteContext,
  RouteHandler,
  RouteRequest,
  StepHandler,
  StepResult,
  TakeoverTargetSpec,
  TestHandler,
  TestIntegrationResult,
  TestIntegrationSpec,
  ToolCatalogContext,
  ToolCatalogContributor,
  ToolCatalogEntry,
  ToolHandler,
  Workflow,
  WorkflowCreateSpec,
  WorkflowListItem,
  WorkflowListOpts,
  WorkflowListPage,
} from "./host-api-types.ts";

export type {
  Manifest,
  ManifestAction,
  ManifestActionTool,
  ManifestBundle,
  ManifestCredential,
  ManifestIcon,
  ManifestIconLucide,
  ManifestIconSvg,
  ManifestIdentity,
  ManifestRequiredExtension,
  ManifestRoute,
  ManifestRuntime,
  ManifestSchemaBlock,
  ManifestTakeoverTarget,
} from "./manifest-types.ts";
