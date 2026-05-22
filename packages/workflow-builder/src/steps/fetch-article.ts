// wfFetchArticleStep — registry port of plugins/workflow-builder/steps/fetch-article.
//
// The first-party implementation dispatched to `runWorkerTask("fetch-article", …)`
// so jsdom stayed off the main thread. Per the Phase 4e.4 handoff the registry
// build does NOT have the worker pool, so the parsing runs inline here:
//   - jsdom + @mozilla/readability + turndown are dynamic-imported lazily so
//     the bundle stays slim until the first call;
//   - SSRF guard (assertPublicUrl) and the streaming byte-cap reader are
//     inlined verbatim from the upstream helper file;
//   - we accept the request-timeout risk per the brief (jsdom parse on the
//     plugin host's event loop can block a 30s request).

import { lookup } from "node:dns/promises";
import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfFetchArticleInput = {
  url: string;
  timeoutMs?: number;
  disableBrowserHeaders?: boolean;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const MAX_HTML_BYTES = 4_000_000;
const MAX_REDIRECTS = 5;
const PORT_ALLOWLIST = new Set([80, 443, 8080, 8443, 8000, 3000, 8888]);
const CLOUD_METADATA_IPV4 = "169.254.169.254";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
};

// ---------------------------------------------------------------------------
// SSRF guard — inlined verbatim from backend/src/lib/utils/assert-public-url.ts
// ---------------------------------------------------------------------------

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      return null;
    }
    nums.push(n);
  }
  return nums;
}

function isLoopbackV4(parts: number[]): boolean {
  return parts[0] === 127;
}
function isUnspecifiedV4(parts: number[]): boolean {
  return parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0;
}
function isRfc1918V4(parts: number[]): boolean {
  if (parts[0] === 10) {
    return true;
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }
  return false;
}
function isLinkLocalV4(parts: number[]): boolean {
  return parts[0] === 169 && parts[1] === 254;
}
function isMulticastOrReservedV4(parts: number[]): boolean {
  return parts[0] >= 224;
}
function isCgnatV4(parts: number[]): boolean {
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
function isPrivateIpv4(ip: string): boolean {
  const parts = parseIpv4(ip);
  if (!parts) {
    return true;
  }
  return (
    isLoopbackV4(parts) ||
    isUnspecifiedV4(parts) ||
    isRfc1918V4(parts) ||
    isLinkLocalV4(parts) ||
    isMulticastOrReservedV4(parts) ||
    isCgnatV4(parts)
  );
}

function expandIpv6(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  const zone = ip.indexOf("%");
  if (zone >= 0) {
    ip = ip.slice(0, zone);
  }
  const lastColon = ip.lastIndexOf(":");
  if (lastColon >= 0 && ip.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(ip.slice(lastColon + 1));
    if (!v4) {
      return null;
    }
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const doubleColon = ip.indexOf("::");
  let head: string[];
  let tail: string[];
  if (doubleColon >= 0) {
    const before = ip.slice(0, doubleColon);
    const after = ip.slice(doubleColon + 2);
    head = before === "" ? [] : before.split(":");
    tail = after === "" ? [] : after.split(":");
    const missing = 8 - head.length - tail.length;
    if (missing < 0) {
      return null;
    }
    head = head.concat(new Array(missing).fill("0")).concat(tail);
  } else {
    head = ip.split(":");
    if (head.length !== 8) {
      return null;
    }
  }
  if (head.length !== 8) {
    return null;
  }
  const groups: number[] = [];
  for (const g of head) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) {
      return null;
    }
    groups.push(Number.parseInt(g, 16));
  }
  return groups;
}
function isPrivateIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (!groups) {
    return true;
  }
  const allZeroExceptLast =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0;
  if (allZeroExceptLast && (groups[7] === 0 || groups[7] === 1)) {
    return true;
  }
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    (groups[5] === 0 || groups[5] === 0xff_ff)
  ) {
    const v4 = [
      (groups[6] >> 8) & 0xff,
      groups[6] & 0xff,
      (groups[7] >> 8) & 0xff,
      groups[7] & 0xff,
    ];
    return (
      isLoopbackV4(v4) ||
      isUnspecifiedV4(v4) ||
      isRfc1918V4(v4) ||
      isLinkLocalV4(v4) ||
      isMulticastOrReservedV4(v4) ||
      isCgnatV4(v4)
    );
  }
  if ((groups[0] & 0xfe_00) === 0xfc_00) {
    return true;
  }
  if ((groups[0] & 0xff_c0) === 0xfe_80) {
    return true;
  }
  if ((groups[0] & 0xff_00) === 0xff_00) {
    return true;
  }
  if (groups[0] === 0x64 && groups[1] === 0xff_9b) {
    const v4 = [
      (groups[6] >> 8) & 0xff,
      groups[6] & 0xff,
      (groups[7] >> 8) & 0xff,
      groups[7] & 0xff,
    ];
    return (
      isLoopbackV4(v4) ||
      isUnspecifiedV4(v4) ||
      isRfc1918V4(v4) ||
      isLinkLocalV4(v4) ||
      isMulticastOrReservedV4(v4) ||
      isCgnatV4(v4)
    );
  }
  return false;
}
function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}
function isLiteralIp(host: string): "v4" | "v6" | null {
  if (parseIpv4(host)) {
    return "v4";
  }
  if (host.includes(":")) {
    return expandIpv6(host) ? "v6" : null;
  }
  return null;
}
function rejectPort(port: number): string | null {
  if (port === 0) {
    return "port 0 is not allowed";
  }
  if (PORT_ALLOWLIST.has(port)) {
    return null;
  }
  if (port < 1024) {
    return `port ${port} is restricted; allowed low ports: ${[...PORT_ALLOWLIST]
      .filter((p) => p < 1024)
      .sort((a, b) => a - b)
      .join(", ")}`;
  }
  return null;
}
async function assertPublicHost(host: string): Promise<void> {
  const cleaned = stripBrackets(host);
  if (!cleaned) {
    throw new Error("host is empty");
  }
  const literal = isLiteralIp(cleaned);
  if (literal === "v4" && cleaned === CLOUD_METADATA_IPV4) {
    throw new Error("host targets cloud metadata endpoint");
  }
  if (literal === "v4" && isPrivateIpv4(cleaned)) {
    throw new Error(`host ${cleaned} is in a private range`);
  }
  if (literal === "v6" && isPrivateIpv6(cleaned)) {
    throw new Error(`host ${cleaned} is in a private range`);
  }
  if (literal) {
    return;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(cleaned, { all: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DNS lookup failed for ${cleaned}: ${message}`);
  }
  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${cleaned}`);
  }
  for (const addr of addresses) {
    if (addr.address === CLOUD_METADATA_IPV4) {
      throw new Error(`host ${cleaned} resolves to cloud metadata endpoint`);
    }
    if (addr.family === 4 && isPrivateIpv4(addr.address)) {
      throw new Error(
        `host ${cleaned} resolves to private address ${addr.address}`
      );
    }
    if (addr.family === 6 && isPrivateIpv6(addr.address)) {
      throw new Error(
        `host ${cleaned} resolves to private address ${addr.address}`
      );
    }
  }
}
async function assertPublicUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`invalid URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `URL must use http: or https: (got ${url.protocol || "(empty)"})`
    );
  }
  const host = stripBrackets(url.hostname);
  if (!host) {
    throw new Error("URL has no hostname");
  }
  const portStr = url.port;
  if (portStr) {
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`URL has an invalid port: ${portStr}`);
    }
    const portError = rejectPort(port);
    if (portError) {
      throw new Error(portError);
    }
  }
  await assertPublicHost(host);
  return url;
}

// ---------------------------------------------------------------------------
// HTML → readable markdown — inlined from backend/src/lib/workers/tasks/html-to-markdown.ts
// jsdom + @mozilla/readability + turndown are lazy-imported on the first call.
// ---------------------------------------------------------------------------

interface ExtractDeps {
  // We type these as `unknown` constructors and any-cast at the call site so
  // the registry plugin builds even when the consumer host has not installed
  // these npm packages on the typecheck path. The runtime resolution still
  // happens via the host's package manager — see the runtime-deps note in
  // package.json.
  JSDOM: new (
    html: string,
    options?: Record<string, unknown>
  ) => { window: { document: unknown; close: () => void } };
  Readability: new (doc: unknown) => {
    parse: () => {
      byline?: string;
      content?: string;
      excerpt?: string;
      textContent?: string;
      title?: string;
    } | null;
  };
  turndown: { turndown: (html: string) => string };
}

let depsPromise: Promise<ExtractDeps> | null = null;

function loadDeps(): Promise<ExtractDeps> {
  if (!depsPromise) {
    depsPromise = (async () => {
      // Dynamic-import keeps these out of the cold-start path and tolerates a
      // missing install at typecheck time (they only land in the consumer's
      // node_modules at runtime). The `@ts-ignore` lines suppress "Cannot find
      // module 'jsdom'" errors during plugin typecheck — the registry plugin
      // ships against the host's installed packages.
      // @ts-ignore - resolved at runtime from the consumer's node_modules
      const jsdomMod = (await import("jsdom")) as { JSDOM: ExtractDeps["JSDOM"] };
      // @ts-ignore - resolved at runtime from the consumer's node_modules
      const readabilityMod = (await import("@mozilla/readability")) as {
        Readability: ExtractDeps["Readability"];
      };
      // @ts-ignore - resolved at runtime from the consumer's node_modules
      const turndownMod = (await import("turndown")) as {
        default: new (opts?: Record<string, unknown>) => {
          turndown: (html: string) => string;
        };
      };
      const TurndownCtor = turndownMod.default;
      return {
        JSDOM: jsdomMod.JSDOM,
        Readability: readabilityMod.Readability,
        turndown: new TurndownCtor({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
          bulletListMarker: "-",
        }),
      };
    })();
  }
  return depsPromise;
}

interface ExtractedArticle {
  byline: string | null;
  excerpt: string | null;
  length: number;
  markdown: string;
  title: string | null;
}

async function extractArticle(
  html: string,
  baseUrl: string
): Promise<ExtractedArticle | null> {
  const { JSDOM, Readability, turndown } = await loadDeps();
  let dom: { window: { document: unknown; close: () => void } };
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
// Worker body — fetch + retry + streamed byte cap. Inlined from
// plugins/workflow-builder/workers/tasks/fetch-article.ts.
// ---------------------------------------------------------------------------

interface FetchOk {
  finalUrl: string;
  response: Response;
}

async function fetchOnce(
  url: string,
  timeoutMs: number,
  disableBrowserHeaders: boolean,
  controller: AbortController
): Promise<FetchOk> {
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

async function fetchWithRetry(
  url: string,
  timeoutMs: number,
  disableBrowserHeaders: boolean,
  controller: AbortController
): Promise<{ ok: FetchOk; lastError: null } | { ok: null; lastError: Error }> {
  let lastError: Error | null = null;
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

async function readBodyWithCap(
  response: Response,
  controller: AbortController
): Promise<
  { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" }
> {
  const body = response.body;
  if (!body) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
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
// Step handler
// ---------------------------------------------------------------------------

export async function wfFetchArticleStep({
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as WfFetchArticleInput;
  try {
    if (!input.url?.trim()) {
      return {
        success: false,
        error: { message: "url is required" },
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.url);
    } catch {
      return {
        success: false,
        error: { message: `fetch_failed: invalid URL: ${input.url}` },
      };
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return {
        success: false,
        error: {
          message: `fetch_failed: only http(s) URLs are supported; got ${parsedUrl.protocol}`,
        },
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
      const reason = err.name === "AbortError" ? "timeout" : "fetch_failed";
      return {
        success: false,
        error: { message: `${reason}: ${err.message || "fetch failed"}` },
      };
    }
    const response = fetched.ok.response;
    const finalUrl = fetched.ok.finalUrl;

    if (!response.ok) {
      return {
        success: false,
        error: {
          message: `http_error: HTTP ${response.status} ${response.statusText}`,
        },
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
        success: false,
        error: {
          message: `unsupported_content_type: unsupported content-type for article extraction: ${contentType || "(none)"}`,
        },
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
          success: false,
          error: {
            message: `response_too_large: response body too large (declared ${declared} bytes; max ${MAX_HTML_BYTES})`,
          },
        };
      }
    }

    const body = await readBodyWithCap(response, controller);
    if (!body.ok) {
      return {
        success: false,
        error: {
          message: `response_too_large: response body exceeded ${MAX_HTML_BYTES} bytes`,
        },
      };
    }
    const html = new TextDecoder().decode(body.bytes);

    if (
      lowered.startsWith("text/plain") ||
      lowered.startsWith("text/markdown")
    ) {
      const trimmed = html.trim();
      if (!trimmed) {
        return {
          success: false,
          error: { message: "not_article: response body is empty" },
        };
      }
      return {
        success: true,
        data: {
          byline: null,
          contentType,
          excerpt: null,
          finalUrl,
          length: trimmed.length,
          markdown: trimmed,
          title: null,
          url: input.url,
        },
      };
    }

    const article = await extractArticle(html, finalUrl);
    if (!article) {
      return {
        success: false,
        error: {
          message:
            "not_article: page is not article-shaped: Readability could not isolate a main content body (likely a homepage, nav page, or app shell)",
        },
      };
    }
    return {
      success: true,
      data: {
        byline: article.byline,
        contentType,
        excerpt: article.excerpt,
        finalUrl,
        length: article.length,
        markdown: article.markdown,
        title: article.title,
        url: input.url,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
