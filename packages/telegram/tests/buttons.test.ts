import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseButtons } from "../src/buttons.ts";

test("parseButtons treats undefined/null/empty string as empty array", () => {
  assert.deepEqual(parseButtons(undefined), []);
  assert.deepEqual(parseButtons(null), []);
  assert.deepEqual(parseButtons("   "), []);
});

test("parseButtons rejects invalid JSON strings", () => {
  const r = parseButtons("not json");
  assert.deepEqual(r, { error: "buttons must be valid JSON" });
});

test("parseButtons rejects non-array values", () => {
  const r = parseButtons('{"text":"x","url":"https://x"}');
  assert.deepEqual(r, { error: "buttons must be a JSON array" });
});

test("parseButtons rejects non-object items", () => {
  const r = parseButtons(["nope"]);
  assert.deepEqual(r, { error: "each button must be { text, url }" });
});

test("parseButtons rejects items missing text or url", () => {
  const r = parseButtons([{ text: "x" }]);
  assert.deepEqual(r, { error: "each button must have string `text` and `url`" });
});

test("parseButtons rejects items with empty text or url", () => {
  const r = parseButtons([{ text: "  ", url: "https://x" }]);
  assert.deepEqual(r, { error: "button text and url cannot be empty" });
});

test("parseButtons rejects private-IP urls", () => {
  const r = parseButtons([{ text: "x", url: "http://192.168.1.5" }]);
  assert.equal(Array.isArray(r), false);
  if (!Array.isArray(r)) {
    assert.match(r.error, /private-IP|localhost|publicly/);
  }
});

test("parseButtons accepts a well-formed JSON string", () => {
  const r = parseButtons('[{"text":"Open","url":"https://example.com"}]');
  assert.deepEqual(r, [{ text: "Open", url: "https://example.com" }]);
});

test("parseButtons accepts an array directly", () => {
  const r = parseButtons([{ text: "Open", url: "https://example.com" }]);
  assert.deepEqual(r, [{ text: "Open", url: "https://example.com" }]);
});
