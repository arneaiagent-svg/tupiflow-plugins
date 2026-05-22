import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PluginHostAPI, RegistryStepInput } from "@tupiflow-plugins/shared/host-api-types";
import { wfFetchModelsStep } from "../src/steps/fetch-models.ts";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function makeMockCtx(args: {
  integrationId: string;
  integrationType: string;
  modelType?: "chat" | "embeddings";
  credentials: Record<string, string | undefined>;
  fetchResponse: (url: string) => any;
}): { stepInput: RegistryStepInput; fetchCalls: FetchCall[] } {
  const fetchCalls: FetchCall[] = [];

  const stepInput: RegistryStepInput = {
    api: {
      db: {
        read: async (query: string, params: any[]) => {
          return [
            {
              id: args.integrationId,
              type: args.integrationType,
              user_id: "u-test",
            },
          ];
        },
        write: async () => {},
      },
      fetchCredentials: async (id: string) => {
        return args.credentials;
      },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input as any).url || input.toString();
        fetchCalls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => args.fetchResponse(url),
        } as any;
      },
    } as unknown as PluginHostAPI,
    ctx: {
      input: {
        modelIntegrationId: args.integrationId,
        modelType: args.modelType,
      },
      userId: "u-test",
      nodeId: "n-test",
      workflowId: "w-test",
      executionId: "exec-test",
    },
  };

  return { stepInput, fetchCalls };
}

test("wfFetchModelsStep - ollama chat models success", async () => {
  const { stepInput, fetchCalls } = makeMockCtx({
    integrationId: "int-ollama",
    integrationType: "agents_ollama",
    modelType: "chat",
    credentials: { baseURL: "http://my-ollama-host:11434/" },
    fetchResponse: (url) => {
      assert.equal(url, "http://my-ollama-host:11434/api/tags");
      return {
        models: [
          { name: "llama3:latest", details: { family: "llama" } },
          { name: "nomic-embed-text:latest", details: { family: "nomic-bert" } },
          { name: "mistral:latest", details: { family: "llama" } },
        ],
      };
    },
  });

  const result = await wfFetchModelsStep(stepInput);

  assert.equal(result.success, true);
  if (result.success) {
    const data = result.data as any;
    assert.equal(data.providerId, "ollama");
    assert.equal(data.modelType, "chat");
    assert.deepEqual(data.models, [
      { id: "llama3:latest", label: "llama3" },
      { id: "mistral:latest", label: "mistral" },
    ]); // sorted alphabetically by id: llama3 before mistral
  }

  assert.equal(fetchCalls.length, 1);
});

test("wfFetchModelsStep - ollama embedding models success via family and name heuristics", async () => {
  const { stepInput } = makeMockCtx({
    integrationId: "int-ollama",
    integrationType: "agents_ollama",
    modelType: "embeddings",
    credentials: { baseURL: "http://my-ollama-host:11434" },
    fetchResponse: (url) => {
      return {
        models: [
          { name: "llama3:latest", details: { family: "llama" } },
          { name: "my-custom-bge-model:latest", details: { family: "custom" } }, // matched via name "bge"
          { name: "nomic-embed-text:latest", details: { family: "nomic-bert" } }, // matched via family
          { model: "bert-model:latest", name: "bert-model", details: { family: "bert" } }, // matched via family + model key preference
        ],
      };
    },
  });

  const result = await wfFetchModelsStep(stepInput);

  assert.equal(result.success, true);
  if (result.success) {
    const data = result.data as any;
    assert.equal(data.modelType, "embeddings");
    assert.deepEqual(data.models, [
      { id: "bert-model:latest", label: "bert-model" },
      { id: "my-custom-bge-model:latest", label: "my-custom-bge-model" },
      { id: "nomic-embed-text:latest", label: "nomic-embed-text" },
    ]); // alpha sorted: bert-model, my-custom-bge-model, nomic-embed-text
  }
});
