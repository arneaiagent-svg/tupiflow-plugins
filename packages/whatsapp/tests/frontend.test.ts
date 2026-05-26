// react-dom/server static render only; full mount+poll requires jsdom which is not in BLESSED_BROWSER_MODULES.
// We import the pure body-renderer from frontend/qr-overlay-body.ts (NOT
// the .tsx) because node's --experimental-strip-types loader cannot parse
// .tsx files. The .ts companion uses React.createElement directly; the
// .tsx file re-exports renderBody for production callers.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { renderBody } from "../frontend/qr-overlay-body.ts";

const { renderToStaticMarkup } = await import("react-dom/server");

test("renderBody — loading state renders spinner", () => {
  const html = renderToStaticMarkup(renderBody(null, true) as any);
  assert.match(html, /animate-spin/);
  assert.match(html, /Starting WhatsApp connection/);
});

test("renderBody — connected state renders linked indicator + linkedAs", () => {
  const state = {
    connected: true,
    error: null,
    linkedAs: "5511999999999",
    pairingCode: null,
    qrDataUrl: null,
  };
  const html = renderToStaticMarkup(renderBody(state, false) as any);
  assert.match(html, /WhatsApp account linked/);
  assert.match(html, /5511999999999/);
});

test("renderBody — error state renders error text + retry hint", () => {
  const state = {
    connected: false,
    error: "WhatsApp logged this device out.",
    linkedAs: null,
    pairingCode: null,
    qrDataUrl: null,
  };
  const html = renderToStaticMarkup(renderBody(state, false) as any);
  assert.match(html, /WhatsApp logged this device out/);
  assert.match(html, /Close this dialog and reopen/);
});

test("renderBody — pairingCode state renders the code block", () => {
  const state = {
    connected: false,
    error: null,
    linkedAs: null,
    pairingCode: "ABCD-1234",
    qrDataUrl: null,
  };
  const html = renderToStaticMarkup(renderBody(state, false) as any);
  assert.match(html, /ABCD-1234/);
  assert.match(html, /Settings/);
});

test("renderBody — qrDataUrl state renders <img src=...>", () => {
  const state = {
    connected: false,
    error: null,
    linkedAs: null,
    pairingCode: null,
    qrDataUrl: "data:image/png;base64,FAKEFAKE",
  };
  const html = renderToStaticMarkup(renderBody(state, false) as any);
  assert.match(html, /<img[^>]*src="data:image\/png;base64,FAKEFAKE"/);
  assert.match(html, /Linked Devices/);
});

test("renderBody — neither connected nor qr → waiting fallback", () => {
  const state = {
    connected: false,
    error: null,
    linkedAs: null,
    pairingCode: null,
    qrDataUrl: null,
  };
  const html = renderToStaticMarkup(renderBody(state, false) as any);
  assert.match(html, /Waiting for QR code/);
});
