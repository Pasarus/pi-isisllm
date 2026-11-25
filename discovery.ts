// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones
/**
 * Model discovery: `GET {baseUrl}/models` against the gateway's OpenAI-compatible endpoint, plus a
 * best-effort `GET {baseUrl}/model/info` for what those models can ingest.
 *
 * Failure modes are classified because they need different advice:
 *   no_key        nothing in the env var and nothing stored via /login
 *   unauthorized  401/403 — the key is wrong, expired, or lacks permission for /v1/models
 *   not_litellm   a 200 whose body is HTML/non-JSON (Open WebUI swallows unknown paths, so a
 *                 wrong base URL looks like a successful request)
 *   timeout       the request outlived `config.timeoutMs`
 *   network       DNS/TLS/connection failure
 *
 * The model-info call never fails a discovery run: an older gateway, a key that may not call it,
 * or an Open WebUI page in the way all just mean "no capability data, presets decide".
 *
 * The API key is never included in an error message; any occurrence is redacted. Nothing from
 * `/model/info` except the capability flags is ever surfaced — its `litellm_params` carry internal
 * `api_base` hostnames.
 */

import { normalizeBaseUrl } from "./config.js";
import {
  buildModels,
  extractModelInfoCapabilities,
  isExcluded,
  parseGatewayEntry,
} from "./metadata.js";
import type {
  ChatModel,
  DiscoveryState,
  GatewayCapabilities,
  GatewayModelEntry,
  IsisllmConfig,
} from "./types.js";

export type DiscoveryErrorKind =
  | "no_key"
  | "unauthorized"
  | "not_litellm"
  | "http"
  | "timeout"
  | "aborted"
  | "network";

export class DiscoveryError extends Error {
  readonly kind: DiscoveryErrorKind;

  constructor(
    kind: DiscoveryErrorKind,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DiscoveryError";
    this.kind = kind;
  }
}

export interface FetchGatewayOptions {
  modelsUrl: string;
  apiKey: string;
  timeoutMs: number;
  /** pi's refresh signal, if any. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Remove the secret from anything derived from a response body. */
function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("***") : text;
}

/** Combine an optional external signal with a timeout; works on Node 20+. */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Discovery timed out", "TimeoutError"));
  }, timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function classifyAbort(error: unknown, timedOut: boolean): DiscoveryError {
  if (timedOut) {
    return new DiscoveryError(
      "timeout",
      "model discovery timed out; check the gateway is reachable",
    );
  }
  return new DiscoveryError("aborted", "model discovery was cancelled", error);
}

/** Fetch, authorise and JSON-parse one gateway endpoint. Throws `DiscoveryError`; never returns a body. */
async function fetchGatewayJson(options: FetchGatewayOptions): Promise<unknown> {
  const doFetch = options.fetchImpl ?? fetch;
  const { signal, dispose } = withTimeout(options.signal, options.timeoutMs);

  let response: Response;
  try {
    response = await doFetch(options.modelsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (signal.aborted)
      throw classifyAbort(
        error,
        signal.reason instanceof DOMException && signal.reason.name === "TimeoutError",
      );
    const message = error instanceof Error ? error.message : String(error);
    throw new DiscoveryError(
      "network",
      `could not reach ${options.modelsUrl}: ${redact(message, options.apiKey)}`,
      error,
    );
  } finally {
    dispose();
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const snippet = redact(body, options.apiKey).replace(/\s+/g, " ").trim().slice(0, 200);
    if (response.status === 401 || response.status === 403) {
      throw new DiscoveryError(
        "unauthorized",
        `${response.status} from ${options.modelsUrl}: the API key is missing, expired, or not allowed to list models${
          snippet ? ` (${snippet})` : ""
        }`,
      );
    }
    throw new DiscoveryError(
      "http",
      `${response.status} from ${options.modelsUrl}${snippet ? `: ${snippet}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("html") || /^\s*</.test(text)) {
    throw new DiscoveryError(
      "not_litellm",
      `${options.modelsUrl} returned an HTML page, not JSON. The base URL must point at the LiteLLM /v1 endpoint (for example https://isisllm.rl.ac.uk/v1).`,
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DiscoveryError(
      "not_litellm",
      `${options.modelsUrl} returned a body that is not JSON`,
      error,
    );
  }
}

/** Fetch and validate the raw model list. Throws `DiscoveryError`; never returns partial junk. */
export async function fetchGatewayModels(
  options: FetchGatewayOptions,
): Promise<GatewayModelEntry[]> {
  const parsed = await fetchGatewayJson(options);

  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new DiscoveryError(
      "not_litellm",
      `${options.modelsUrl} did not return an OpenAI model list ({ data: [...] })`,
    );
  }

  const byId = new Map<string, GatewayModelEntry>();
  for (const item of data) {
    const entry = parseGatewayEntry(item);
    if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/** What the best-effort capability probe found, in a form safe to show the user. */
export interface CapabilityFetchResult {
  /** Per-model verdicts keyed by the public model id. */
  capabilities: Record<string, GatewayCapabilities>;
  /** One-line summary for `/isisllm status` / `doctor`; never contains a key or a deployment URL. */
  note: string;
}

/** Short label for `{baseUrl}/model/info`; the full URL is already on the endpoint line. */
const CAPABILITY_ENDPOINT_LABEL = "model/info";

/**
 * Ask `{baseUrl}/model/info` what the deployments can ingest (LiteLLM's `supports_vision`,
 * merged across the deployments behind each model id). Deliberately cannot throw: capability data
 * is a bonus, and losing it must never cost the user their model list. `settings.capabilities`
 * `"off"` skips the call entirely.
 */
export async function fetchGatewayCapabilities(
  options: Omit<FetchGatewayOptions, "modelsUrl"> & { infoUrl: string },
): Promise<CapabilityFetchResult> {
  const { infoUrl, ...rest } = options;
  try {
    const parsed = await fetchGatewayJson({ ...rest, modelsUrl: infoUrl });
    const capabilities = extractModelInfoCapabilities(parsed);
    const verdicts = Object.values(capabilities).filter(
      (capability) => capability.image !== undefined,
    ).length;
    const models = Object.keys(capabilities).length;
    return {
      capabilities,
      note:
        verdicts > 0
          ? `${CAPABILITY_ENDPOINT_LABEL}: image input reported for ${verdicts}/${models} model(s)`
          : `${CAPABILITY_ENDPOINT_LABEL} reported no capability flags`,
    };
  } catch (error) {
    const kind = error instanceof DiscoveryError ? error.kind : "network";
    const reason =
      kind === "unauthorized"
        ? "the key may not call it"
        : kind === "not_litellm"
          ? "endpoint missing or not JSON"
          : kind === "timeout"
            ? "timed out"
            : kind === "aborted"
              ? "cancelled"
              : "unreachable";
    return {
      capabilities: {},
      note: `${CAPABILITY_ENDPOINT_LABEL} unavailable (${reason}) — presets and settings decide image input`,
    };
  }
}

/** 1×1 red PNG (70 bytes) — the smallest payload that proves an engine reads pixels. */
const PROBE_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** How many probe completions may be in flight at once. */
const PROBE_CONCURRENCY = 3;
/** Error wording that means "this deployment refuses image content", not "your request is broken". */
const IMAGE_REJECTION = /image|multimodal|modalit|vision/i;

export interface ProbeOptions {
  chatUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Ask one deployment, by behaviour rather than by metadata, whether it reads images: one
 * completion with a 1×1 PNG and a one-token budget. `true` when it answered, `false` when it
 * refused image content specifically, `undefined` when the exchange told us nothing (auth, rate
 * limit, timeout, an unrelated 400). Never throws.
 */
export async function probeImageSupport(options: ProbeOptions): Promise<boolean | undefined> {
  const doFetch = options.fetchImpl ?? fetch;
  const { signal, dispose } = withTimeout(options.signal, options.timeoutMs);
  try {
    const response = await doFetch(options.chatUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 1,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Name the colour of this image in one word." },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${PROBE_IMAGE_PNG_BASE64}` },
              },
            ],
          },
        ],
      }),
      signal,
    });
    if (response.ok) return true;
    const body = (await response.text().catch(() => "")).slice(0, 500);
    const refused = IMAGE_REJECTION.test(body);
    // Only a request-level rejection of image content counts; a 401/429/500 says nothing about
    // the model's modalities, and guessing from those would flip a working model to text-only.
    if (refused && (response.status === 400 || response.status === 404 || response.status === 422))
      return false;
    return undefined;
  } catch {
    return undefined;
  } finally {
    dispose();
  }
}

export interface ProbeManyOptions extends Omit<ProbeOptions, "model"> {
  /** Model ids with no verdict from the gateway itself. */
  models: string[];
}

export interface ProbeManyResult {
  capabilities: Record<string, GatewayCapabilities>;
  note: string | null;
}

/**
 * Probe a list of models with bounded concurrency. Costs one minimal completion per model, so it
 * only ever runs when `settings.capabilities` is `"probe"`. Cannot throw and cannot fail discovery.
 */
export async function probeCapabilities(options: ProbeManyOptions): Promise<ProbeManyResult> {
  const models = [...new Set(options.models)].filter(Boolean);
  if (models.length === 0) return { capabilities: {}, note: null };

  const capabilities: Record<string, GatewayCapabilities> = {};
  let next = 0;
  let settled = 0;
  const workers = Array.from(
    { length: Math.min(PROBE_CONCURRENCY, models.length) },
    async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const model = models[index];
        if (model === undefined) return;
        const image = await probeImageSupport({ ...options, model });
        settled += 1;
        if (image !== undefined) capabilities[model] = { image };
      }
    },
  );
  await Promise.all(workers);

  const accepted = Object.values(capabilities).filter((capability) => capability.image).length;
  const verdicts = Object.keys(capabilities).length;
  const note =
    verdicts === 0
      ? `probe: asked ${settled} model(s), none answered the question`
      : `probe: ${accepted}/${verdicts} probed model(s) accept images`;
  return { capabilities, note };
}

/** In-memory record of the most recent attempt, surfaced by `/isisllm status`. */
const state: DiscoveryState = {
  at: null,
  modelCount: 0,
  source: "none",
  error: null,
  capabilities: null,
};

export function getDiscoveryState(): Readonly<DiscoveryState> {
  return state;
}

export function recordDiscoverySuccess(modelCount: number, capabilities: string | null): void {
  state.at = Date.now();
  state.modelCount = modelCount;
  state.source = "live";
  state.error = null;
  state.capabilities = capabilities;
}

export function recordDiscoveryError(message: string): void {
  state.at = Date.now();
  state.error = message;
}

/** Resolve the key for discovery: env var first, then the credential stored via /login. */
export function resolveDiscoveryApiKey(
  config: Pick<IsisllmConfig, "apiKeyEnv">,
  credentialKey: string | undefined,
  env = process.env,
): { apiKey: string | undefined; source: "env" | "stored" | "none" } {
  const fromEnv = env[config.apiKeyEnv];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0)
    return { apiKey: fromEnv.trim(), source: "env" };
  if (credentialKey) return { apiKey: credentialKey, source: "stored" };
  return { apiKey: undefined, source: "none" };
}

export interface DiscoverOptions {
  config: IsisllmConfig;
  /** Credential stored with `/login`, if the user has one. */
  storedApiKey?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Override the configured base URL (pi passes the effective one in `RefreshModelsContext`). */
  baseUrl?: string;
  /** Shorter deadline for the one-off cold-start fetch; defaults to `config.timeoutMs`. */
  timeoutMs?: number;
}

/**
 * Fetch the gateway catalog and turn it into pi models. Throws `DiscoveryError` on failure so
 * callers can report it; pi keeps whatever catalog it already had (its own persisted cache).
 */
export async function discoverModels(options: DiscoverOptions): Promise<ChatModel[]> {
  const { config } = options;
  const baseUrl = options.baseUrl ? normalizeBaseUrl(options.baseUrl) : config.baseUrl;
  const modelsUrl = `${baseUrl}/models`;
  const { apiKey } = resolveDiscoveryApiKey(
    config,
    options.storedApiKey,
    options.env ?? process.env,
  );
  if (!apiKey) {
    const error = new DiscoveryError(
      "no_key",
      `no API key: export ${config.apiKeyEnv} or run /login and pick "ISIS LLM" to store one`,
    );
    recordDiscoveryError(error.message);
    return Promise.reject(error);
  }

  try {
    const mode = config.settings.capabilities ?? "auto";
    const [entries, reported] = await Promise.all([
      fetchGatewayModels({
        modelsUrl,
        apiKey,
        timeoutMs: options.timeoutMs ?? config.timeoutMs,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
      }),
      // Concurrent so a slow or locked-down model-info endpoint costs no extra startup time.
      mode === "off"
        ? Promise.resolve<CapabilityFetchResult>({
            capabilities: {},
            note: 'capability endpoint disabled by settings (capabilities: "off")',
          })
        : fetchGatewayCapabilities({
            infoUrl: `${baseUrl}/model/info`,
            apiKey,
            timeoutMs: options.timeoutMs ?? config.timeoutMs,
            signal: options.signal,
            fetchImpl: options.fetchImpl,
          }),
    ]);

    const capabilities: Record<string, GatewayCapabilities> = { ...reported.capabilities };
    const notes = [reported.note];
    if (mode === "probe") {
      // Only the models the gateway said nothing about: reported metadata always outranks a probe,
      // so this spends completions only where there is no other source of truth.
      const unknown = entries
        .filter(
          (entry) =>
            entry.capabilities?.image === undefined &&
            capabilities[entry.id]?.image === undefined &&
            !isExcluded(entry.id, {
              presets: config.presets,
              overrides: config.settings.models,
              excludeExtra: config.settings.exclude,
            }),
        )
        .map((entry) => entry.id);
      const probed = await probeCapabilities({
        chatUrl: `${baseUrl}/chat/completions`,
        apiKey,
        timeoutMs: options.timeoutMs ?? config.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        models: unknown,
      });
      Object.assign(capabilities, probed.capabilities);
      if (probed.note) notes.push(probed.note);
    }

    const models = buildModels(entries, {
      baseUrl,
      presets: config.presets,
      overrides: config.settings.models,
      excludeExtra: config.settings.exclude,
      capabilities,
    });
    recordDiscoverySuccess(models.length, notes.filter(Boolean).join(" · ") || null);
    return models;
  } catch (error) {
    if (error instanceof DiscoveryError) {
      recordDiscoveryError(error.message);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new DiscoveryError("network", redact(message, apiKey), error);
    recordDiscoveryError(wrapped.message);
    throw wrapped;
  }
}
