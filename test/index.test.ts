// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extensionFactory, { readModelsJsonShadow } from "../index.js";
import { fetchJson, loadFixture } from "./helpers.js";

interface Harness {
  provider?: Provider;
  commands: Map<
    string,
    { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >;
  events: Map<string, (event: never, ctx: ExtensionContext) => Promise<void>>;
  sent: { customType: string; content: string }[];
}

function createPi(): { pi: ExtensionAPI; harness: Harness } {
  const harness: Harness = {
    commands: new Map(),
    events: new Map(),
    sent: [],
  };
  const pi = {
    registerProvider: (provider: Provider) => {
      harness.provider = provider;
    },
    registerCommand: (
      name: string,
      options: {
        description: string;
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      },
    ) => {
      harness.commands.set(name, options);
    },
    on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<void>) => {
      harness.events.set(event, handler);
    },
    sendMessage: (message: { customType: string; content: string }) => {
      harness.sent.push(message);
    },
  } as unknown as ExtensionAPI;
  return { pi, harness };
}

function createContext(
  options: {
    models?: unknown[];
    authSource?: string;
    mode?: "tui" | "print";
    refreshResult?: { aborted: boolean; errors: Map<string, Error> };
  } = {},
) {
  const notifications: { message: string; type?: string }[] = [];
  const widgets: [string, string[] | undefined][] = [];
  const refresh = vi.fn(async () => options.refreshResult ?? { aborted: false, errors: new Map() });
  const ctx = {
    modelRegistry: {
      getAvailable: () => options.models ?? [],
      refresh,
      getProviderAuth: vi.fn(async () =>
        options.authSource === undefined ? undefined : { auth: {}, source: options.authSource },
      ),
    },
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      setWidget: (key: string, content: string[] | undefined) => {
        widgets.push([key, content]);
      },
    },
  } as unknown as ExtensionContext;
  (ctx as { mode?: string }).mode = options.mode ?? "tui";
  return { ctx, notifications, widgets, refresh };
}

/** A chat model record good enough for pi's provider catalog bookkeeping. */
function modelFixture(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    provider: "isisllm",
    api: "openai-completions",
    baseUrl: "https://isisllm.rl.ac.uk/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384,
  };
}

/**
 * Simulate pi restoring its persisted catalog — what a cache-only startup refresh does. The
 * provider's live set becomes `models` with no network call, which is how any catalog appears:
 * the extension itself registers none (live-only).
 */
async function seedCatalog(provider: Provider | undefined, models: unknown[]): Promise<void> {
  await provider?.refreshModels?.({
    stored: { models },
    allowNetwork: false,
    signal: new AbortController().signal,
    publish: async (publication: { update: () => void }) => {
      publication.update();
      return true;
    },
  } as never);
}

function tempAgentDir(withModelsJson: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-isisllm-agent-"));
  tempAgentDirs.push(dir);
  mkdirSync(join(dir, "settings"), { recursive: true });
  if (withModelsJson) {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: { isisllm: { name: "ISIS LLM", models: [{ id: "qwen3-coder-next" }] } },
      }),
      "utf-8",
    );
  }
  return dir;
}

const tempAgentDirs: string[] = [];
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.PI_CODING_AGENT_DIR = tempAgentDir(false);
  delete process.env.ISISLLM_BASE_URL;
  delete process.env.ISISLLM_API_KEY;
});

afterEach(() => {
  while (tempAgentDirs.length) {
    const dir = tempAgentDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  process.env = { ...originalEnv };
});

describe("extension factory", () => {
  it("registers the isisllm provider with a live-only catalog", async () => {
    const { pi, harness } = createPi();
    await extensionFactory(pi);

    const provider = harness.provider;
    expect(provider?.id).toBe("isisllm");
    expect(provider?.name).toBe("ISIS LLM");
    expect(provider?.baseUrl).toBe("https://isisllm.rl.ac.uk/v1");
    expect(provider?.auth.apiKey).toBeDefined();
    // Nothing until the gateway answers: presets are metadata, never a registration list.
    expect(provider?.getModels()).toEqual([]);

    await seedCatalog(provider, [modelFixture("served-a"), modelFixture("served-b")]);
    expect(provider?.getModels().map((entry) => entry.id)).toEqual(["served-a", "served-b"]);
  });

  it("honours ISISLLM_BASE_URL", async () => {
    process.env.ISISLLM_BASE_URL = "https://gateway.internal/v1/";
    const { pi, harness } = createPi();
    await extensionFactory(pi);
    expect(harness.provider?.baseUrl).toBe("https://gateway.internal/v1");
  });

  it("defers the network refresh, then retries once if pi supersedes it", async () => {
    const { pi, harness } = createPi();
    await extensionFactory(pi);

    const { ctx, refresh } = createContext({ authSource: "ISISLLM_API_KEY" });
    let passes = 0;
    ctx.modelRegistry.refresh = async () => {
      passes++;
      return { aborted: passes === 1, errors: new Map() };
    };

    await harness.events.get("session_start")?.({} as never, ctx);
    // Deliberately deferred: pi fires its own cache-only passes around startup and each one
    // aborts an in-flight refresh for the same provider.
    expect(passes).toBe(0);
    await vi.waitFor(() => expect(passes).toBe(2), { timeout: 8000 });
  });

  it("renders the widget from the discovered catalog and clears it on input", async () => {
    const { pi, harness } = createPi();
    await extensionFactory(pi);
    await seedCatalog(harness.provider, [modelFixture("served-a")]);

    const { ctx, widgets } = createContext({ authSource: "ISISLLM_API_KEY" });
    await harness.events.get("session_start")?.({} as never, ctx);
    expect(widgets.at(-1)?.[1]?.[0]).toContain("ISIS LLM: 1 models");

    await harness.events.get("input")?.({} as never, ctx);
    expect(widgets.some(([, content]) => content === undefined)).toBe(true);
  });

  it("never awaits the refresh, even in print mode", async () => {
    const { pi, harness } = createPi();
    await extensionFactory(pi);

    const { ctx, refresh } = createContext({ authSource: "ISISLLM_API_KEY", mode: "print" });
    await harness.events.get("session_start")?.({} as never, ctx);
    // A forced refresh in flight while `pi -p` resolves its model makes the run print nothing at
    // all, so discovery stays off the critical path — the cold-start seed covers CLI startup.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says so in the widget while nothing has been discovered", async () => {
    const { pi, harness } = createPi();
    await extensionFactory(pi);

    const { ctx, widgets } = createContext({ authSource: "ISISLLM_API_KEY" });
    await harness.events.get("session_start")?.({} as never, ctx);
    expect(widgets.at(-1)?.[1]?.[0]).toContain("ISIS LLM: 0 models");
    expect(widgets.at(-1)?.[1]).toContain("  no live models yet — run /isisllm refresh");
  });

  it("notifies once when no key is configured", async () => {
    const { pi, harness } = createPi();
    await extensionFactory(pi);
    const first = createContext({});
    await harness.events.get("session_start")?.({} as never, first.ctx);
    await harness.events.get("session_start")?.({} as never, first.ctx);
    await vi.waitFor(
      () => {
        expect(
          first.notifications.filter((note) => note.message.includes("no API key")),
        ).toHaveLength(1);
      },
      { timeout: 8000 },
    );
    expect(first.notifications[0]?.type).toBe("warning");
  });
});

describe("cold start", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(body: unknown): string[] {
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return fetchJson(body);
    }) as unknown as typeof fetch;
    return calls;
  }

  it("seeds the catalog so --model resolves before any session event", async () => {
    process.env.ISISLLM_API_KEY = "seed-key";
    const calls = stubFetch(loadFixture("models"));

    const { pi, harness } = createPi();
    await extensionFactory(pi);

    expect(calls).toEqual(["https://isisllm.rl.ac.uk/v1/models"]);
    expect(harness.provider?.getModels().map((entry) => entry.id)).toEqual([
      "qwen3-coder-next",
      "qwen3-coder-next-4bit",
      "qwen3.8-27b",
      "qwen3.8-flash-next",
    ]);
  });

  it("skips the seed once pi has a cached catalog", async () => {
    process.env.ISISLLM_API_KEY = "seed-key";
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR as string, "models-store.json"),
      JSON.stringify({ isisllm: { models: [modelFixture("cached")], checkedAt: Date.now() } }),
      "utf-8",
    );
    const calls = stubFetch(loadFixture("models"));

    const { pi, harness } = createPi();
    await extensionFactory(pi);

    expect(calls).toEqual([]);
    expect(harness.provider?.getModels()).toEqual([]);
  });

  it("skips the seed without a key", async () => {
    const calls = stubFetch(loadFixture("models"));

    const { pi, harness } = createPi();
    await extensionFactory(pi);

    expect(calls).toEqual([]);
    expect(harness.provider?.getModels()).toEqual([]);
  });

  it("starts anyway when the seed fetch fails", async () => {
    process.env.ISISLLM_API_KEY = "seed-key";
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    const { pi, harness } = createPi();
    await extensionFactory(pi);

    expect(harness.provider?.getModels()).toEqual([]);
  });
});

describe("/isisllm", () => {
  const model = {
    id: "qwen3-coder-next",
    name: "Qwen 3 Coder Next",
    provider: "isisllm",
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 16384,
    compat: { thinkingFormat: "qwen-chat-template", maxTokensField: "max_tokens" },
  };
  const discovered = {
    id: "llama-3.3-70b",
    name: "Llama 3.3 70b (unverified)",
    provider: "isisllm",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 16384,
    compat: { maxTokensField: "max_tokens" },
  };

  async function run(
    subcommand: string,
    options?: Parameters<typeof createContext>[0] & { registered?: unknown[] },
  ) {
    const { pi, harness } = createPi();
    await extensionFactory(pi);
    const { registered = [model, discovered], ...contextOptions } = options ?? {};
    await seedCatalog(harness.provider, registered);
    const context = createContext({ models: [model, discovered], ...contextOptions });
    await harness.commands.get("isisllm")?.handler(subcommand, context.ctx);
    return { harness, ...context };
  }

  it("reports status with counts, endpoint and key source", async () => {
    const { notifications } = await run("", { authSource: "stored credential" });
    const message = notifications.at(-1)?.message ?? "";
    expect(message).toContain("2 models (1 curated, 1 unverified)");
    expect(message).toContain("https://isisllm.rl.ac.uk/v1/models");
    expect(message).toContain("stored credential");
    // Both registered models are selectable here, so there is no hidden-models note.
    expect(message).not.toContain("selectable right now");
  });

  it("notes models pi is hiding because credentials are missing", async () => {
    const { notifications } = await run("", {
      authSource: "stored credential",
      models: [model],
    });
    expect(notifications.at(-1)?.message).toContain("1/2 selectable right now");
  });

  it("warns when models.json shadows the extension", async () => {
    process.env.PI_CODING_AGENT_DIR = tempAgentDir(true);
    const { notifications } = await run("status", { authSource: "ISISLLM_API_KEY" });
    expect(notifications.at(-1)?.message).toContain('still defines "isisllm"');
  });

  it("prints a model table for `models`", async () => {
    const { harness } = await run("models");
    const content = harness.sent.at(-1)?.content ?? "";
    expect(content).toContain("thinkingFormat");
    expect(content).toContain("qwen3-coder-next");
    expect(content).toContain("128K");
    expect(content).toContain("qwen-chat-template");
  });

  it("forces a refresh and reports failures without losing models", async () => {
    const ok = await run("refresh", { authSource: "ISISLLM_API_KEY" });
    expect(ok.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["isisllm"], force: true, allowNetwork: true }),
    );
    expect(ok.notifications.at(-1)?.message).toContain("refreshed 2 models");

    const failing = await run("refresh", {
      authSource: "ISISLLM_API_KEY",
      refreshResult: {
        aborted: false,
        errors: new Map([["isisllm", new Error("401 from gateway")]]),
      },
    });
    expect(failing.notifications.at(-1)?.message).toContain("refresh failed — 401 from gateway");
    expect(failing.notifications.at(-1)?.message).toContain("keeping 2 model(s)");
  });

  it("runs doctor checks and explains a missing key", async () => {
    const { notifications } = await run("doctor");
    const message = notifications.at(-1)?.message ?? "";
    expect(message).toContain("- key: missing (export ISISLLM_API_KEY or use /login)");
    expect(message).toContain("- models.json: no conflicting entry");
    expect(message).toContain("- discovery: no API key");
    expect(message).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

describe("readModelsJsonShadow", () => {
  it("finds the isisllm block and ignores other providers", () => {
    const withShadow = tempAgentDir(true);
    expect(readModelsJsonShadow(withShadow)).toEqual({
      path: join(withShadow, "models.json"),
      modelIds: ["qwen3-coder-next"],
    });

    const withoutShadow = tempAgentDir(false);
    expect(readModelsJsonShadow(withoutShadow)).toBeUndefined();
    writeFileSync(
      join(withoutShadow, "models.json"),
      JSON.stringify({ providers: { other: { models: [{ id: "x" }] } } }),
      "utf-8",
    );
    expect(readModelsJsonShadow(withoutShadow)).toBeUndefined();
    writeFileSync(join(withoutShadow, "models.json"), "{ broken", "utf-8");
    expect(readModelsJsonShadow(withoutShadow)).toBeUndefined();
  });
});
