// Registry-port of plugins/workflow-builder/steps/fetch-models.{ts,impl.ts}.
//
// Source calls `fetchProviderModels()` from
// `backend/src/lib/ai-providers/models.ts` which carries provider-specific
// filtering (OPENAI_EXCLUDE / GROQ_EXCLUDE / Ollama family detection / etc).
// A registry plugin cannot import host internals; we replicate just enough
// per-provider logic to list chat / embedding models for the common
// `agents_<provider>` integrations. Unsupported providers return an empty
// list with a `warning` so callers can fall back.
//
// Integration row resolution: read `public.integrations` by id (the row
// carries `type` + ownership) and resolve the credential bag via
// `api.fetchCredentials` so the plaintext API key never crosses the
// cross-schema read boundary.

import type {
  RegistryStepInput,
  StepResult,
} from "@tupiflow-plugins/shared/host-api-types";

interface WfFetchModelsTypedInput {
  modelIntegrationId: string;
  modelType?: "chat" | "embeddings";
}

interface IntegrationRow {
  id: string;
  type: string;
  user_id: string;
}

interface ModelEntry {
  id: string;
  label: string;
}

const AGENTS_PREFIX = "agents_";
const LABEL_SPLIT_RE = /[-/]/;
const OPENAI_EXCLUDE =
  /^(dall-e|tts|whisper|text-embedding|omni-moderation|text-moderation|babbage|davinci|computer-use)/i;
const OPENAI_INCLUDE = /^(gpt|o1|o3|o4|chatgpt)/i;
const OPENAI_EMBEDDING_INCLUDE = /^text-embedding/i;

function toLabel(id: string): string {
  return id
    .split(LABEL_SPLIT_RE)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

interface OpenAiCompatibleListResponse {
  data?: Array<{ id: string }>;
}

async function fetchOpenAiCompatible(
  api: RegistryStepInput["api"],
  url: string,
  apiKey: string,
  filter?: (id: string) => boolean
): Promise<ModelEntry[]> {
  const res = await api.fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as OpenAiCompatibleListResponse;
  const ids = (body.data ?? []).map((m) => m.id).filter(Boolean);
  const filtered = filter ? ids.filter(filter) : ids;
  return filtered.map((id) => ({ id, label: toLabel(id) }));
}

interface AnthropicListResponse {
  data?: Array<{ id: string; display_name?: string }>;
}

async function fetchAnthropic(
  api: RegistryStepInput["api"],
  apiKey: string
): Promise<ModelEntry[]> {
  const res = await api.fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as AnthropicListResponse;
  return (body.data ?? [])
    .map((m) => ({
      id: m.id,
      label: m.display_name ?? toLabel(m.id),
    }))
    .filter((m) => m.id);
}

interface GoogleListResponse {
  models?: Array<{
    name: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
}

async function fetchGoogle(
  api: RegistryStepInput["api"],
  apiKey: string,
  modelType: "chat" | "embeddings"
): Promise<ModelEntry[]> {
  const res = await api.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
  );
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as GoogleListResponse;
  const wantsEmbeddings = modelType === "embeddings";
  return (body.models ?? [])
    .filter((m) => {
      const methods = m.supportedGenerationMethods ?? [];
      return wantsEmbeddings
        ? methods.includes("embedContent")
        : methods.includes("generateContent");
    })
    .map((m) => {
      const id = m.name.replace(/^models\//, "");
      return { id, label: m.displayName ?? toLabel(id) };
    });
}

function pickApiKey(
  credentials: Record<string, string | undefined>
): string | undefined {
  for (const v of Object.values(credentials)) {
    if (typeof v === "string" && v.trim()) {
      return v;
    }
  }
  return undefined;
}

interface DispatchResult {
  models: ModelEntry[];
  source: "live" | "fallback";
  warning?: string;
}

async function dispatchProvider(
  api: RegistryStepInput["api"],
  providerId: string,
  modelType: "chat" | "embeddings",
  apiKey: string,
  credentials?: Record<string, string | undefined>
): Promise<DispatchResult> {
  const sortAlpha = (m: ModelEntry[]): ModelEntry[] =>
    [...m].sort((a, b) => a.id.localeCompare(b.id));

  try {
    switch (providerId) {
      case "openai": {
        const filter =
          modelType === "embeddings"
            ? (id: string) => OPENAI_EMBEDDING_INCLUDE.test(id)
            : (id: string) =>
                OPENAI_INCLUDE.test(id) && !OPENAI_EXCLUDE.test(id);
        const models = await fetchOpenAiCompatible(
          api,
          "https://api.openai.com/v1/models",
          apiKey,
          filter
        );
        return { models: sortAlpha(models), source: "live" };
      }
      case "anthropic": {
        if (modelType === "embeddings") {
          return {
            models: [],
            source: "fallback",
            warning: "Anthropic does not expose embedding models.",
          };
        }
        const models = await fetchAnthropic(api, apiKey);
        return { models: sortAlpha(models), source: "live" };
      }
      case "google": {
        const models = await fetchGoogle(api, apiKey, modelType);
        return { models: sortAlpha(models), source: "live" };
      }
      case "groq": {
        const models = await fetchOpenAiCompatible(
          api,
          "https://api.groq.com/openai/v1/models",
          apiKey,
          (id) => !/whisper|tts/i.test(id)
        );
        return { models: sortAlpha(models), source: "live" };
      }
      case "mistral": {
        const exclude = /embed|moderation/i;
        const include = /embed/i;
        const filter =
          modelType === "embeddings"
            ? (id: string) => include.test(id)
            : (id: string) => !exclude.test(id);
        const models = await fetchOpenAiCompatible(
          api,
          "https://api.mistral.ai/v1/models",
          apiKey,
          filter
        );
        return { models: sortAlpha(models), source: "live" };
      }
      case "deepseek": {
        const models = await fetchOpenAiCompatible(
          api,
          "https://api.deepseek.com/v1/models",
          apiKey
        );
        return { models: sortAlpha(models), source: "live" };
      }
      case "xai": {
        const models = await fetchOpenAiCompatible(
          api,
          "https://api.x.ai/v1/models",
          apiKey
        );
        return { models: sortAlpha(models), source: "live" };
      }
      case "openrouter": {
        const models = await fetchOpenAiCompatible(
          api,
          "https://openrouter.ai/api/v1/models",
          apiKey
        );
        return { models: sortAlpha(models), source: "live" };
      }
      case "ai-gateway": {
        // Vercel AI Gateway exposes an OpenAI-compatible /v1/models surface.
        const models = await fetchOpenAiCompatible(
          api,
          "https://ai-gateway.vercel.sh/v1/models",
          apiKey,
          modelType === "embeddings"
            ? (id) => /embed/i.test(id)
            : (id) => !/embed/i.test(id)
        );
        return { models: sortAlpha(models), source: "live" };
      }
      case "ollama": {
        const baseURL = credentials?.baseURL?.trim() || "http://localhost:11434";
        const cleanBaseUrl = baseURL.replace(/\/+$/, "");
        const res = await api.fetch(`${cleanBaseUrl}/api/tags`);
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as {
          models?: Array<{
            model?: string;
            name: string;
            details?: { family?: string; families?: string[] };
          }>;
        };

        const OLLAMA_LATEST_TAG_RE = /:latest$/;
        const OLLAMA_EMBEDDING_NAME_RE = /embed|bge|nomic|mxbai/i;
        const OLLAMA_EMBEDDING_FAMILIES = new Set(["bert", "nomic-bert"]);

        interface OllamaModelEntry {
          id: string;
          label: string;
          family?: string;
          families?: string[];
        }

        const tags: OllamaModelEntry[] = (body.models ?? []).map((m) => {
          const id = m.model ?? m.name;
          return {
            id,
            label: id.replace(OLLAMA_LATEST_TAG_RE, ""),
            family: m.details?.family,
            families: m.details?.families,
          };
        });

        const isOllamaEmbedding = (m: OllamaModelEntry): boolean => {
          if (m.family && OLLAMA_EMBEDDING_FAMILIES.has(m.family)) {
            return true;
          }
          if (m.families?.some((f) => OLLAMA_EMBEDDING_FAMILIES.has(f))) {
            return true;
          }
          return OLLAMA_EMBEDDING_NAME_RE.test(m.id);
        };

        const wantsEmbeddings = modelType === "embeddings";
        const filtered = tags
          .filter((m) => wantsEmbeddings ? isOllamaEmbedding(m) : !isOllamaEmbedding(m))
          .map(({ id, label }) => ({ id, label }));

        return { models: sortAlpha(filtered), source: "live" };
      }
      default:
        return {
          models: [],
          source: "fallback",
          warning: `Provider "${providerId}" is not supported by the registry-plugin port of fetch_models. Common providers: openai, anthropic, google, groq, mistral, deepseek, xai, openrouter, ai-gateway, ollama.`,
        };
    }
  } catch (error) {
    return {
      models: [],
      source: "fallback",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function wfFetchModelsStep(
  input: RegistryStepInput
): Promise<StepResult> {
  const { api, ctx } = input;
  const typedInput = (ctx.input ?? {}) as unknown as WfFetchModelsTypedInput;
  try {
    const integrationId = typedInput.modelIntegrationId?.trim();
    if (!integrationId) {
      return {
        success: false,
        error: { message: "modelIntegrationId is required" },
      };
    }

    const rows = await api.db.read<IntegrationRow>(
      `SELECT id, type, user_id
       FROM public.integrations
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [integrationId, ctx.userId]
    );
    const integration = rows[0];
    if (!integration) {
      return {
        success: false,
        error: { message: `Integration ${integrationId} not found.` },
      };
    }

    if (!integration.type.startsWith(AGENTS_PREFIX)) {
      return {
        success: false,
        error: {
          message: `Integration ${integrationId} is type "${integration.type}", which is not an AI provider connection. fetch_models only works for integrations whose type begins with "${AGENTS_PREFIX}" (e.g. agents_ai-gateway, agents_openai). Use list_integrations and filter for the agents_* types.`,
        },
      };
    }

    const providerId = integration.type.slice(AGENTS_PREFIX.length);
    const modelType: "chat" | "embeddings" =
      typedInput.modelType === "embeddings" ? "embeddings" : "chat";

    const credentials = await api.fetchCredentials(integrationId);
    let apiKey = "";
    if (providerId !== "ollama") {
      const key = pickApiKey(credentials);
      if (!key) {
        return {
          success: false,
          error: {
            message: `Integration ${integrationId} has no API key configured. Add the provider's API key in Project Integrations.`,
          },
        };
      }
      apiKey = key;
    }

    const dispatched = await dispatchProvider(
      api,
      providerId,
      modelType,
      apiKey,
      credentials
    );

    return {
      success: true,
      data: {
        integrationId,
        integrationType: integration.type,
        models: dispatched.models,
        modelType,
        providerId,
        source: dispatched.source,
        warning: dispatched.warning,
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
