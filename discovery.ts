// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones
/**
 * Model discovery: `GET {baseUrl}/models` against the gateway's OpenAI-compatible endpoint.
 *
 * Failure modes are classified because they need different advice:
 *   no_key        nothing in the env var and nothing stored via /login
 *   unauthorized  401/403 — the key is wrong, expired, or lacks permission for /v1/models
 *   not_litellm   a 200 whose body is HTML/non-JSON (Open WebUI swallows unknown paths, so a
 *                 wrong base URL looks like a successful request)
 *   timeout       the request outlived `config.timeoutMs`
 *   network       DNS/TLS/connection failure
 *
 * The API key is never included in an error message; any occurrence is redacted.
 */

import { normalizeBaseUrl } from "./config.js";
import { buildModels, parseGatewayEntry } from "./metadata.js";
import type { ChatModel, DiscoveryState, GatewayModelEntry, IsisllmConfig } from "./types.js";

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

/** Fetch and validate the raw model list. Throws `DiscoveryError`; never returns partial junk. */
export async function fetchGatewayModels(
  options: FetchGatewayOptions,
): Promise<GatewayModelEntry[]> {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new DiscoveryError(
      "not_litellm",
      `${options.modelsUrl} returned a body that is not JSON`,
      error,
    );
  }

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

/** In-memory record of the most recent attempt, surfaced by `/isisllm status`. */
const state: DiscoveryState = { at: null, modelCount: 0, source: "none", error: null };

export function getDiscoveryState(): Readonly<DiscoveryState> {
  return state;
}

export function recordDiscoverySuccess(modelCount: number): void {
  state.at = Date.now();
  state.modelCount = modelCount;
  state.source = "live";
  state.error = null;
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
    const entries = await fetchGatewayModels({
      modelsUrl,
      apiKey,
      timeoutMs: options.timeoutMs ?? config.timeoutMs,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
    const models = buildModels(entries, {
      baseUrl,
      presets: config.presets,
      overrides: config.settings.models,
      excludeExtra: config.settings.exclude,
    });
    recordDiscoverySuccess(models.length);
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
