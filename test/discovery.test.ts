// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones

import { describe, expect, it } from "vitest";
import {
  DiscoveryError,
  discoverModels,
  fetchGatewayCapabilities,
  fetchGatewayModels,
  getDiscoveryState,
  probeCapabilities,
  probeImageSupport,
} from "../discovery.js";
import {
  fakeResponse,
  fetchJson,
  handlerFetch,
  loadFixture,
  makeConfig,
  recordedFetch,
  routedFetch,
} from "./helpers.js";

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

const MODELS_URL = "https://gw.example.test/v1/models";
const INFO_URL = "https://gw.example.test/v1/model/info";
const CHAT_URL = "https://gw.example.test/v1/chat/completions";

const rejectsImages = () =>
  fakeResponse({
    status: 400,
    body: JSON.stringify({ error: { message: "not a multimodal model" } }),
    contentType: "application/json",
  });
const acceptsImages = () => fetchJson({ choices: [{ message: { content: "Red" } }] });

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

  it("asks the gateway what its models can ingest", async () => {
    const { fetchImpl, calls } = routedFetch({
      [MODELS_URL]: fetchJson(loadFixture("models-extra")),
      [INFO_URL]: fetchJson(loadFixture("model-info")),
    });
    const models = await discoverModels({ config: makeConfig(), env: envWithKey(), fetchImpl });

    expect(calls).toEqual([MODELS_URL, INFO_URL]);
    const byId = new Map(models.map((model) => [model.id, model]));
    // No capability flag on the /v1/models entry: only model/info vouches for it here.
    expect(byId.get("qwen3-vl-32b")?.input).toEqual(["text", "image"]);
    // The curated id the endpoint explicitly vetoes stays text-only.
    expect(byId.get("qwen3-coder-next")?.input).toEqual(["text"]);
    expect(getDiscoveryState().capabilities).toContain("image input reported for");
  });

  it("keeps curated image input when the gateway reports null (the real gateway shape)", async () => {
    // The ISIS gateway answers supports_vision: null for every model, so presets.json is the only
    // thing that knows qwen3.8-flash-next is served by a multimodal engine.
    const nulls = {
      data: ["qwen3.8-flash-next", "qwen3.8-27b", "qwen3-coder-next", "qwen3-coder-next-4bit"].map(
        (model_name) => ({ model_name, model_info: { supports_vision: null } }),
      ),
    };
    const { fetchImpl } = routedFetch({
      [MODELS_URL]: fetchJson(loadFixture("models")),
      [INFO_URL]: fetchJson(nulls),
    });
    const models = await discoverModels({ config: makeConfig(), env: envWithKey(), fetchImpl });
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("qwen3.8-flash-next")?.input).toEqual(["text", "image"]);
    expect(byId.get("qwen3.8-27b")?.input).toEqual(["text"]);
    expect(getDiscoveryState().capabilities).toContain("reported no capability flags");
  });

  it("keeps the model list when the capability endpoint is locked, missing, or slow", async () => {
    for (const [label, response] of [
      ["403", fakeResponse({ status: 403, body: `nope ${KEY}`, contentType: "application/json" })],
      ["html", fakeResponse({ body: "<!doctype html><html></html>", contentType: "text/html" })],
      ["junk", fakeResponse({ body: "not json", contentType: "application/json" })],
    ] as const) {
      const { fetchImpl } = routedFetch({
        [MODELS_URL]: fetchJson(loadFixture("models")),
        [INFO_URL]: response,
      });
      const models = await discoverModels({ config: makeConfig(), env: envWithKey(), fetchImpl });
      const byId = new Map(models.map((model) => [model.id, model]));
      expect(models, label).toHaveLength(4);
      // No verdicts, so the curated metadata decides: flash-next stays image-capable, the rest
      // stay text-only — and none of them silently gained images because the probe failed.
      expect(byId.get("qwen3.8-flash-next")?.input, label).toEqual(["text", "image"]);
      expect(byId.get("qwen3-coder-next")?.input, label).toEqual(["text"]);
      expect(byId.get("qwen3.8-27b")?.input, label).toEqual(["text"]);
      const note = getDiscoveryState().capabilities ?? "";
      expect(note, label).toContain("unavailable");
      expect(note, label).not.toContain(KEY);
    }
  });

  it("does not call the capability endpoint when settings turn it off", async () => {
    const { fetchImpl, calls } = routedFetch({
      [MODELS_URL]: fetchJson(loadFixture("models")),
      [INFO_URL]: fetchJson(loadFixture("model-info")),
    });
    const models = await discoverModels({
      config: makeConfig({ capabilities: "off" }),
      env: envWithKey(),
      fetchImpl,
    });
    expect(calls).toEqual([MODELS_URL]);
    // Curated metadata still applies with the probe off — it is only the gateway's word that is gone.
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("qwen3.8-flash-next")?.input).toEqual(["text", "image"]);
    expect(byId.get("qwen3-coder-next")?.input).toEqual(["text"]);
    expect(getDiscoveryState().capabilities).toContain("disabled by settings");
  });

  it("still fails on an unusable model list even if model/info would have worked", async () => {
    const { fetchImpl } = routedFetch({
      [MODELS_URL]: fakeResponse({ status: 401, body: "denied", contentType: "application/json" }),
      [INFO_URL]: fetchJson(loadFixture("model-info")),
    });
    await expect(
      discoverModels({ config: makeConfig(), env: envWithKey(), fetchImpl }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });
});

describe("fetchGatewayCapabilities", () => {
  it("merges the deployments behind each model id", async () => {
    const { fetchImpl, calls } = routedFetch({ [INFO_URL]: fetchJson(loadFixture("model-info")) });
    const result = await fetchGatewayCapabilities({
      infoUrl: INFO_URL,
      apiKey: KEY,
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(calls).toEqual([INFO_URL]);
    expect(result.capabilities["qwen3-vl-32b"]).toEqual({ image: true });
    expect(result.capabilities["mixed-group"]).toEqual({ image: false });
    expect(result.note).toContain("image input reported for 5/8 model(s)");
  });

  it("never throws: a locked endpoint degrades to a note", async () => {
    const { fetchImpl } = routedFetch({
      [INFO_URL]: fakeResponse({ status: 403, body: KEY, contentType: "application/json" }),
    });
    const result = await fetchGatewayCapabilities({
      infoUrl: INFO_URL,
      apiKey: KEY,
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(result.capabilities).toEqual({});
    expect(result.note).toContain("the key may not call it");
    expect(result.note).not.toContain(KEY);
  });

  it("never throws on a timeout or an unrouted host", async () => {
    const hanging = neverSettlingFetch();
    const timedOut = await fetchGatewayCapabilities({
      infoUrl: INFO_URL,
      apiKey: KEY,
      timeoutMs: 20,
      fetchImpl: hanging,
    });
    expect(timedOut.note).toContain("timed out");

    const unreachable = await fetchGatewayCapabilities({
      infoUrl: INFO_URL,
      apiKey: KEY,
      timeoutMs: 1000,
      fetchImpl: routedFetch({}).fetchImpl,
    });
    expect(unreachable.note).toContain("unreachable");
    expect(unreachable.capabilities).toEqual({});
  });
});

describe("probeImageSupport", () => {
  const base = { chatUrl: CHAT_URL, apiKey: KEY, model: "some-model", timeoutMs: 1000 };

  it("counts an accepted completion as image input, cheaply", async () => {
    const h = handlerFetch(acceptsImages);
    expect(await probeImageSupport({ ...base, fetchImpl: h.fetchImpl })).toBe(true);
    const call = h.calls[0];
    expect(call?.url).toBe(CHAT_URL);
    expect(call?.init.method).toBe("POST");
    expect((call?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(call?.body?.model).toBe("some-model");
    expect(call?.body?.max_tokens).toBe(1);
    expect(JSON.stringify(call?.body?.messages)).toContain("data:image/png;base64,");
  });

  it("reads a refusal of image content as false", async () => {
    for (const message of [
      "At most 0 image(s) may be provided in one prompt. (parameter=image)",
      "qwen3-coder-next is not a multimodal model",
      "this model does not support image inputs",
      "unsupported modality: vision",
    ]) {
      const h = handlerFetch(() =>
        fakeResponse({
          status: 400,
          body: JSON.stringify({ error: { message } }),
          contentType: "application/json",
        }),
      );
      expect(await probeImageSupport({ ...base, fetchImpl: h.fetchImpl }), message).toBe(false);
    }
  });

  it("says nothing when the exchange proves nothing about modalities", async () => {
    for (const [status, message] of [
      [400, "max_tokens must be at least 4"],
      [401, `invalid key ${KEY}`],
      [403, "key may not call this route"],
      [429, "rate limit exceeded"],
      [500, "upstream blew up"],
    ] as const) {
      const h = handlerFetch(() =>
        fakeResponse({
          status,
          body: JSON.stringify({ error: { message } }),
          contentType: "application/json",
        }),
      );
      expect(await probeImageSupport({ ...base, fetchImpl: h.fetchImpl }), `${status}`).toBe(
        undefined,
      );
    }

    const unreachable = await probeImageSupport({
      ...base,
      fetchImpl: routedFetch({}).fetchImpl,
    });
    expect(unreachable).toBeUndefined();

    const timedOut = await probeImageSupport({
      ...base,
      timeoutMs: 20,
      fetchImpl: neverSettlingFetch(),
    });
    expect(timedOut).toBeUndefined();
  });

  it("stops when the refresh is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("session ended"));
    const verdict = await probeImageSupport({
      ...base,
      signal: controller.signal,
      fetchImpl: neverSettlingFetch(),
    });
    expect(verdict).toBeUndefined();
  });
});

describe("probeCapabilities", () => {
  const base = { chatUrl: CHAT_URL, apiKey: KEY, timeoutMs: 1000 };

  it("asks once per model and caps what is in flight", async () => {
    const h = handlerFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return acceptsImages();
    });
    const result = await probeCapabilities({
      ...base,
      fetchImpl: h.fetchImpl,
      models: ["a", "b", "c", "d", "e", "f"],
    });
    expect(h.chats()).toHaveLength(6);
    expect(h.maxInFlight).toBeLessThanOrEqual(3);
    expect(result.note).toContain("6/6 probed model(s) accept images");
  });

  it("dedupes ids and reports no verdicts instead of guessing", async () => {
    const h = handlerFetch(() =>
      fakeResponse({ status: 401, body: "denied", contentType: "application/json" }),
    );
    const result = await probeCapabilities({
      ...base,
      fetchImpl: h.fetchImpl,
      models: ["a", "a", "b"],
    });
    expect(h.chats()).toHaveLength(2);
    expect(result.capabilities).toEqual({});
    expect(result.note).toContain("asked 2 model(s), none answered the question");
  });

  it("sends nothing when there is nothing to ask", async () => {
    const h = handlerFetch(acceptsImages);
    const result = await probeCapabilities({ ...base, fetchImpl: h.fetchImpl, models: [] });
    expect(h.calls).toEqual([]);
    expect(result).toEqual({ capabilities: {}, note: null });
  });
});

describe("capabilities: probe", () => {
  function gateway(options: {
    modelsBody?: unknown;
    infoBody?: unknown;
    accept?: (model: string) => boolean;
  }) {
    const {
      modelsBody = loadFixture("models-extra"),
      infoBody = {
        data: [
          { model_name: "qwen3-vl-32b", model_info: { supports_vision: true } },
          { model_name: "qwen3-coder-next", model_info: { supports_vision: false } },
        ],
      },
      accept = (model: string) => model === "llama-3.3-70b-instruct",
    } = options;
    return handlerFetch((url, init) => {
      if (url.endsWith("/models")) return fetchJson(modelsBody);
      if (url.endsWith("/model/info")) return fetchJson(infoBody);
      const model = String((JSON.parse(String(init.body)) as { model: string }).model);
      return accept(model) ? acceptsImages() : rejectsImages();
    });
  }

  it("probes only the models the gateway said nothing about", async () => {
    const h = gateway({});
    const models = await discoverModels({
      config: makeConfig({ capabilities: "probe" }),
      env: envWithKey(),
      fetchImpl: h.fetchImpl,
    });
    // qwen3-vl-32b (reported true) and qwen3-coder-next (reported false) already have an answer;
    // the embeddings/tts ids are excluded, so only the two unknowns cost a completion.
    expect(h.chats().sort()).toEqual(["deepseek-r1-distill", "llama-3.3-70b-instruct"]);
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("qwen3-vl-32b")?.input).toEqual(["text", "image"]);
    expect(byId.get("qwen3-coder-next")?.input).toEqual(["text"]);
    expect(byId.get("llama-3.3-70b-instruct")?.input).toEqual(["text", "image"]);
    expect(byId.get("deepseek-r1-distill")?.input).toEqual(["text"]);
    const note = getDiscoveryState().capabilities ?? "";
    expect(note).toContain("model/info: image input reported for 2/2 model(s)");
    expect(note).toContain("probe: 1/2 probed model(s) accept images");
  });

  it("lets a measured answer outrank curated metadata — in both directions", async () => {
    // The real gateway reports nothing, so the probe is the only source of truth: it promotes
    // qwen3.8-27b (curated text-only) and demotes qwen3.8-flash-next (curated image-capable).
    const nulls = {
      data: ["qwen3.8-flash-next", "qwen3.8-27b", "qwen3-coder-next", "qwen3-coder-next-4bit"].map(
        (model_name) => ({ model_name, model_info: { supports_vision: null } }),
      ),
    };
    const h = gateway({
      modelsBody: loadFixture("models"),
      infoBody: nulls,
      accept: (model) => model === "qwen3.8-27b",
    });
    const models = await discoverModels({
      config: makeConfig({ capabilities: "probe" }),
      env: envWithKey(),
      fetchImpl: h.fetchImpl,
    });
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("qwen3.8-27b")?.input).toEqual(["text", "image"]);
    expect(byId.get("qwen3.8-flash-next")?.input).toEqual(["text"]);
  });

  it("spends no completions in the default auto mode", async () => {
    const h = gateway({});
    await discoverModels({ config: makeConfig(), env: envWithKey(), fetchImpl: h.fetchImpl });
    expect(h.chats()).toEqual([]);
  });

  it("still returns the model list when every probe fails", async () => {
    const h = gateway({
      accept: () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const models = await discoverModels({
      config: makeConfig({ capabilities: "probe" }),
      env: envWithKey(),
      fetchImpl: h.fetchImpl,
    });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.input.includes("image"))).toBe(false);
  });
});
