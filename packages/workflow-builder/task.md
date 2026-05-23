# Task Checklist — workflow-builder 1.3.0 Bump

- [x] Modify configurations (plugin.toml + package.json)
- [x] Implement `src/steps/launch-agent.ts` with backward-compatible `userPrompt` support
- [x] Implement `src/steps/run-js.ts` with defensive timeout clamping
- [x] Implement `src/steps/send-error-notification.ts`
- [x] Implement `src/steps/request-human-takeover.ts` with `api.connections.sendReply` courtesy notice
- [x] Implement `src/steps/fetch-models.ts` with complete `ollama` provider and heuristics
- [x] Write and run 20 unit tests:
  - [x] `tests/launch-agent.test.ts` (including `userPrompt` compatibility test)
  - [x] `tests/run-js.test.ts`
  - [x] `tests/send-error-notification.test.ts`
  - [x] `tests/request-human-takeover.test.ts`
  - [x] `tests/fetch-models.test.ts`
- [x] Run verification:
  - [x] `pnpm type-check` (workspace root)
  - [x] `pnpm test` (inside packages/workflow-builder)
  - [x] `pnpm -w build` (workspace root)
  - [x] Verify `dist/manifest.json` shows version 1.3.0 and all 13 capabilities
