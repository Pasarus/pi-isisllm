// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones

import { readFileSync } from "node:fs";
import { loadPresets } from "../config.js";
import type { MetadataContext } from "../metadata.js";
import type { GatewayCapabilities, IsisllmConfig, IsisllmSettings } from "../types.js";

export const TEST_BASE_URL = "https://gw.example.test/v1";

/** Parsed contents of `test/fixtures/<name>.json`. */
export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf-8"));
}

/** Build a config without touching the filesystem (beyond the bundled presets). */
export function makeConfig(
  settings: IsisllmSettings = {},
  overrides: Partial<IsisllmConfig> = {},
): IsisllmConfig {
  const { presets } = loadPresets();
  const baseUrl = overrides.baseUrl ?? TEST_BASE_URL;
  const config: IsisllmConfig = {
    baseUrl,
    modelsUrl: `${baseUrl}/models`,
    apiKeyEnv: "ISISLLM_API_KEY",
    timeoutMs: 1000,
    presets,
    settings,
    settingsPath: "/nonexistent/settings/pi-isisllm.json",
    warnings: [],
  };
  return { ...config, ...overrides };
}

export function makeMetadataContext(
  settings: IsisllmSettings = {},
  capabilities?: Record<string, GatewayCapabilities>,
): MetadataContext {
  const config = makeConfig(settings);
  return {
    baseUrl: config.baseUrl,
    presets: config.presets,
    overrides: config.settings.models,
    excludeExtra: config.settings.exclude,
    ...(capabilities ? { capabilities } : {}),
  };
}

/** Minimal `Response` stand-in: discovery only reads ok/status/headers/text(). */
export function fakeResponse(options: {
  status?: number;
  body: string;
  contentType?: string;
}): Response {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(options.contentType ? { "content-type": options.contentType } : {}),
    text: async () => options.body,
  } as unknown as Response;
}

export function fetchJson(body: unknown, init: { status?: number } = {}) {
  return fakeResponse({
    ...init,
    body: JSON.stringify(body),
    contentType: "application/json",
  });
}

export function recordedFetch(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * A `fetch` that answers per URL, for discovery runs that hit more than one endpoint.
 * Unrouted URLs reject like an unreachable host.
 */
export function routedFetch(routes: Record<string, Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    calls.push(target);
    const response = routes[target];
    if (!response) throw new Error(`ENOTFOUND ${target}`);
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * A `fetch` driven by a function, for endpoints whose answer depends on the request body (the
 * capability probe sends one completion per model). Records every call and the largest number of
 * requests in flight at once.
 */
export function handlerFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; init: RequestInit; body?: Record<string, unknown> }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    const target = String(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: target, init, ...(body ? { body } : {}) });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await handler(target, init);
    } finally {
      inFlight -= 1;
    }
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    /** Chat calls in request-body order, as [model, response]. */
    chats: () =>
      calls
        .filter((call) => call.url.endsWith("/chat/completions"))
        .map((call) => String(call.body?.model)),
    get maxInFlight() {
      return maxInFlight;
    },
  };
}
