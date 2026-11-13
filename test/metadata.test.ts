// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones

import { describe, expect, it } from "vitest";
import {
  buildModels,
  clampMaxTokens,
  inferReasoning,
  inferThinkingFormat,
  isCurated,
  isExcluded,
  parseGatewayEntry,
  prettifyName,
  toPiModel,
} from "../metadata.js";
import type { GatewayModelEntry } from "../types.js";
import { makeConfig, makeMetadataContext } from "./helpers.js";

function context() {
  return makeMetadataContext();
}

describe("curated metadata", () => {
  // The gateway is asked; it answers with these ids and no token limits, which is exactly the
  // case `presets.json` exists for.
  const models = buildModels(
    [
      { id: "qwen3-coder-next" },
      { id: "qwen3-coder-next-4bit" },
      { id: "qwen3.8-27b" },
      { id: "qwen3.8-flash-next" },
    ],
    makeMetadataContext(),
  );

  it("describes every curated model with curated metadata", () => {
    expect(models.map((model) => model.id)).toEqual([
      "qwen3-coder-next",
      "qwen3-coder-next-4bit",
      "qwen3.8-27b",
      "qwen3.8-flash-next",
    ]);
    // Fallback limits: reported max_input/max_output_tokens always win when present.
    const curatedLimits: Record<string, [number, number]> = {
      "qwen3-coder-next": [131072, 16384],
      "qwen3-coder-next-4bit": [131072, 16384],
      "qwen3.8-27b": [131072, 16384],
      "qwen3.8-flash-next": [262144, 131072],
    };
    for (const model of models) {
      expect(model.provider).toBe("isisllm");
      expect(model.api).toBe("openai-completions");
      expect(model.baseUrl).toBe("https://gw.example.test/v1");
      expect(model.reasoning).toBe(true);
      expect(model.input).toEqual(["text"]);
      expect([model.contextWindow, model.maxTokens]).toEqual(curatedLimits[model.id]);
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(model.compat?.maxTokensField).toBe("max_tokens");
      expect(model.compat?.sendSessionAffinityHeaders).toBe(true);
      expect(model.compat?.sessionAffinityFormat).toBe("openrouter");
      expect(model.compat?.thinkingFormat).toBe("qwen-chat-template");
      expect(model.name).not.toContain("(unverified)");
    }
  });

  it("names match the metadata users had in models.json", () => {
    expect(models.map((model) => model.name)).toEqual([
      "Qwen 3 Coder Next",
      "Qwen 3 Coder Next (4-bit)",
      "Qwen 3.8 27B (qwen38)",
      "Qwen 3.8 Flash Next",
    ]);
  });
});

describe("toPiModel", () => {
  it("enables affinity for newly discovered ISIS models without changing the presets", () => {
    const ctx = context();
    const before = structuredClone(ctx.presets);
    const model = toPiModel({ id: "new-team-model" }, ctx);
    expect(model.compat).toEqual({
      maxTokensField: "max_tokens",
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    });
    expect(ctx.presets).toEqual(before);
  });

  it("preserves curated compatibility and lets local settings override affinity defaults", () => {
    const ctx = makeMetadataContext({
      models: {
        "qwen3.8-27b": {
          compat: { sendSessionAffinityHeaders: false, sessionAffinityFormat: "openai-nosession" },
        },
      },
    });
    const model = toPiModel({ id: "qwen3.8-27b" }, ctx);
    expect(model.compat).toEqual({
      maxTokensField: "max_tokens",
      thinkingFormat: "qwen-chat-template",
      sendSessionAffinityHeaders: false,
      sessionAffinityFormat: "openai-nosession",
    });
  });

  it("clamps an output limit that equals the context window", () => {
    const model = toPiModel(
      { id: "qwen3-tiny", max_input_tokens: 131072, max_output_tokens: 131072 },
      context(),
    );
    expect(model.contextWindow).toBe(131072);
    expect(model.maxTokens).toBe(65536);
  });

  it("falls back to defaults when the gateway reports no limits", () => {
    const model = toPiModel({ id: "llama-3.3-70b-instruct" }, context());
    expect(model.contextWindow).toBe(131072);
    expect(model.maxTokens).toBe(16384);
    expect(model.name).toBe("Llama 3.3 70b Instruct (unverified)");
    expect(model.reasoning).toBe(false);
  });

  it("parses numeric token limits sent as strings", () => {
    const model = toPiModel(
      { id: "deepseek-r1-distill", max_input_tokens: 65536, max_output_tokens: 65536 },
      context(),
    );
    expect(model.contextWindow).toBe(65536);
    expect(model.maxTokens).toBe(32768);
    expect(model.reasoning).toBe(true);
    expect(model.compat?.thinkingFormat).toBe("deepseek");
  });

  it("follows the limits the gateway reports instead of the curated fallback", () => {
    const model = toPiModel(
      { id: "qwen3-coder-next", max_input_tokens: 262144, max_output_tokens: 262144 },
      context(),
    );
    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(131072);
  });

  it("keeps curated limits when the gateway reports none", () => {
    const model = toPiModel({ id: "qwen3.8-27b" }, context());
    expect(model.contextWindow).toBe(131072);
    expect(model.maxTokens).toBe(16384);
  });

  it("lets a settings override pin limits the gateway disagrees with", () => {
    const ctx = makeMetadataContext({
      models: { "qwen3-coder-next": { contextWindow: 32768, maxTokens: 8192 } },
    });
    const model = toPiModel(
      { id: "qwen3-coder-next", max_input_tokens: 262144, max_output_tokens: 262144 },
      ctx,
    );
    expect(model.contextWindow).toBe(32768);
    expect(model.maxTokens).toBe(8192);
  });

  it("leaves thinkingFormat unset for unknown families so pi auto-detects", () => {
    const model = toPiModel({ id: "mistral-small-3" }, context());
    expect(model.compat?.thinkingFormat).toBeUndefined();
    expect(model.compat?.maxTokensField).toBe("max_tokens");
  });

  it("applies local overrides last, merging compat per field", () => {
    const config = makeConfig({
      models: {
        "qwen3-coder-next": { name: "Team Coder", compat: { thinkingFormat: "openai" } },
        "brand-new-model": { reasoning: true, input: ["text", "image"], maxTokens: 4096 },
      },
    });
    const metadata = {
      baseUrl: config.baseUrl,
      presets: config.presets,
      overrides: config.settings.models,
    };

    const curated = toPiModel({ id: "qwen3-coder-next" }, metadata);
    expect(curated.name).toBe("Team Coder");
    expect(curated.compat?.thinkingFormat).toBe("openai");
    expect(curated.compat?.maxTokensField).toBe("max_tokens");

    const promoted = toPiModel({ id: "brand-new-model", max_input_tokens: 32768 }, metadata);
    expect(promoted.name).toBe("Brand New Model (unverified)");
    expect(promoted.reasoning).toBe(true);
    expect(promoted.input).toEqual(["text", "image"]);
    expect(promoted.contextWindow).toBe(32768);
    expect(promoted.maxTokens).toBe(4096);
    expect(isCurated("brand-new-model", metadata)).toBe(true);
  });
});

describe("heuristics", () => {
  const presets = makeConfig().presets;

  it("guesses reasoning from the id", () => {
    for (const id of [
      "qwen3-next",
      "qwen3-coder-mini",
      "deepseek-v3",
      "llama-r1-distill",
      "a-thinking-model",
    ]) {
      expect(inferReasoning(id, presets.reasoningPatterns)).toBe(true);
    }
    for (const id of ["llama-3.3-70b-instruct", "mistral-small-3", "gpt-4o", "phi-4"]) {
      expect(inferReasoning(id, presets.reasoningPatterns)).toBe(false);
    }
  });

  it("maps thinking formats by family", () => {
    expect(inferThinkingFormat("qwen3-vl-32b", presets.thinkingFormats)).toBe("qwen-chat-template");
    expect(inferThinkingFormat("deepseek-r1", presets.thinkingFormats)).toBe("deepseek");
    expect(inferThinkingFormat("gpt-oss-120b", presets.thinkingFormats)).toBeUndefined();
  });

  it("prettifies ids", () => {
    expect(prettifyName("qwen3-vl-32b")).toBe("Qwen3 Vl 32b");
    expect(prettifyName("gpt_oss_120b")).toBe("Gpt Oss 120b");
  });

  it("filters obvious non-chat deployments", () => {
    const metadata = context();
    for (const id of [
      "bge-m3",
      "bge-reranker-v2",
      "text-embedding-3-large",
      "kokoro-tts",
      "whisper-large-v3",
      "flux-dev",
      "dall-e-3",
    ]) {
      expect(isExcluded(id, metadata)).toBe(true);
    }
    for (const id of ["qwen3-coder-next", "llama-3.3-70b-instruct", "mistral-small-3"]) {
      expect(isExcluded(id, metadata)).toBe(false);
    }
  });

  it("never excludes curated or overridden ids, and honours extra patterns", () => {
    expect(
      isExcluded("bge-m3", { presets: makeConfig().presets, overrides: { "bge-m3": {} } }),
    ).toBe(false);
    expect(
      isExcluded("sandbox-debug", {
        presets: makeConfig().presets,
        overrides: {},
        excludeExtra: ["^sandbox-"],
      }),
    ).toBe(true);
  });

  it("clamps the completion budget into the shared window", () => {
    expect(clampMaxTokens(131072, 131072)).toBe(65536);
    expect(clampMaxTokens(10, 131072)).toBe(1024);
    expect(clampMaxTokens(200000, 131072)).toBe(65536);
    expect(clampMaxTokens(16384, 4096)).toBe(2048);
  });
});

describe("parseGatewayEntry", () => {
  it("accepts entries with usable ids", () => {
    expect(parseGatewayEntry({ id: " qwen3-x ", max_input_tokens: 4096 })).toEqual({
      id: "qwen3-x",
      max_input_tokens: 4096,
    });
  });

  it("rejects junk", () => {
    expect(parseGatewayEntry(null)).toBeNull();
    expect(parseGatewayEntry("qwen3-x")).toBeNull();
    expect(parseGatewayEntry({ id: "" })).toBeNull();
    expect(parseGatewayEntry({})).toBeNull();
    expect(parseGatewayEntry({ id: "x", max_input_tokens: -5 })).toEqual({ id: "x" });
  });
});

describe("buildModels", () => {
  const body = {
    data: [
      { id: "qwen3-coder-next", max_input_tokens: 131072, max_output_tokens: 131072 },
      { id: "qwen3-vl-32b", max_input_tokens: 262144, max_output_tokens: 262144 },
      { id: "llama-3.3-70b-instruct" },
      { id: "bge-m3" },
      { id: "text-embedding-3-large" },
      { id: "" },
      { id: "qwen3-coder-next", owned_by: "duplicate" },
    ],
  };

  it("registers exactly what the gateway reported, filtered and deduped", () => {
    const entries = body.data
      .map((entry) => parseGatewayEntry(entry))
      .filter((entry): entry is GatewayModelEntry => entry !== null);
    const models = buildModels(entries, context());
    expect(models.map((model) => model.id)).toEqual([
      "llama-3.3-70b-instruct",
      "qwen3-coder-next",
      "qwen3-vl-32b",
    ]);
    const vl = models.find((model) => model.id === "qwen3-vl-32b");
    expect(vl?.maxTokens).toBe(131072);
    expect(vl?.name).toBe("Qwen3 Vl 32b (unverified)");
  });

  it("drops curated models the gateway no longer serves", () => {
    const models = buildModels([{ id: "llama-3.3-70b-instruct" }], context());
    expect(models.map((model) => model.id)).toEqual(["llama-3.3-70b-instruct"]);
  });

  it("registers nothing when the gateway reports nothing", () => {
    expect(buildModels([], context())).toEqual([]);
  });
});
