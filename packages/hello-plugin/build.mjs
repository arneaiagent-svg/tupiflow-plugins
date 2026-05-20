// Build script for hello-plugin. Delegates to @tupiflow-plugins/shared's
// buildPlugin helper. The actions/routes set is supplied here because the
// helper does not yet sandbox-introspect the bundle (see TODO in
// build-helpers.ts).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlugin } from "@tupiflow-plugins/shared/build-helpers";

const root = dirname(fileURLToPath(import.meta.url));

await buildPlugin({
  root,
  srcEntry: "src/index.ts",
  distDir: resolve(root, "dist"),
  actions: [
    {
      slug: "echo",
      label: "Echo",
      description: "Echoes the input back. Proof-of-life.",
      category: "Hello",
      stepFunction: "helloEchoStep",
      tool: {
        name: "hello_echo",
        description: "Echo input back. Proof-of-life tool.",
        inputSchemaJson: JSON.stringify({
          type: "object",
          properties: { message: { type: "string", description: "Anything." } },
          required: ["message"],
          additionalProperties: false,
        }),
      },
    },
  ],
  routes: [{ method: "GET", path: "/ping", handlerExport: "pingHandler" }],
});
