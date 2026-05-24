import { strict as assert } from "node:assert";
import { test } from "node:test";

import { testTelegram } from "../src/test.ts";

type FetchResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function makeFetch(response: {
  status: number;
  ok: boolean;
  body: unknown;
}): typeof globalThis.fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

test("testTelegram returns error when botToken is missing", async () => {
  const result = await testTelegram({});
  assert.equal(result.success, false);
  assert.equal(result.error, "botToken is required");
});

test("testTelegram returns success on 200 with ok=true body", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = makeFetch({ status: 200, ok: true, body: { ok: true } });
  try {
    const result = await testTelegram({ botToken: "123:abc" });
    assert.equal(result.success, true);
    assert.equal(result.error, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("testTelegram returns error on HTTP non-200", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = makeFetch({ status: 401, ok: false, body: { ok: false } });
  try {
    const result = await testTelegram({ botToken: "bad-token" });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /401/);
  } finally {
    globalThis.fetch = original;
  }
});

test("testTelegram returns error when Telegram body has ok=false", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = makeFetch({
    status: 200,
    ok: true,
    body: { ok: false, description: "Unauthorized" },
  });
  try {
    const result = await testTelegram({ botToken: "bad-token" });
    assert.equal(result.success, false);
    assert.equal(result.error, "Unauthorized");
  } finally {
    globalThis.fetch = original;
  }
});

test("testTelegram returns network error when fetch throws", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof globalThis.fetch;
  try {
    const result = await testTelegram({ botToken: "123:abc" });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /Network error/);
    assert.match(result.error ?? "", /ECONNREFUSED/);
  } finally {
    globalThis.fetch = original;
  }
});

test("testTelegram hits the correct Telegram getMe URL", async () => {
  const original = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    capturedUrl = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  try {
    await testTelegram({ botToken: "123456:ABC" });
    assert.equal(capturedUrl, "https://api.telegram.org/bot123456:ABC/getMe");
  } finally {
    globalThis.fetch = original;
  }
});
