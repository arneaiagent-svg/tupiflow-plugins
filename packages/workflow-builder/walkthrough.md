# Walkthrough — workflow-builder 1.3.0 Bump

We successfully upgraded `workflow-builder` to version `1.3.0` to consume the 5 new Phase 4e.5 host-API surfaces: `api.runSandbox`, `api.connections.sendReply`, `api.launchAgent`, `api.sendErrorNotification`, and `fetchCredentials` `baseURL` for Ollama.

## Changes Made

### 1. Configuration & Capabilities
- **[plugin.toml](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/plugin.toml)**: Bumped version from `1.2.0` to `1.3.0` and added four new capabilities: `code.sandbox`, `connection.send`, `agent.launch`, and `notifications.send` (closed set of 13 capabilities total).
- **[package.json](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/package.json)**: Bumped version to `1.3.0` and configured native Node.js test runner using `--experimental-strip-types`.

### 2. Step Implementations
- **[launch-agent.ts](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/src/steps/launch-agent.ts)**: Replaced the stub error with `api.launchAgent`. Handled user inputs (including overrides and thread context mapping). Audited inputs and resolved two key findings:
  1. Resolved potential key mismatch (`userPrompt` in the config schema vs `prompt` in the types) by checking both keys dynamically (`input.prompt || input.userPrompt`).
  2. Aligned `agentSlug` validation to match the config field definition by defaulting it to `"default"` if omitted, instead of failing, keeping existing workflows functioning as expected.
- **[run-js.ts](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/src/steps/run-js.ts)**: Replaced the stub error with `api.runSandbox`. Clamped `timeoutMs` defensively to `[1, 10000]` and processed sandbox execution results.
- **[send-error-notification.ts](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/src/steps/send-error-notification.ts)**: Replaced the stub error with `api.sendErrorNotification`.
- **[request-human-takeover.ts](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/src/steps/request-human-takeover.ts)**: Implemented in-thread takeover courtesy notice using `api.connections.sendReply`. Validated `ctx.threadJson` to narrow the type correctly. Made notification optional such that dispatch failures log a warning and continue without breaking the workflow step.
- **[fetch-models.ts](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/src/steps/fetch-models.ts)**: Added support for `ollama` by utilizing `credentials.baseURL`. Filtered chat/embedding models using host-matched heuristics (embedding families `bert` / `nomic-bert` or name matches for `/embed|bge|nomic|mxbai/i`), stripped `:latest` tags from labels, and sorted alphabetically.

### 3. Verification & Tests
We created a new test suite under `tests/` with 5 test files:
- **[launch-agent.test.ts](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/tests/launch-agent.test.ts)**: Verified `api.launchAgent` pass-throughs, empty validations, error handling, backward compatibility with `userPrompt`, and that omitting `agentSlug` correctly defaults to the `"default"` agent.
- **[run-js.test.ts](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/tests/run-js.test.ts)**: Verified sandbox successes, execution syntax error mapping, and defensive timeout clamping.
- **[send-error-notification.test.ts](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/tests/send-error-notification.test.ts)**: Verified notification spec formatting and execution logs.
- **[request-human-takeover.test.ts](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/tests/request-human-takeover.test.ts)**: Verified takeover DB updates, courtesy sendReply invocation, default message fallbacks, and resilient warning logs when thread context is missing.
- **[fetch-models.test.ts](file:///Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/tests/fetch-models.test.ts)**: Verified Ollama provider routing, family heuristics, tag stripping, and alpha-sorting.

---

## Validation Results

### 1. Type Check (`pnpm type-check` from workspace root)
All packages compiled successfully with zero type errors.

### 2. Unit Tests (`pnpm test` from `packages/workflow-builder`)
All 20 test cases passed successfully:
```
TAP version 13
# Subtest: wfFetchModelsStep - ollama chat models success
ok 1 - wfFetchModelsStep - ollama chat models success
# Subtest: wfFetchModelsStep - ollama embedding models success via family and name heuristics
ok 2 - wfFetchModelsStep - ollama embedding models success via family and name heuristics
# Subtest: wfLaunchAgentStep - success flow with options
ok 3 - wfLaunchAgentStep - success flow with options
# Subtest: wfLaunchAgentStep - backward compatibility with userPrompt
ok 4 - wfLaunchAgentStep - backward compatibility with userPrompt
# Subtest: wfLaunchAgentStep - defaults agentSlug to default if missing
ok 5 - wfLaunchAgentStep - defaults agentSlug to default if missing
# Subtest: wfLaunchAgentStep - validation fails if prompt is missing
ok 6 - wfLaunchAgentStep - validation fails if prompt is missing
# Subtest: wfLaunchAgentStep - throws error from host API
ok 7 - wfLaunchAgentStep - throws error from host API
# Subtest: requestHumanTakeoverStep - successful takeover with courtesy notice sent
ok 8 - requestHumanTakeoverStep - successful takeover with courtesy notice sent
# Subtest: requestHumanTakeoverStep - default courtesy message when not provided in input
ok 9 - requestHumanTakeoverStep - default courtesy message when not provided in input
# Subtest: requestHumanTakeoverStep - fails if human takeover is disabled in connection settings
ok 10 - requestHumanTakeoverStep - fails if human takeover is disabled in connection settings
# Subtest: requestHumanTakeoverStep - courtesy notice fails (sendReply throws) but step still succeeds
ok 11 - requestHumanTakeoverStep - courtesy notice fails (sendReply throws) but step still succeeds
# Subtest: requestHumanTakeoverStep - courtesy notice skipped if threadJson is missing but step still succeeds
ok 12 - requestHumanTakeoverStep - courtesy notice skipped if threadJson is missing but step still succeeds
# Subtest: wfRunJsStep - success sandbox run
ok 13 - wfRunJsStep - success sandbox run
# Subtest: wfRunJsStep - sandbox execution error returns success: false step result
ok 14 - wfRunJsStep - sandbox execution error returns success: false step result
# Subtest: wfRunJsStep - validation fails if code is missing
ok 15 - wfRunJsStep - validation fails if code is missing
# Subtest: wfRunJsStep - defensive timeout clamping
ok 16 - wfRunJsStep - defensive timeout clamping
# Subtest: wfRunJsStep - catch threw exceptions
ok 17 - wfRunJsStep - catch threw exceptions
# Subtest: wfSendErrorNotificationStep - success dispatch
ok 18 - wfSendErrorNotificationStep - success dispatch
# Subtest: wfSendErrorNotificationStep - validation fails if message is missing
ok 19 - wfSendErrorNotificationStep - validation fails if message is missing
# Subtest: wfSendErrorNotificationStep - handle exceptions
ok 20 - wfSendErrorNotificationStep - handle exceptions
1..20
# tests 20
# suites 0
# pass 20
# fail 0
```

### 3. Package Build (`pnpm -w build` from workspace root)
Esbuild bundle successfully packaged `@tupiflow-plugins/workflow-builder` and emitted output tarball size `28,547` bytes containing the correctly resolved manifest with version `1.3.0` and all 13 capabilities.
