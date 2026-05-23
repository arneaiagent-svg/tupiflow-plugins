# tupiflow-plugins handoff — publish-time schema fixes

Two distinct fixes in this repo, neither requires a shim type change.

## Issue A — build-helpers does not emit takeoverTargets

`tfr publish` rejected workflow-builder@1.3.0 with:
```
/: 'allOf' failed
/: missing property 'takeoverTargets'
```

workflow-builder's plugin.toml DOES declare `[[takeoverTargets]]` block (verify with `grep -A4 takeoverTargets packages/workflow-builder/plugin.toml`). But `buildPlugin` in `packages/_shared/src/build-helpers.ts` (around line 367-400) builds the manifest object and does NOT include `takeoverTargets`. So `dist/manifest.json` lacks it. Registry's allOf clause requires `takeoverTargets` non-empty when `capabilities[]` includes `takeover.register`.

Same gap will hit any plugin that declares `takeover.register` capability.

This change must mirror byte-identically to `tupiflow-plugins-pro/_shared/src/build-helpers.ts` (shim-drift gate). See `tupiflow-plugins-pro/HANDOFF_PUBLISH_FIX.md`.

## Issue B — workflow-builder action 18 has empty outputFields[0].field

`tfr publish` rejected workflow-builder@1.3.0 with:
```
/actions/18/outputFields/0/field: '' does not match pattern '^[a-zA-Z][a-zA-Z0-9_]*$'
```

Action 18 is `run-js`. Its outputField is `{ field: "", description: "Whatever the snippet returns ..." }` — empty key was a stand-in for "the return value is the whole output". Schema requires a non-empty `field` name matching the identifier pattern.

Fix: rename to `result` (or similar;). Update tests + the action's `tool.inputSchemaJson` only if relevant; usually only `outputFields` needs the rename.

## task
REQUIRED EDITS:

ISSUE A — build-helpers does not emit takeoverTargets

1. packages/_shared/src/build-helpers.ts — read the existing manifest assembly block (around line 360-400, the const manifest: Manifest = { ... } block).

Add takeoverTargets emission. Source: plugin.toml's [[takeoverTargets]] table-array. Each entry has: actionId (string, required), label (string, required), description (string, optional).

The TomlBuildConfig type at top of the file needs:
  takeoverTargets?: Array<{ actionId: string; label: string; description?: string }>;

The Manifest type already has takeoverTargets shape (check packages/_shared/src/manifest-types.ts for ManifestTakeoverTarget). Pass through verbatim:

  ...(toml.takeoverTargets && toml.takeoverTargets.length > 0
    ? { takeoverTargets: toml.takeoverTargets }
    : {}),

Place near the existing customSql / workers / requiredNpmDeps optional-spread block.

2. ALSO mirror this change byte-identically into /Users/ricardo/ai/tupiflow-project/tupiflow-plugins-pro/packages/_shared/src/build-helpers.ts. The shim-drift gate enforces byte-identity. Verify after edit:
   diff packages/_shared/src/build-helpers.ts /Users/ricardo/ai/tupiflow-project/tupiflow-plugins-pro/packages/_shared/src/build-helpers.ts
   (output must be empty.)

ISSUE B — workflow-builder run-js action has empty outputFields[0].field

3. packages/workflow-builder/build.mjs — find the run-js action (slug: 'run-js'). Locate its outputFields:
   { field: '', description: 'Whatever the snippet returns (must be JSON-serializable).' }

Rename the field to 'result'. (Also reflect in the action's downstream consumers if any — search the step impl + tests for hardcoded 'field' references in run-js. Should be none.)

VERIFY:

4. cd tupiflow-plugins ; pnpm -w build (workspace build emits all dist/manifest.json files)
5. cd tupiflow-plugins-pro ; pnpm -w build (regenerate pro manifests)
6. Confirm dist outputs:
   jq '.takeoverTargets // \"missing\"' /Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/dist/manifest.json
   (should print the array, not 'missing')
   jq '.actions[18].outputFields[0].field' /Users/ricardo/ai/tupiflow-project/tupiflow-plugins/packages/workflow-builder/dist/manifest.json
   (should print 'result' not '')
7. cd tupiflow-plugins ; pnpm type-check (must pass)
8. cd tupiflow-plugins-pro ; pnpm type-check (must pass)

Do NOT push or commit. Leave dirty.

Report:
- Files modified with line ranges
- diff output for build-helpers.ts across the two repos (should be empty)
- jq verification outputs
- type-check status for each repo"
```

## After agy

- 2 commits (one per repo) since shim affects both monorepos. workflow-builder build.mjs fix lives only in this repo (tupiflow-plugins) — bundle that into the same commit as the public-repo shim change.
- `codex review --commit <SHA>` per repo.
- Re-run the publish script after registry is fixed + redeployed.

## Coordinated fix in tupiflow-registry

`actionConfigField.type` enum is missing `template-textarea`. Both workflow-builder and telegram use it. Even with the takeoverTargets + outputFields fix above, publish will still fail on configField type validation until registry adds the enum value. See `tupiflow-registry/HANDOFF_PUBLISH_FIX.md`.
