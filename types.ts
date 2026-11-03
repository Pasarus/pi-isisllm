// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones
/**
 * Shared shapes for the pi-isisllm extension.
 *
 * Runtime imports are kept to types only — this module must stay loadable by pi's jiti
 * loader, by vitest, and by `tsc --noEmit` without pulling in optional peer packages.
 */

import type { Model, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Provider id. Sessions (`--model isisllm/...`) and the env var name depend on it. */
export const PROVIDER_ID = "isisllm";
export const PROVIDER_NAME = "ISIS LLM";
/** Name of the local settings file inside `~/.pi/agent/settings/`. */
export const SETTINGS_FILE = "pi-isisllm.json";

/** Chat model shape produced for this provider's API. */
export type ChatModel = Model<"openai-completions">;

/** Model input modalities (the gateway's /v1/models never reports these). */
export type ModelInput = "text" | "image";

/** One entry of the gateway's `GET /v1/models` response. */
export interface GatewayModelEntry {
  id: string;
  created?: number;
  owned_by?: string;
  /** LiteLLM passes these through from the deployment; often absent. */
  max_input_tokens?: number;
  max_output_tokens?: number;
}

/** Curated metadata for one model id, from `presets.json` or the local settings file. */
export interface ModelMetadata {
  /** Display name in `/model`. Preset entries are curated; otherwise the id is prettified. */
  name?: string;
  /** Supports extended thinking / reasoning_content. */
  reasoning?: boolean;
  /** Accepted input modalities. Defaults to `["text"]`. */
  input?: ModelInput[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: ThinkingLevelMap;
  /** OpenAI-compatible wire-format overrides. */
  compat?: OpenAICompletionsCompat;
}

/** Defaults and heuristics bundled in `presets.json`. */
export interface PresetsFile {
  /** Documentation lines for contributors; ignored at runtime. */
  _readme?: string[];
  defaults?: {
    contextWindow?: number;
    maxTokens?: number;
  };
  /** Extra regex sources for models that are not chat models (always case-insensitive). */
  exclude?: string[];
  /** Regex sources marking an id as reasoning-capable. */
  reasoningPatterns?: string[];
  /** `compat.thinkingFormat` by id pattern, first match wins. */
  thinkingFormats?: {
    pattern: string;
    format: NonNullable<OpenAICompletionsCompat["thinkingFormat"]>;
  }[];
  /** Curated metadata per model id. */
  models?: Record<string, ModelMetadata>;
}

/** Optional per-user overrides in `~/.pi/agent/settings/pi-isisllm.json`. */
export interface IsisllmSettings {
  baseUrl?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  /** Extra non-chat patterns, appended to the bundled excludes. */
  exclude?: string[];
  /** Promote an `(unverified)` discovered model to curated metadata on this machine. */
  models?: Record<string, ModelMetadata>;
  /** Hide the `models.json` shadowing warning. */
  quietModelsJsonWarning?: boolean;
}

/** Everything the extension needs after env vars, settings and presets are merged. */
export interface IsisllmConfig {
  baseUrl: string;
  /** `GET {baseUrl}/models`. */
  modelsUrl: string;
  /** Env var consulted before the stored credential. */
  apiKeyEnv: string;
  /** Timeout for discovery, in ms. */
  timeoutMs: number;
  presets: PresetsFile;
  settings: IsisllmSettings;
  settingsPath: string;
  /** Settings/preset problems worth showing in `/isisllm status`. */
  warnings: string[];
}

/** Where the currently registered models came from. */
export type ModelSource = "live" | "cached" | "none";

/** Last discovery attempt, kept in memory for `/isisllm status` / `refresh`. */
export interface DiscoveryState {
  at: number | null;
  modelCount: number;
  source: ModelSource;
  error: string | null;
}
