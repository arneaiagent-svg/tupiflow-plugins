// Phase 4f batch 1 — compute-hash worker fixture.
//
// Contract (PHASE_4F §"Worker fixture protocol" / §"Decisions" item 4):
//   - Receive: { input: string }
//   - Respond: { hash: string } (sha256 hex of input, utf-8 encoded)
//   - On throw: postMessage({ type: "error", message, name, stack })
//
// Worker has NO PluginHostAPI access — pure compute (no db, no fetch, no llm).
// Blessed host modules are externalised by buildPlugin; node:crypto is a
// Node built-in and does NOT need to be on the blessed list.

import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("compute-hash must run as a worker_thread, not directly");
}

parentPort.on("message", (msg) => {
  try {
    const input = msg?.input;
    if (typeof input !== "string") {
      throw new TypeError(`input must be a string, got ${typeof input}`);
    }
    const hash = createHash("sha256").update(input, "utf8").digest("hex");
    parentPort.postMessage({ hash });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    parentPort.postMessage({
      type: "error",
      message: e.message,
      name: e.name,
      stack: e.stack ?? "",
    });
  }
});
