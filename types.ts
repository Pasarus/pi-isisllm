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

/** Model input modalities. Image input is only advertised when the gateway claims it. */
export type ModelInput = "text" | "image";

/** What the gateway itself said about a model's inputs. Absent means it never said. */
export interface GatewayCapabilities {
  /**
   * Image ingestion. `true` when the deployment advertises vision/image input (LiteLLM
   * `supports_vision` / `supports_image_input`, or an `image` entry in a modality list),
   * `false` when it explicitly says it cannot take images.
   */
  image?: boolean;
}

/** One entry of the gateway's `GET /v1/models` response. */
export interface GatewayModelEntry {
  id: string;
  created?: number;
  owned_by?: string;
  /** LiteLLM passes these through from the deployment; often absent. */
  max_input_tokens?: number;
  max_output_tokens?: number;
  /** Capability flags carried by the entry itself; current LiteLLM sends none. */
  capabilities?: GatewayCapabilities;
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
  /**
   * How the extension learns what each model can ingest.
   * - `"auto"` (default): ask, best-effort — `GET {baseUrl}/models` flags plus
   *   `GET {baseUrl}/model/info` (`supports_vision`); any failure is ignored.
   * - `"probe"`: as `"auto"`, then send one 1-token completion with a 1×1 image to every model the
   *   gateway said nothing about, and read the answer (accepted → image-capable, refused image
   *   content → text-only). Costs a minimal completion per unknown model per refresh, so it is
   *   opt-in; use it when the gateway serves custom deployments that LiteLLM has no metadata for.
   * - `"off"`: never call the capability endpoint or probe; presets and settings decide.
   */
  capabilities?: "auto" | "probe" | "off";
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
  /**
   * How the last run resolved image input: what `{baseUrl}/model/info` reported, why it could
   * not be asked, or that presets/overrides decided. Shown by `/isisllm status` / `doctor` so a
   * text-only model is explainable instead of mysterious.
   */
  capabilities: string | null;
}
