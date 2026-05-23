# workflow-builder 1.3.0 bump — handoff

Goal: consume the 4e.5 host-API surfaces (runSandbox + connections.sendReply + launchAgent + sendErrorNotification + fetchCredentials baseURL) and replace the 3 stub-error steps + 1 hardcoded-false branch + 1 missing Ollama case.

Run from `tupiflow-plugins/packages/workflow-builder/`. agy prompt below — copy-paste verbatim.

## Prereqs (already shipped)

| Surface | Shim commit | Host commit | Cap |
|---|---|---|---|
| `api.runSandbox` | `c44e9a7` | `2937e2b` | `code.sandbox` |
| `api.connections.sendReply` | `c44e9a7` | `2937e2b` | `connection.send` |
| `api.launchAgent` | `0dc979a` | `2937e2b` | `agent.launch` |
| `api.sendErrorNotification` | (batch 3 earlier) | `21ab3b7` | `notifications.send` |
| `api.fetchCredentials` baseURL for `agents_*` | (no shim change) | `21ab3b7` + `d10e97f` | reuses `secrets.read` |

All shim updates already exist in `_shared/` byte-identically across `tupiflow-plugins` and `tupiflow-plugins-pro`.

## agy prompt

```
agy --dangerously-skip-permissions --prompt "Phase 4e.5 — bump workflow-builder to 1.3.0 to consume the new host-API surfaces shipped in this batch.

CWD: tupiflow-plugins/packages/workflow-builder

REQUIRED CHANGES:

1. plugin.toml:
   - identity.version: '1.2.0' -> '1.3.0'
   - capabilities array: ADD 'code.sandbox', 'connection.send', 'agent.launch', 'notifications.send' (in addition to the existing 9). Final closed-set: 13.

2. package.json:
   - version: '1.2.0' -> '1.3.0'

3. src/steps/launch-agent.ts — currently returns a stub error. Replace with real implementation calling api.launchAgent. Input shape: { agentSlug: string; prompt: string; providerOverride?: string; modelOverride?: string; maxToolSteps?: number; connectionIntegrationId?: string; connectionThreadJson?: NonNullable<unknown> }. Validate slug + prompt non-empty. Return { success: true, data: { text, toolStepsUsed } } on success, { success: false, error: { message } } on throw.

4. src/steps/run-js.ts — currently returns stub error. Replace with api.runSandbox call. Existing input shape is { code: string; data?: unknown; timeoutMs?: number }. Clamp timeoutMs into [1, 10000] before passing (host clamps too, but be defensive). Return { success, value, logs } or { success: false, error: { message: error.message } }.

5. src/steps/send-error-notification.ts — currently returns stub error. Replace with api.sendErrorNotification call. Build the spec from existing input { message, workflowName?, workflowId?, executionId? }. Return { success: true, data: result } where result is { dispatched, reason? }.

6. src/steps/request-human-takeover.ts — currently hard-codes notified: false at line ~99. Now that api.connections.sendReply exists, post the courtesy notice. After successfully writing the takeover state to connection_thread_history (the existing flow), look up the integration row + threadJson the step already has access to via ctx.threadJson. If both are present, call api.connections.sendReply({ integrationId, threadJson, text: '<takeover-message>' }). On success, set notified: true in result; on failure, log warning and continue (do NOT fail the step). Read the existing source carefully to understand the data flow before editing.

7. src/steps/fetch-models.ts — currently has switch statement for providers. ADD a new 'ollama' case after the others. Use credentials.baseURL (now populated by 4e.5 batch 3 host fix for agents_ollama integrations). Endpoint: \${baseURL}/api/tags. Reads .models[].model OR .name (newer Ollama uses .model, older .name). Filter chat vs embedding via family heuristic similar to the host-side fetchOllamaTags in backend/src/lib/ai-providers/models.ts (look at OLLAMA_EMBEDDING_FAMILIES constant). Strip ':latest' tag from labels. Return models alpha-sorted.

8. New tests:
   - tests/launch-agent.test.ts — mock api.launchAgent, verify pass-through + error handling
   - tests/run-js.test.ts — mock api.runSandbox, verify success + failure + timeout-clamp
   - tests/send-error-notification.test.ts — mock api.sendErrorNotification
   - tests/request-human-takeover.test.ts — IF an existing test exists, extend it; otherwise add a test for the new sendReply call path
   - tests/fetch-models.test.ts — IF exists, add Ollama case; otherwise add focused test for that branch

AFTER EDITS:
- cd to repo root: pnpm type-check
- pnpm test (workflow-builder tests)
- pnpm -w build (verify bundle builds)

CRITICAL CONSTRAINTS:
- Do NOT touch shim files (_shared/) — already shipped in c44e9a7.
- Do NOT touch host files (none here, tupiflow is a sibling repo).
- Do NOT push, commit, or amend. Leave working tree dirty for user.
- threadJson type on connections.sendReply is NonNullable<unknown> — narrow ctx.threadJson before passing (e.g. throw if undefined/null, since takeover requires an active thread).

Report:
- Files modified with rough line counts
- pnpm test outcome + any new test counts
- Any host-API contract surprises (where shim contract was unclear)"
```

## After agy completes — checks to run before committing

1. `pnpm type-check` (workspace root)
2. `pnpm test packages/workflow-builder`
3. `pnpm -w build` (manifest emits with new capabilities)
4. Verify `dist/manifest.json` shows `version: 1.3.0` and 13 capabilities

## Suggested commit shape

Per-step commits cleanest for codex review (5 commits) but single bundled commit is acceptable. Either way:

```
feat(workflow-builder): bump 1.3.0 — consume 4e.5 surfaces

- launch-agent stub -> api.launchAgent
- run-js stub -> api.runSandbox
- send-error-notification stub -> api.sendErrorNotification
- request-human-takeover step 3 -> api.connections.sendReply
- fetch-models: Ollama case via credentials.baseURL
- plugin.toml + package.json: 1.2.0 -> 1.3.0
- caps: +code.sandbox +connection.send +agent.launch +notifications.send

Co-Authored-By: ...
```

## Review

`codex review --commit <SHA>` per `[[review-before-commit]]`. Fallback `caveman:cavecrew-reviewer` on quota.

## Notes / known unknowns

- **request-human-takeover threadJson source**: the step previously did NOT have a clean threadJson handle (that was the reason step 3 was hardcoded false). Read `src/steps/request-human-takeover.ts` carefully — if `ctx.threadJson` is not exposed by the registry shim's `RegistryStepContext`, the step may need to accept `threadJson` as an explicit input field on the action's configFields. Flag this if discovered.
- **Ollama models endpoint**: confirm `baseURL` doesn't include trailing slash before appending `/api/tags`; strip if so (`baseURL.replace(/\/+$/, '')`).
- **launchAgent connectionThreadJson narrowing**: the shim types it as `NonNullable<unknown>` — agy must call out if ctx.threadJson passes a strict-null check at the call site before forwarding.
