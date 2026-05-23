# Phase 4e.5 — Shim handoff for batches 5 / 4b / 4a

All 3 batches mirror across `tupiflow-plugins` (this repo) AND `tupiflow-plugins-pro` byte-identically. The `_shared/src/host-api-types.ts` is the strict-mirror file (shim-drift gate enforces). Other `_shared/` files (`index.ts` etc.) are similar but may diverge for pro-only exports (license-check, ssrf).

Design source of truth: `tupiflow/docs/registry/PHASE_4E5_BATCH_4_5_DESIGN.md`.

Pre-locked decisions:
- 4b namespace: keep `api.connections` (plural) to match batch 1
- 4b gate: any plugin with cap + threadJson (loose; threadJson serves as proof)
- 4a no slug gate
- 4a result includes `toolStepsUsed: number`

## Batch 5 — agy prompt

Run from this directory (`tupiflow-plugins`). Agent edits both repos.

```
agy --dangerously-skip-permissions --prompt "Phase 4e.5 batch 5 — shim contract for api.runSandbox. Must be byte-identical mirror across tupiflow-plugins (current cwd) AND /Users/ricardo/ai/tupiflow-project/tupiflow-plugins-pro. Shim-drift gate enforces this.

Add to packages/_shared/src/host-api-types.ts in BOTH repos. Place near the end of the file before the closing of any existing block, near other PluginHostAPI surface types.

Types to add verbatim:

export type SandboxErrorKind =
  | 'timeout'
  | 'oom'
  | 'syntax'
  | 'runtime'
  | 'non_serializable';

export interface SandboxOpts {
  /** Hard cap in ms. Default 1000; max 10000. Lower clamp 1ms. */
  timeoutMs?: number;
  /** Hard cap in MiB. Default 64; max 128. */
  memoryLimitMb?: number;
}

export type SandboxSuccess = {
  success: true;
  value: unknown;
  logs: string[];
};

export type SandboxFailure = {
  success: false;
  error: { kind: SandboxErrorKind; message: string };
  logs: string[];
};

export type SandboxResult = SandboxSuccess | SandboxFailure;

Add to PluginHostAPI interface (find the 'PluginHostAPI = {' block), placed after sendErrorNotification:

  /**
   * Phase 4e.5 batch 5 — run user-supplied JavaScript code in a WASM
   * QuickJS sandbox with isolated heap. Stripped globals: fetch,
   * setTimeout, setInterval, clearTimeout, clearInterval, require,
   * process, globalThis. Available: JSON, Math, Date, console.log.
   * User code is wrapped as (function(data){ <code> })(globalThis.data);
   * the return value must be JSON-serializable. Capability: code.sandbox.
   */
  runSandbox(
    code: string,
    ctx: { data: unknown },
    opts?: SandboxOpts
  ): Promise<SandboxResult>;

Add to packages/_shared/src/index.ts root re-exports (the 'export type {' block listing ErrorNotificationFailedNode etc) — alphabetically near other Sandbox / type exports:
  SandboxErrorKind, SandboxFailure, SandboxOpts, SandboxResult, SandboxSuccess

NOTE: index.ts is NOT byte-identical between repos. Only host-api-types.ts is.

After edits in both repos:
1. cd tupiflow-plugins ; pnpm type-check (must pass)
2. cd tupiflow-plugins-pro ; pnpm type-check (must pass)
3. diff /Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/_shared/src/host-api-types.ts /Users/ricardo/ai/tupiflow-project/tupiflow-plugins-pro/packages/_shared/src/host-api-types.ts (MUST be empty)

If telegram tests fail (missing runSandbox in mock), add stub: runSandbox: async () => ({ success: true, value: null, logs: [] }).

Do NOT commit. Leave dirty. Report: files modified, type-check status, diff output."
```

## Batch 4b — agy prompt

Run AFTER batch 5 commits.

```
agy --dangerously-skip-permissions --prompt "Phase 4e.5 batch 4b — shim contract for api.connections.sendReply. Byte-identical mirror across tupiflow-plugins (current cwd) AND /Users/ricardo/ai/tupiflow-project/tupiflow-plugins-pro.

Add to packages/_shared/src/host-api-types.ts in BOTH repos:

export interface ConnectionSendReplySpec {
  /** Target integration row id (must be a connection-type integration). */
  integrationId: string;
  /**
   * Thread context. If omitted, the host resolves the row default
   * threadJson from connection_thread_history (latest by updatedAt).
   * Plugins that already loaded a row should pass it through to avoid
   * the extra DB read.
   */
  threadJson?: string;
  /** Message text. Required, non-empty after trim. */
  text: string;
}

export interface ConnectionSendReplyResult {
  /** True when the adapter returned a successful upstream response. */
  delivered: boolean;
  /** Adapter-assigned message id (e.g. Telegram message_id). */
  messageId?: string;
  /** Always returned; matches the resolved thread the post landed in. */
  threadId: string;
}

Locate the existing api.connections namespace block on PluginHostAPI (added in batch 1 with connections.types() method). Add a sibling sendReply method:

  /**
   * Phase 4e.5 batch 4b — post a message into an existing connection
   * thread (Telegram chat, WhatsApp conversation, etc). The host resolves
   * the integration type, dispatches via the registered adapter ThreadImpl,
   * and returns the delivery receipt. Capability: connection.send.
   * Ownership: any plugin with the capability + threadJson may post;
   * threadJson serves as proof of authorized context.
   */
  sendReply(spec: ConnectionSendReplySpec): Promise<ConnectionSendReplyResult>;

Also add to index.ts root re-exports: ConnectionSendReplySpec, ConnectionSendReplyResult.

If the existing connections block on PluginHostAPI is structured differently than expected (verify exact namespace name), preserve consistency with batch 1.

After: pnpm type-check in both repos. diff host-api-types.ts (must be empty). Stub any test mocks if missing. Leave dirty. Report."
```

## Batch 4a — agy prompt

Run AFTER batch 4b commits.

```
agy --dangerously-skip-permissions --prompt "Phase 4e.5 batch 4a — shim contract for api.launchAgent. Byte-identical mirror across tupiflow-plugins (current cwd) AND /Users/ricardo/ai/tupiflow-project/tupiflow-plugins-pro.

Add to packages/_shared/src/host-api-types.ts in BOTH repos:

export interface LaunchAgentOpts {
  /** Optional per-call provider override (e.g. openai). */
  providerOverride?: string;
  /** Optional per-call model override (e.g. gpt-5-mini). */
  modelOverride?: string;
  /** If launching inside an active thread, pass through. */
  connectionIntegrationId?: string;
  connectionThreadJson?: string;
  /** Hard cap on tool-call iterations. Default/max enforced by host. */
  maxToolSteps?: number;
}

export interface LaunchAgentResult {
  /** Final assistant text after the tool loop terminates. */
  text: string;
  /** Total tool-call iterations consumed. */
  toolStepsUsed: number;
}

Add to PluginHostAPI:

  /**
   * Phase 4e.5 batch 4a — launch a host-defined agent by slug with a
   * single user prompt. Synchronous: resolves when the agent tool loop
   * returns final text. No slug-prefix gate; capability is the consent
   * boundary. Capability: agent.launch.
   */
  launchAgent(
    slug: string,
    prompt: string,
    opts?: LaunchAgentOpts
  ): Promise<LaunchAgentResult>;

Also add to index.ts root re-exports: LaunchAgentOpts, LaunchAgentResult.

After: pnpm type-check in both repos. diff host-api-types.ts (must be empty). Stub mocks. Leave dirty. Report."
```

## Commit pattern (reference)

Per batch, separate commits in both repos:

```
# tupiflow-plugins
git add packages/_shared/src/host-api-types.ts packages/_shared/src/index.ts
# + any test stubs
git commit -m "feat(shared): <surface> (4e.5 batch <N>)" ...

# tupiflow-plugins-pro  (byte-identical _shared)
git add packages/_shared/src/host-api-types.ts packages/_shared/src/index.ts
git commit -m "feat(shared): <surface> (4e.5 batch <N>)" ...
```

Then `codex review --commit <SHA>` per repo per `[[review-before-commit]]`. Fix-pass as needed.
