// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones
/**
 * pi-isisllm — register the ISIS LLM LiteLLM gateway in pi without a `models.json`.
 *
 * The factory registers a native provider whose model list is **exactly** what the gateway's
 * `GET /v1/models` reports: nothing is registered until the gateway answers, and a model the
 * gateway stops serving disappears on the next refresh. `presets.json` only supplies metadata
 * (display name, reasoning, token fallbacks) for the ids currently being served.
 *
 * pi owns caching: the discovered list is persisted to `~/.pi/agent/models-store.json` and restored
 * on the next cache-only startup, so `/model` is populated offline with the last known live set.
 * Nothing here ever writes `models.json` or a credential file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createApiKeyAuth, hasEnvApiKey } from "./auth.js";
import { loadConfig } from "./config.js";
import { discoverModels, getDiscoveryState, recordDiscoveryError } from "./discovery.js";
import type { ChatModel } from "./types.js";
import { type IsisllmConfig, type ModelSource, PROVIDER_ID, PROVIDER_NAME } from "./types.js";

const WIDGET_KEY = "pi-isisllm";
const UNVERIFIED_SUFFIX = " (unverified)";
/** Deadline for the one-off cold-start fetch in the factory; startup must not hang on it. */
const SEED_TIMEOUT_MS = 4000;

/** `models.json` layers above extension providers, so a stale `isisllm` block shadows discovery. */
export function readModelsJsonShadow(
  dir = getAgentDir(),
): { path: string; modelIds: string[] } | undefined {
  const path = join(dir, "models.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const providers = (parsed as { providers?: unknown }).providers;
    if (typeof providers !== "object" || providers === null) return undefined;
    const block = (providers as Record<string, unknown>)[PROVIDER_ID];
    if (typeof block !== "object" || block === null) return undefined;
    const models = (block as { models?: unknown }).models;
    const modelIds = Array.isArray(models)
      ? models
          .map((model) =>
            typeof model === "object" && model ? (model as { id?: unknown }).id : undefined,
          )
          .filter((id): id is string => typeof id === "string")
      : [];
    return { path, modelIds };
  } catch {
    return undefined;
  }
}

/** pi's persisted catalog: `{ [providerId]: { models: [...], checkedAt } }`. */
function hasCachedIsisllmCatalog(dir = getAgentDir()): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "models-store.json"), "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const entry = (parsed as Record<string, unknown>)[PROVIDER_ID];
    if (typeof entry !== "object" || entry === null) return false;
    return (
      Array.isArray((entry as { models?: unknown }).models) &&
      (entry as { models: unknown[] }).models.length > 0
    );
  } catch {
    return false;
  }
}

function formatAge(timestamp: number | null): string {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function isUnverified(model: Model<string>): boolean {
  return model.name.endsWith(UNVERIFIED_SUFFIX);
}

/**
 * Where the models on screen came from. `live` once this process has fetched the gateway list;
 * `cached` when pi restored its persisted catalog but the fetch has not succeeded (or has not run)
 * yet; `none` when there is nothing to show.
 */
function modelSource(models: Model<string>[]): ModelSource {
  if (getDiscoveryState().source === "live") return "live";
  return models.length > 0 ? "cached" : "none";
}

interface RefreshOutcome {
  ok: boolean;
  error?: string;
  /** The pass was aborted — normally because a newer refresh superseded it. */
  aborted: boolean;
  models: Model<string>[];
}

/** A timer that never keeps the process alive: pi may exit while discovery is pending. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * pi throws when a captured `ctx` is dereferenced after the session is replaced or a print
 * run ends. Anything that survives an await — above all the un-awaited startup refresh —
 * grabs these services up front instead of touching `ctx` later.
 */
type Services = Pick<ExtensionContext, "modelRegistry" | "ui">;

function servicesOf(ctx: ExtensionContext): Services {
  return { modelRegistry: ctx.modelRegistry, ui: ctx.ui };
}

/** Force a network refresh of this provider only, with our own deadline. */
async function refreshProvider(
  services: Pick<Services, "modelRegistry">,
  config: IsisllmConfig,
  registered: () => Model<string>[],
): Promise<RefreshOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("ISIS LLM model refresh timed out", "TimeoutError")),
    config.timeoutMs + 2000,
  );
  try {
    const result = await services.modelRegistry.refresh({
      providers: [PROVIDER_ID],
      force: true,
      allowNetwork: true,
      signal: controller.signal,
    });
    const error = result.errors.get(PROVIDER_ID);
    if (error) recordDiscoveryError(error.message);
    return {
      ok: !error && !result.aborted,
      aborted: result.aborted,
      ...(error ? { error: error.message } : {}),
      models: registered(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function describeKey(
  services: Pick<Services, "modelRegistry">,
  config: IsisllmConfig,
): Promise<string> {
  if (hasEnvApiKey(config)) return config.apiKeyEnv;
  const auth = await services.modelRegistry.getProviderAuth(PROVIDER_ID).catch(() => undefined);
  return auth?.source ?? "missing";
}

function statusLines(
  config: IsisllmConfig,
  models: Model<string>[],
  keySource: string,
  note?: string,
): string[] {
  const state = getDiscoveryState();
  const unverified = models.filter(isUnverified).length;
  const lines = [
    `${PROVIDER_NAME}: ${models.length} models (${models.length - unverified} curated, ${unverified} unverified) · ${modelSource(models)} · refreshed ${formatAge(state.at)}`,
    `  endpoint ${config.modelsUrl} · key ${keySource}`,
  ];
  if (models.length === 0) {
    lines.push(
      `  no live models yet — ${keySource === "missing" ? "set a key, then" : "run"} /isisllm refresh`,
    );
  }
  if (note) lines.push(note);
  if (state.error) lines.push(`  last error: ${state.error}`);
  for (const warning of config.warnings) lines.push(`  warning: ${warning}`);
  return lines;
}

function modelTable(models: Model<string>[]): string[] {
  if (models.length === 0)
    return ["No ISIS LLM models registered — nothing has been discovered from the gateway yet."];
  const rows = models.map((model) => {
    const compat = model.compat as { thinkingFormat?: string; maxTokensField?: string } | undefined;
    return [
      model.id,
      model.reasoning ? "yes" : "no",
      `${Math.round(model.contextWindow / 1024)}K`,
      `${Math.round(model.maxTokens / 1024)}K`,
      compat?.thinkingFormat ?? "auto",
      compat?.maxTokensField ?? "auto",
    ];
  });
  const widths = rows.reduce<number[]>(
    (widths, row) => widths.map((width, column) => Math.max(width, row[column]?.length ?? 0)),
    [0, 0, 0, 0, 0, 0],
  );
  const header = ["model", "think", "ctx", "max-out", "thinkingFormat", "maxTokensField"];
  const format = (cells: string[]) =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? cell.length),
      )
      .join("  ");
  return [format(header), format(widths.map((width) => "-".repeat(width))), ...rows.map(format)];
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = loadConfig();

  /**
   * Cold-start seed. pi resolves `--model` and renders `--list-models` before any session event,
   * so on a machine that has never discovered anything the gateway is asked once, here, with a
   * short deadline. Once pi has a persisted catalog this never runs: the cache carries the last
   * known live set and the session refresh replaces it.
   */
  let seed: ChatModel[] = [];
  if (!hasCachedIsisllmCatalog() && hasEnvApiKey(config)) {
    seed = await discoverModels({ config, timeoutMs: SEED_TIMEOUT_MS }).catch(() => []);
  }

  const provider = createProvider<"openai-completions">({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: config.baseUrl,
    auth: { apiKey: createApiKeyAuth(config) },
    // Live-only catalog: what the gateway reported, never a hand-written list.
    models: seed,
    api: openAICompletionsApi(),
    fetchModels: async (context) => {
      const credential = context.credential;
      const storedApiKey = credential?.type === "api_key" ? credential.key : undefined;
      return discoverModels({
        config,
        ...(storedApiKey ? { storedApiKey } : {}),
        signal: context.signal,
        baseUrl: context.baseUrl ?? config.baseUrl,
      });
    },
  });

  pi.registerProvider(provider);

  let startupRefreshed = false;
  let notifiedMissingKey = false;

  /**
   * Registered models, i.e. what this extension contributed. `getAvailable()` is narrower: pi
   * hides models whose provider has no usable credentials, so it would read "0 models" while
   * the user is still signing in.
   */
  const catalog = (): Model<string>[] => [...provider.getModels()];

  const availabilityNote = (services: Services): string | undefined => {
    const available = services.modelRegistry
      .getAvailable()
      .filter((model) => model.provider === PROVIDER_ID).length;
    const registered = provider.getModels().length;
    return available < registered
      ? `  ${available}/${registered} selectable right now — the rest stay hidden until an API key is configured`
      : undefined;
  };

  /**
   * pi aborts an in-flight refresh as soon as another pass starts for the same provider —
   * including its own cache-only passes fired around startup and session events. Wait out that
   * burst, and retry once if our pass gets superseded anyway.
   */
  const STARTUP_DELAY_MS = 750;
  const RETRY_DELAY_MS = 1500;

  async function startupRefresh(services: Services): Promise<void> {
    await sleep(STARTUP_DELAY_MS);
    if ((await refreshAndRender(services)).aborted) {
      await sleep(RETRY_DELAY_MS);
      await refreshAndRender(services);
    }
  }

  async function refreshAndRender(services: Services): Promise<RefreshOutcome> {
    let outcome: RefreshOutcome;
    try {
      outcome = await refreshProvider(services, config, catalog);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { ok: false, aborted: false, error: message, models: catalog() };
    }
    try {
      const keySource = await describeKey(services, config);
      services.ui.setWidget(
        WIDGET_KEY,
        statusLines(config, catalog(), keySource, availabilityNote(services)),
      );
      if (keySource === "missing" && !notifiedMissingKey) {
        notifiedMissingKey = true;
        services.ui.notify(
          `ISIS LLM: no API key — export ${config.apiKeyEnv} or run /login and choose "${PROVIDER_NAME}" to discover models.`,
          "warning",
        );
      }
    } catch {
      // The session was replaced, or the run ended, while we were refreshing: nothing to paint.
    }
    return outcome;
  }

  pi.on("session_start", async (_event, ctx) => {
    const services = servicesOf(ctx);
    const keySource = await describeKey(services, config);
    services.ui.setWidget(
      WIDGET_KEY,
      statusLines(config, catalog(), keySource, availabilityNote(services)),
    );

    // pi boots cache-only (`allowModelNetwork: false`), so this is what makes discovery run
    // without the user opening /model. Never awaited, in any mode: a forced refresh in flight
    // while the run is resolving its model makes `pi -p` produce no output at all.
    if (!startupRefreshed) {
      startupRefreshed = true;
      void startupRefresh(services).catch(() => {});
    }
  });

  pi.on("input", async (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.registerCommand("isisllm", {
    description:
      "ISIS LLM gateway: status, discovered models, forced refresh, diagnostics. Usage: /isisllm [status|models|refresh|doctor]",
    handler: async (args, ctx) => {
      const subcommand = (args.trim().split(/\s+/)[0] ?? "status").toLowerCase();
      const services = servicesOf(ctx);
      const models = catalog();
      const keySource = await describeKey(services, config);
      const shadow = readModelsJsonShadow();

      if (subcommand === "models") {
        pi.sendMessage({
          customType: "isisllm-models",
          content: modelTable(models).join("\n"),
          display: true,
        });
        return;
      }

      if (subcommand === "refresh") {
        const outcome = await refreshAndRender(servicesOf(ctx));
        const state = getDiscoveryState();
        const lines = outcome.ok
          ? [
              `ISIS LLM: refreshed ${outcome.models.length} models from ${config.modelsUrl} (${formatAge(state.at)}).`,
            ]
          : [
              `ISIS LLM: refresh failed — ${outcome.error ?? getDiscoveryState().error ?? "unknown error"}`,
              `  keeping ${outcome.models.length} model(s) from the last successful refresh.`,
            ];
        ctx.ui.notify(lines.join("\n"), outcome.ok ? "info" : "warning");
        return;
      }

      if (subcommand === "doctor") {
        const lines: string[] = [`ISIS LLM doctor · ${config.modelsUrl}`];
        lines.push(
          `- key: ${keySource === "missing" ? `missing (export ${config.apiKeyEnv} or use /login)` : keySource}`,
        );
        lines.push(
          `- models.json: ${
            shadow
              ? `${shadow.path} defines "${PROVIDER_ID}" (${shadow.modelIds.length} models) — those entries win over this extension. Delete the "${PROVIDER_ID}" block and restart pi.`
              : "no conflicting entry"
          }`,
        );
        lines.push(
          `- settings: ${existsSync(config.settingsPath) ? config.settingsPath : "none (optional)"}`,
        );
        for (const warning of config.warnings) lines.push(`  warning: ${warning}`);
        if (!existsSync(config.settingsPath) && shadow) {
          lines.push(
            `  To keep using curated metadata locally, put it in ${config.settingsPath} under "models".`,
          );
        }
        try {
          const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID).catch(() => undefined);
          const discovered = await discoverModels({
            config,
            ...(auth?.auth.apiKey ? { storedApiKey: auth.auth.apiKey } : {}),
          });
          const curated = discovered.filter((model) => !isUnverified(model)).length;
          lines.push(`- discovery: ok, ${discovered.length} models (${curated} curated)`);
        } catch (error) {
          lines.push(`- discovery: ${error instanceof Error ? error.message : String(error)}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const lines = statusLines(config, models, keySource, availabilityNote(services));
      if (shadow) {
        lines.push(
          `  note: ${shadow.path} still defines "${PROVIDER_ID}" — those ${shadow.modelIds.length} entries override this extension. Delete that block to rely on discovery.`,
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
