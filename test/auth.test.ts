// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones

import type { AuthContext, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { STORED_SOURCE_LABEL, createApiKeyAuth, hasEnvApiKey } from "../auth.js";
import { makeConfig } from "./helpers.js";

function authContext(env: Record<string, string | undefined>): AuthContext {
  return {
    env: async (name: string) => env[name],
    fileExists: async () => false,
  };
}

function interaction(prompt: ProviderAuthInteraction["prompt"]): ProviderAuthInteraction {
  return { prompt, notify: () => {}, signal: new AbortController().signal };
}

const config = makeConfig();
const auth = createApiKeyAuth(config);
const signal = new AbortController().signal;

describe("apiKeyAuth.resolve", () => {
  it("prefers the environment variable and labels it", async () => {
    const result = await auth.resolve({
      ctx: authContext({ ISISLLM_API_KEY: "  env-key  " }),
      credential: { type: "api_key", key: "stored-key" },
      signal,
    });
    expect(result?.auth.apiKey).toBe("env-key");
    expect(result?.source).toBe("ISISLLM_API_KEY");
  });

  it("falls back to the stored credential", async () => {
    const result = await auth.resolve({
      ctx: authContext({ ISISLLM_API_KEY: "   " }),
      credential: { type: "api_key", key: "stored-key" },
      signal,
    });
    expect(result?.auth.apiKey).toBe("stored-key");
    expect(result?.source).toBe(STORED_SOURCE_LABEL);
  });

  it("reports unconfigured when there is no key anywhere", async () => {
    await expect(auth.resolve({ ctx: authContext({}), signal })).resolves.toBeUndefined();
  });
});

describe("apiKeyAuth.login", () => {
  it("asks for the key through a masked prompt and stores an api_key credential", async () => {
    const prompt = vi.fn(async () => "  pasted-key\n");
    const credential = await auth.login?.(interaction(prompt));
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ type: "secret", message: expect.stringContaining("ISIS LLM") }),
    );
    expect(credential).toEqual({ type: "api_key", key: "pasted-key" });
  });

  it("fails instead of storing an empty credential", async () => {
    await expect(auth.login?.(interaction(async () => "   "))).rejects.toThrow(/ISIS LLM API key/);
  });
});

describe("apiKeyAuth.check", () => {
  it("reports the source, or nothing when unconfigured", async () => {
    await expect(
      auth.check?.({ ctx: authContext({ ISISLLM_API_KEY: "k" }), signal }),
    ).resolves.toMatchObject({ type: "api_key", source: "ISISLLM_API_KEY" });
    await expect(
      auth.check?.({
        ctx: authContext({}),
        credential: { type: "api_key", key: "stored" },
        signal,
      }),
    ).resolves.toMatchObject({ type: "api_key", source: STORED_SOURCE_LABEL });
    await expect(auth.check?.({ ctx: authContext({}), signal })).resolves.toBeUndefined();
  });
});

describe("hasEnvApiKey", () => {
  it("never exposes the value", () => {
    expect(hasEnvApiKey(config, { ISISLLM_API_KEY: "k" })).toBe(true);
    expect(hasEnvApiKey(config, { ISISLLM_API_KEY: " " })).toBe(false);
    expect(hasEnvApiKey(config, {})).toBe(false);
  });
});
