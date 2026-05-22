// Phase 4f batch 1/2 — fetch-article worker.
//
// Single-URL article extractor. Fetches one page, runs Mozilla Readability,
// converts the article body to markdown. NO recursion, NO link following.
//
// Runs inside the `fetch-article` Worker thread (api.runTask("fetch-article",
// …)) so jsdom + readability + turndown stay off the host request thread.
// The three heavy deps are externalised via build.mjs `requiredNpmDeps` (4f
// batch 2 allowlist); they resolve at runtime from the customer host's
// node_modules.
//
// Worker has NO PluginHostAPI access (PHASE_4F §"Security model" item 4):
// pure compute, with the request-side fetch + DNS access Node grants every
// worker thread.
//
// SSRF guard imported from `@tupiflow-plugins/shared/ssrf` — esbuild inlines
// the shim's pure-TS module into this worker bundle at build time (it is NOT
// on the BLESSED_HOST_MODULES / requiredNpmDeps externalise list, on purpose:
// the guard MUST travel with the worker so a host downgrade can never deliver
// an older permissive variant).
//
// Error contract:
//   - Domain-level failures (bad URL, http error, not article, timeout, …)
//     are returned as `{ ok: false, reason, message, … }` and posted as a
//     normal worker result. They are NOT host-level errors.
//   - Unexpected exceptions (programmer error, OOM, etc.) are posted as
//     `{ type: "error", message, name, stack }` per PHASE_4F §"Decisions"
//     item 4 — the host reconstructs an Error and throws to the caller.

import { parentPort } from "node:worker_threads";
import { assertPublicUrl } from "@tupiflow-plugins/shared/ssrf";
// Externalised via build.mjs `requiredNpmDeps`; resolved from host node_modules.
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownCtor from "turndown";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const MAX_HTML_BYTES = 4_000_000;
const MAX_REDIRECTS = 5;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
};

// ---------------------------------------------------------------------------
// HTML → readable markdown
// ---------------------------------------------------------------------------

const turndown = new TurndownCtor({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

function extractArticle(html, baseUrl) {
  let dom;
  try {
    dom = new JSDOM(html, { url: baseUrl });
  } catch {
    return null;
  }
  try {
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) {
      return null;
    }
    let markdown = "";
    if (article.content) {
      markdown = turndown.turndown(article.content).trim();
    } else if (article.textContent) {
      markdown = article.textContent.trim();
    }
    if (!markdown) {
      return null;
    }
    return {
      byline: article.byline?.trim() || null,
      excerpt: article.excerpt?.trim() || null,
      length: markdown.length,
      markdown,
      title: article.title?.trim() || null,
    };
  } catch {
    return null;
  } finally {
    dom.window.close();
  }
}

// ---------------------------------------------------------------------------
// Fetch + retry + streamed byte cap
// ---------------------------------------------------------------------------

async function fetchOnce(url, timeoutMs, disableBrowserHeaders, controller) {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let currentUrl = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(currentUrl);
      const res = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: disableBrowserHeaders ? {} : BROWSER_HEADERS,
      });
      const isRedirect =
        res.status >= 300 && res.status < 400 && res.status !== 304;
      if (!isRedirect) {
        return { response: res, finalUrl: currentUrl };
      }
      const location = res.headers.get("location");
      if (!location) {
        return { response: res, finalUrl: currentUrl };
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(
          `redirect limit (${MAX_REDIRECTS}) exceeded; last hop pointed at ${location}`
        );
      }
      try {
        await res.arrayBuffer();
      } catch {
        // ignore
      }
      currentUrl = new URL(location, currentUrl).toString();
    }
    throw new Error("unexpected redirect loop exit");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, timeoutMs, disableBrowserHeaders, controller) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fetchOnce(
        url,
        timeoutMs,
        disableBrowserHeaders,
        controller
      );
      return { ok: result, lastError: null };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.name === "AbortError") {
        return { ok: null, lastError };
      }
    }
  }
  return {
    ok: null,
    lastError: lastError ?? new Error("fetch failed"),
  };
}

async function readBodyWithCap(response, controller) {
  const body = response.body;
  if (!body) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > MAX_HTML_BYTES) {
          try {
            controller.abort();
          } catch {
            // ignore
          }
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          return { ok: false, reason: "too_large" };
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes: out };
}

// ---------------------------------------------------------------------------
// Main task body
// ---------------------------------------------------------------------------

async function runFetchArticle(input) {
  if (!input?.url) {
    return {
      finalUrl: null,
      message: "url is required",
      ok: false,
      reason: "fetch_failed",
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    return {
      finalUrl: null,
      message: `invalid URL: ${input.url}`,
      ok: false,
      reason: "fetch_failed",
    };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      finalUrl: input.url,
      message: `only http(s) URLs are supported; got ${parsedUrl.protocol}`,
      ok: false,
      reason: "fetch_failed",
    };
  }

  const timeoutMs = Math.min(
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );
  const disableBrowserHeaders = input.disableBrowserHeaders === true;

  const controller = new AbortController();
  const fetched = await fetchWithRetry(
    parsedUrl.toString(),
    timeoutMs,
    disableBrowserHeaders,
    controller
  );
  if (!fetched.ok) {
    const err = fetched.lastError;
    return {
      finalUrl: parsedUrl.toString(),
      message: err.message || "fetch failed",
      ok: false,
      reason: err.name === "AbortError" ? "timeout" : "fetch_failed",
    };
  }
  const response = fetched.ok.response;
  const finalUrl = fetched.ok.finalUrl;

  if (!response.ok) {
    return {
      finalUrl,
      message: `HTTP ${response.status} ${response.statusText}`,
      ok: false,
      reason: "http_error",
      status: response.status,
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const lowered = contentType.toLowerCase();
  const isHtmlLike =
    lowered.includes("text/html") ||
    lowered.includes("application/xhtml+xml") ||
    lowered.includes("application/xml") ||
    lowered.startsWith("text/");
  if (!isHtmlLike) {
    return {
      finalUrl,
      message: `unsupported content-type for article extraction: ${contentType || "(none)"}`,
      ok: false,
      reason: "unsupported_content_type",
    };
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
      return {
        finalUrl,
        message: `response body too large (declared ${declared} bytes; max ${MAX_HTML_BYTES})`,
        ok: false,
        reason: "response_too_large",
      };
    }
  }

  const body = await readBodyWithCap(response, controller);
  if (!body.ok) {
    return {
      finalUrl,
      message: `response body exceeded ${MAX_HTML_BYTES} bytes`,
      ok: false,
      reason: "response_too_large",
    };
  }
  const html = new TextDecoder().decode(body.bytes);

  if (lowered.startsWith("text/plain") || lowered.startsWith("text/markdown")) {
    const trimmed = html.trim();
    if (!trimmed) {
      return {
        finalUrl,
        message: "response body is empty",
        ok: false,
        reason: "not_article",
      };
    }
    return {
      byline: null,
      contentType,
      excerpt: null,
      finalUrl,
      length: trimmed.length,
      markdown: trimmed,
      ok: true,
      title: null,
    };
  }

  const article = extractArticle(html, finalUrl);
  if (!article) {
    return {
      finalUrl,
      message:
        "page is not article-shaped: Readability could not isolate a main content body (likely a homepage, nav page, or app shell)",
      ok: false,
      reason: "not_article",
    };
  }
  return {
    byline: article.byline,
    contentType,
    excerpt: article.excerpt,
    finalUrl,
    length: article.length,
    markdown: article.markdown,
    ok: true,
    title: article.title,
  };
}

// ---------------------------------------------------------------------------
// Worker message loop
// ---------------------------------------------------------------------------

if (!parentPort) {
  throw new Error("fetch-article must run as a worker_thread, not directly");
}

parentPort.on("message", async (input) => {
  try {
    const result = await runFetchArticle(input);
    parentPort.postMessage(result);
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
