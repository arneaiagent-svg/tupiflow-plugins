// publish-all — enumerates each package's dist/*.tgz and publishes via
// tupiflow-registry-cli for any version not already in the registry.
//
// STATUS: NOT YET IMPLEMENTED.
//
// Wiring this up requires:
//   1. Walk packages/*/dist/manifest.json.
//   2. For each, query registry GET /v1/plugins/<name>/<version> to see
//      if the version is already published.
//   3. If not present, invoke `tupiflow-registry-cli publish --manifest ...
//      --bundle ...`. The CLI consumes TUPIFLOW_REGISTRY_TOKEN from env.
//   4. Aggregate results, fail the run on any non-idempotent error.
//
// Deferred until the first real port (telegram) provides an end-to-end
// publish flow to validate against. Hard-refuse to run until then so we
// can never accidentally ship a half-baked publish path that publishes
// bytes the registry can't reproducibly serve.

console.error(
  "publish-all.mjs is not yet implemented. See script source for the planned design."
);
console.error(
  "Publish manually with `tupiflow-registry-cli publish --manifest ... --bundle ...` until this is wired up."
);
process.exit(1);
