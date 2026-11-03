// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones

import { describe, expect, it } from "vitest";
import {
  DiscoveryError,
  discoverModels,
  fetchGatewayModels,
  getDiscoveryState,
} from "../discovery.js";
import { fakeResponse, fetchJson, loadFixture, makeConfig, recordedFetch } from "./helpers.js";

const KEY = "sk-test-secret-key";

function envWithKey(key: string | undefined = KEY): NodeJS.ProcessEnv {
  return key ? { ISISLLM_API_KEY: key } : {};
}

/** Behaves like `fetch`: never settles on its own, rejects when the signal aborts. */
function neverSettlingFetch() {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const abort = () => reject(new Error("The operation was aborted"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    })) as unknown as typeof fetch;
}

describe("fetchGatewayModels", () => {
  it("returns the entries the gateway listed", async () => {
    const { fetchImpl, calls } = recordedFetch(fetchJson(loadFixture("models")));
    const entries = await fetchGatewayModels({
      modelsUrl: "https://gw.example.test/v1/models",
      apiKey: KEY,
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      "qwen3-coder-next",
      "qwen3.8-flash-next",
      "qwen3.8-27b",
      "qwen3-coder-next-4bit",
    ]);
    expect(calls[0]?.url).toBe("https://gw.example.test/v1/models");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("dedupes repeated ids", async () => {
    const { fetchImpl } = recordedFetch(fetchJson(loadFixture("models-extra")));
    const entries = await fetchGatewayModels({
      modelsUrl: "https://gw.example.test/v1/models",
      apiKey: KEY,
      timeoutMs: 1000,
      fetchImpl,
    });
    const ids = entries.map((entry) => entry.id);
    expect(ids.filter((id) => id === "qwen3-coder-next")).toHaveLength(1);
    expect(ids).not.toContain("");
  });

  it("classifies 401 as an auth problem and redacts the key", async () => {
    const { fetchImpl } = recordedFetch(
      fakeResponse({
        status: 401,
        body: `invalid key ${KEY}`,
        contentType: "application/json",
      }),
    );
    await expect(
      fetchGatewayModels({
        modelsUrl: "https://gw.example.test/v1/models",
        apiKey: KEY,
        timeoutMs: 1000,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ kind: "unauthorized" });

    const error = await fetchGatewayModels({
      modelsUrl: "https://gw.example.test/v1/models",
      apiKey: KEY,
      timeoutMs: 1000,
      fetchImpl,
    }).catch((caught: unknown) => caught as DiscoveryError);
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as DiscoveryError).message).not.toContain(KEY);
    expect((error as DiscoveryError).message).toContain("***");
  });

  it("treats an HTML body as a wrong base URL, not a model list", async () => {
    const { fetchImpl } = recordedFetch(
      fakeResponse({
        body: "<!doctype html><html><head>Open WebUI</head></html>",
        contentType: "text/html",
      }),
    );
    await expect(
      fetchGatewayModels({
        modelsUrl: "https://gw.example.test/v1",
        apiKey: KEY,
        timeoutMs: 1000,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ kind: "not_litellm" });
  });

  it("rejects JSON that is not an OpenAI model list", async () => {
    for (const body of ["not json at all", JSON.stringify({ models: [] })]) {
      const { fetchImpl } = recordedFetch(fakeResponse({ body, contentType: "application/json" }));
      await expect(
        fetchGatewayModels({
          modelsUrl: "https://gw.example.test/v1/models",
          apiKey: KEY,
          timeoutMs: 1000,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ kind: "not_litellm" });
    }
  });

  it("classifies connection failures and honours the timeout", async () => {
    const failing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND gw.example.test");
    }) as unknown as typeof fetch;
    await expect(
      fetchGatewayModels({
        modelsUrl: "https://gw.example.test/v1/models",
        apiKey: KEY,
        timeoutMs: 1000,
        fetchImpl: failing,
      }),
    ).rejects.toMatchObject({ kind: "network" });

    const hanging = neverSettlingFetch();
    await expect(
      fetchGatewayModels({
        modelsUrl: "https://gw.example.test/v1/models",
        apiKey: KEY,
        timeoutMs: 30,
        fetchImpl: hanging,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("passes pi's signal through so a cancelled refresh stops waiting", async () => {
    const controller = new AbortController();
    const hanging = neverSettlingFetch();
    controller.abort(new Error("session ended"));
    await expect(
      fetchGatewayModels({
        modelsUrl: "https://gw.example.test/v1/models",
        apiKey: KEY,
        timeoutMs: 5000,
        signal: controller.signal,
        fetchImpl: hanging,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("discoverModels", () => {
  it("builds pi models from the live list and records the run", async () => {
    const { fetchImpl } = recordedFetch(fetchJson(loadFixture("models-extra")));
    const models = await discoverModels({
      config: makeConfig(),
      env: envWithKey(),
      fetchImpl,
    });
    expect(models).toHaveLength(4);
    expect(models.every((model) => model.provider === "isisllm")).toBe(true);
    expect(models.some((model) => model.name.endsWith("(unverified)"))).toBe(true);
    expect(models.find((model) => model.id === "bge-m3")).toBeUndefined();

    const state = getDiscoveryState();
    expect(state.source).toBe("live");
    expect(state.error).toBeNull();
    expect(state.modelCount).toBe(models.length);
  });

  it("prefers the env var over a stored credential", async () => {
    const { fetchImpl, calls } = recordedFetch(fetchJson(loadFixture("models")));
    await discoverModels({
      config: makeConfig(),
      storedApiKey: "stored-key",
      env: envWithKey("env-key"),
      fetchImpl,
    });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer env-key");
  });

  it("uses a stored credential when the env var is absent", async () => {
    const { fetchImpl, calls } = recordedFetch(fetchJson(loadFixture("models")));
    await discoverModels({ config: makeConfig(), storedApiKey: "stored-key", env: {}, fetchImpl });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer stored-key",
    );
  });

  it("fails with an actionable message when no key exists", async () => {
    const { fetchImpl } = recordedFetch(fetchJson(loadFixture("models")));
    const error = await discoverModels({ config: makeConfig(), env: {}, fetchImpl }).catch(
      (caught: unknown) => caught as DiscoveryError,
    );
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as DiscoveryError).kind).toBe("no_key");
    expect((error as DiscoveryError).message).toContain("ISISLLM_API_KEY");
    expect(getDiscoveryState().error).toContain("ISISLLM_API_KEY");
  });

  it("honours a base URL override from pi's refresh context", async () => {
    const { fetchImpl, calls } = recordedFetch(fetchJson(loadFixture("models")));
    const models = await discoverModels({
      config: makeConfig(),
      baseUrl: "https://other.example.test/v1/",
      env: envWithKey(),
      fetchImpl,
    });
    expect(calls[0]?.url).toBe("https://other.example.test/v1/models");
    expect(models[0]?.baseUrl).toBe("https://other.example.test/v1");
  });
});
