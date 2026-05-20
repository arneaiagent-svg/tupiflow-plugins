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
  HttpMethod,
  IntegrationSpec,
  PluginHostAPI,
  RouteContext,
  RouteHandler,
  StepHandler,
  StepResult,
  ToolHandler,
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
  ManifestRoute,
  ManifestRuntime,
  ManifestSchemaBlock,
} from "./manifest-types.ts";
