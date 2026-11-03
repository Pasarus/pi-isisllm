// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones
/**
 * Configuration: gateway URL, key env var, timeouts, bundled presets and the optional
 * per-user settings file.
 *
 * Precedence: `ISISLLM_*` environment variables > `~/.pi/agent/settings/pi-isisllm.json`
 * > bundled defaults. Nothing here writes to disk, and a broken settings file degrades to
 * defaults with a warning surfaced by `/isisllm status` instead of throwing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type IsisllmConfig,
  type IsisllmSettings,
  type ModelMetadata,
  type PresetsFile,
  SETTINGS_FILE,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://isisllm.rl.ac.uk/v1";
export const DEFAULT_API_KEY_ENV = "ISISLLM_API_KEY";
export const DEFAULT_TIMEOUT_MS = 8000;

/** Used if `presets.json` is missing or unreadable, so a bad install still boots. */
export const FALLBACK_PRESETS: PresetsFile = {
  defaults: { contextWindow: 131072, maxTokens: 16384 },
  exclude: [],
  reasoningPatterns: [],
  thinkingFormats: [],
  models: {},
};

/** Strip trailing slashes so `{baseUrl}/models` is well-formed. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_BASE_URL;
}

export function modelsUrlFor(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

export function getSettingsPath(): string {
  return join(getAgentDir(), "settings", SETTINGS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate the settings file; never throws. */
export function parseSettings(raw: string): { settings: IsisllmSettings; warnings: string[] } {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      settings: {},
      warnings: [
        `settings file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  if (!isRecord(parsed))
    return { settings: {}, warnings: ["settings file must contain a JSON object"] };

  const settings: IsisllmSettings = {};

  if (typeof parsed.baseUrl === "string" && parsed.baseUrl.trim().length > 0) {
    settings.baseUrl = parsed.baseUrl;
  } else if (parsed.baseUrl !== undefined) {
    warnings.push("ignoring settings baseUrl: expected a non-empty string");
  }

  if (typeof parsed.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.apiKeyEnv)) {
    settings.apiKeyEnv = parsed.apiKeyEnv;
  } else if (parsed.apiKeyEnv !== undefined) {
    warnings.push("ignoring settings apiKeyEnv: expected an environment variable name");
  }

  if (typeof parsed.timeoutMs === "number" && Number.isFinite(parsed.timeoutMs)) {
    settings.timeoutMs = Math.max(1000, Math.min(120000, Math.round(parsed.timeoutMs)));
  } else if (parsed.timeoutMs !== undefined) {
    warnings.push("ignoring settings timeoutMs: expected a number between 1000 and 120000");
  }

  if (parsed.exclude !== undefined) {
    if (Array.isArray(parsed.exclude) && parsed.exclude.every((item) => typeof item === "string")) {
      settings.exclude = parsed.exclude as string[];
    } else {
      warnings.push("ignoring settings exclude: expected an array of strings");
    }
  }

  if (parsed.models !== undefined) {
    if (isRecord(parsed.models)) {
      settings.models = parsed.models as Record<string, ModelMetadata>;
    } else {
      warnings.push("ignoring settings models: expected an object of model id to metadata");
    }
  }

  if (typeof parsed.quietModelsJsonWarning === "boolean")
    settings.quietModelsJsonWarning = parsed.quietModelsJsonWarning;

  return { settings, warnings };
}

let settingsCache: { path: string; settings: IsisllmSettings; warnings: string[] } | null = null;

/** Read `~/.pi/agent/settings/pi-isisllm.json`; cached per path, missing file is not an error. */
export function loadSettings(path = getSettingsPath()): {
  settings: IsisllmSettings;
  warnings: string[];
} {
  if (settingsCache?.path === path) return settingsCache;
  let result: { settings: IsisllmSettings; warnings: string[] };
  try {
    result = parseSettings(readFileSync(path, "utf-8"));
  } catch {
    result = { settings: {}, warnings: [] };
  }
  settingsCache = { path, ...result };
  return settingsCache;
}

let presetsCache: { presets: PresetsFile; warnings: string[] } | null = null;

/** Read the bundled `presets.json`, resolved next to this module (works under jiti and vitest). */
export function loadPresets(): { presets: PresetsFile; warnings: string[] } {
  if (presetsCache) return presetsCache;
  const warnings: string[] = [];
  let presets: PresetsFile = FALLBACK_PRESETS;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL("./presets.json", import.meta.url), "utf-8"),
    );
    if (isRecord(parsed)) presets = parsed as PresetsFile;
    else warnings.push("presets.json must contain a JSON object; using built-in defaults");
  } catch (error) {
    warnings.push(
      `could not read presets.json (${error instanceof Error ? error.message : String(error)}); using built-in defaults`,
    );
  }
  presetsCache = { presets, warnings };
  return presetsCache;
}

/** Merge env, settings file and presets into the effective configuration. */
export function loadConfig(
  options: { env?: NodeJS.ProcessEnv; settingsPath?: string } = {},
): IsisllmConfig {
  const env = options.env ?? process.env;
  const settingsPath = options.settingsPath ?? getSettingsPath();
  const { settings, warnings: settingsWarnings } = loadSettings(settingsPath);
  const { presets, warnings: presetWarnings } = loadPresets();
  const baseUrl = normalizeBaseUrl(env.ISISLLM_BASE_URL ?? settings.baseUrl ?? DEFAULT_BASE_URL);

  return {
    baseUrl,
    modelsUrl: `${baseUrl}/models`,
    apiKeyEnv: settings.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    timeoutMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    presets,
    settings,
    settingsPath,
    warnings: [...settingsWarnings, ...presetWarnings],
  };
}

/** API key from the environment, or `undefined`. Never log the value. */
export function getApiKeyFromEnv(
  config: Pick<IsisllmConfig, "apiKeyEnv">,
  env = process.env,
): string | undefined {
  const value = env[config.apiKeyEnv];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
