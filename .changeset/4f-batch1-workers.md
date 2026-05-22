---
"@tupiflow-plugins/shared": minor
---

Phase 4f batch 1 — plugin-defined workers + blessed host modules.

- `api.runTask(workerId, input, opts?)` on `PluginHostAPI`.
- `WorkerSpec` interface + `Manifest.workers?: WorkerSpec[]`.
- Named errors: `WorkerNotFoundError`, `WorkerTimeoutError`,
  `WorkerCapabilityDeniedError`.
- `BLESSED_HOST_MODULES` constant mirrors the tupiflow host
  `package.json` semver ranges (zod ^4, hono ^4, drizzle-orm ^0.44,
  postgres ^3.4, ai ^6, @ai-sdk/{openai,anthropic,google,groq,mistral}
  ^3 / ^3 / ^3 / ^3 / ^3, canonicalize ^3).
- `buildPlugin` externalizes the blessed list in the main bundle AND
  in each worker bundle (separate esbuild call per worker), validates
  worker id regex + source-on-disk, and records the derived
  `workers/<id>.mjs` paths on `manifest.workers`.

Bumps `_shared` 0.7.0 → 0.8.0.
