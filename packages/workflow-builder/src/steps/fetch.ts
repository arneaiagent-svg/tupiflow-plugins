import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfFetchInput = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string | Record<string, unknown>;
  responseType?: "auto" | "json" | "text";
  timeoutMs?: number;
  disableBrowserHeaders?: boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 2_000_000;

const MAC_CHROME_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua":
    '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

function buildUrl(url: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) {
    return url;
  }
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

function mergeBrowserHeaders(
  caller: Record<string, string>
): Record<string, string> {
  const lowerKeys = new Set(Object.keys(caller).map((k) => k.toLowerCase()));
  const merged: Record<string, string> = { ...caller };
  for (const [k, v] of Object.entries(MAC_CHROME_HEADERS)) {
    if (!lowerKeys.has(k.toLowerCase())) {
      merged[k] = v;
    }
  }
  return merged;
}

export async function wfFetchStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as WfFetchInput;
  try {
    if (!input.url) {
      return {
        success: false,
        error: { message: "url is required" },
      };
    }

    const method = (input.method ?? "GET").toUpperCase();
    const responseType = input.responseType ?? "auto";
    const timeoutMs = Math.min(
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );

    const finalUrl = buildUrl(input.url, input.query);
    const callerHeaders: Record<string, string> = {
      ...(input.headers ?? {}),
    };
    const headers = input.disableBrowserHeaders
      ? callerHeaders
      : mergeBrowserHeaders(callerHeaders);

    let body: BodyInit | undefined;
    if (input.body !== undefined && method !== "GET" && method !== "HEAD") {
      if (typeof input.body === "string") {
        body = input.body;
      } else {
        body = JSON.stringify(input.body);
        if (
          !Object.keys(headers).some(
            (h) => h.toLowerCase() === "content-type"
          )
        ) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await api.fetch(finalUrl, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const respHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });

    const contentType = response.headers.get("content-type") ?? "";

    const buf = await response.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return {
        success: false,
        error: {
          message: `Response body too large (${buf.byteLength} bytes; max ${MAX_BODY_BYTES}).`,
        },
      };
    }
    const text = new TextDecoder().decode(buf);

    let parsedBody: unknown = text;
    const wantJson =
      responseType === "json" ||
      (responseType === "auto" && contentType.includes("application/json"));
    if (wantJson && text.length > 0) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = text;
      }
    }

    return {
      success: true,
      data: {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: respHeaders,
        body: parsedBody,
        contentType,
        url: response.url || finalUrl,
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
