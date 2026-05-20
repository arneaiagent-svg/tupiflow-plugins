// hello-plugin — minimal registry plugin used to round-trip the
// tupiflow-registry M3a install pipeline end-to-end.
//
// Registers:
//   - integration spec (so the catalog has something to show)
//   - one step that echoes its input
//   - one tool wrapping that step
//   - one GET route at /ping (mounted under /plugins/hello-plugin/ping)
//
// No DB, no credentials, no capabilities. If this plugin installs and
// /plugins/hello-plugin/ping returns 200, the registry-to-consumer
// pipeline is verified.

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

export function registerPlugin(api: PluginHostAPI): void {
  api.registerIntegration({
    type: "hello-plugin",
    label: "Hello Plugin",
    actions: [
      {
        slug: "echo",
        label: "Echo",
        description: "Echoes the input back. Proof-of-life.",
        category: "Hello",
        stepFunction: "helloEchoStep",
      },
    ],
    formFields: [],
  });

  api.registerStep("helloEchoStep", async (input: unknown) => {
    return { success: true, data: { echoed: input, at: new Date().toISOString() } };
  });

  api.registerTool(
    "hello_echo",
    {
      // JSON Schema (Draft 2020-12). Kept inline to avoid Zod runtime dep.
      type: "object",
      properties: { message: { type: "string", description: "Anything." } },
      required: ["message"],
      additionalProperties: false,
    },
    async (input: unknown) => ({ echoed: input, at: new Date().toISOString() }),
  );

  api.registerRoute("GET", "/ping", (ctx) =>
    ctx.json({ ok: true, plugin: "hello-plugin", version: "0.1.0", at: new Date().toISOString() }),
  );
}
