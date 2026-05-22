// Phase 4f batch 1/2 — wfFetchArticleStep.
//
// Thin orchestrator: dispatches to the `fetch-article` worker (api.runTask).
// All heavy work — fetch + SSRF guard + jsdom/Readability/Turndown parsing —
// lives in src/workers/fetch-article.mjs and is externalised via
// `requiredNpmDeps` (4f batch 2). The host's worker pool runs the worker in
// a node:worker_threads sandbox so jsdom never blocks the request thread.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

export type WfFetchArticleInput = {
  url: string;
  timeoutMs?: number;
  disableBrowserHeaders?: boolean;
};

type FetchArticleSuccess = {
  byline: string | null;
  contentType: string;
  excerpt: string | null;
  finalUrl: string;
  length: number;
  markdown: string;
  ok: true;
  title: string | null;
};

type FetchArticleFailure = {
  finalUrl: string | null;
  ok: false;
  reason:
    | "fetch_failed"
    | "http_error"
    | "not_article"
    | "response_too_large"
    | "timeout"
    | "unsupported_content_type";
  message: string;
  status?: number;
};

type FetchArticleResult = FetchArticleSuccess | FetchArticleFailure;

// Host-side worker timeout: gives headroom over the worker's internal
// MAX_TIMEOUT_MS (60s fetch cap) for jsdom + Readability + Turndown parsing.
const HOST_TASK_TIMEOUT_MS = 90_000;

export async function wfFetchArticleStep({
  api,
  ctx,
}: RegistryStepInput): Promise<StepResult> {
  const input = ctx.input as Partial<WfFetchArticleInput>;
  if (!input.url || !input.url.trim()) {
    return {
      success: false,
      error: { message: "url is required" },
    };
  }

  let result: FetchArticleResult;
  try {
    result = (await api.runTask(
      "fetch-article",
      {
        url: input.url,
        timeoutMs: input.timeoutMs,
        disableBrowserHeaders: input.disableBrowserHeaders,
      },
      { timeoutMs: HOST_TASK_TIMEOUT_MS },
    )) as FetchArticleResult;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { success: false, error: { message: e.message } };
  }

  if (!result.ok) {
    return {
      success: false,
      error: { message: `${result.reason}: ${result.message}` },
    };
  }

  return {
    success: true,
    data: {
      byline: result.byline,
      contentType: result.contentType,
      excerpt: result.excerpt,
      finalUrl: result.finalUrl,
      length: result.length,
      markdown: result.markdown,
      title: result.title,
      url: input.url,
    },
  };
}
