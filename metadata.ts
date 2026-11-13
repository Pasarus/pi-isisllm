// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones
/**
 * Model metadata resolution — pure, no I/O, no network.
 *
 * Precedence for capability/cost fields:
 *   bundled defaults → curated `presets.json` entry → local settings override
 *   (`~/.pi/agent/settings/pi-isisllm.json`)
 *
 * Precedence for the token limits (`contextWindow`, `maxTokens`) is different on purpose:
 *   local settings override → live limits from /v1/models → curated fallback → bundled defaults
 * Deployments get their context bumped without anyone editing `presets.json`, so whatever the
 * gateway reports is what we use; the curated numbers are only the offline/`/v1/models`-silent
 * fallback.
 *
 * Two invariants worth knowing:
 *  - `maxTokens` is always clamped to `contextWindow / 2`. Deployments report
 *    `max_output_tokens == max_input_tokens == contextWindow`, and pi needs room for the prompt in
 *    the same window.
 *  - Unknown model ids get `(unverified)` in their display name so a wrong heuristic is visible
 *    instead of silently trusted.
 */

import type {
  ChatModel,
  GatewayModelEntry,
  ModelInput,
  ModelMetadata,
  PresetsFile,
} from "./types.js";
import { PROVIDER_ID } from "./types.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 16384;
/** Never clamp a completion budget below this, even for tiny windows. */
const MIN_MAX_TOKENS = 1024;

export interface MetadataContext {
  baseUrl: string;
  presets: PresetsFile;
  /** Per-model overrides from the local settings file; wins over presets. */
  overrides?: Record<string, ModelMetadata>;
  /** Extra non-chat patterns from the local settings file. */
  excludeExtra?: string[];
}

/** Compile a regex source case-insensitively; invalid patterns never throw, they just never match. */
function tryRegex(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

function anyMatch(patterns: (string | undefined)[] | undefined, id: string): boolean {
  if (!patterns) return false;
  for (const source of patterns) {
    if (!source) continue;
    const re = tryRegex(source);
    if (re?.test(id)) return true;
  }
  return false;
}

/**
 * Should this id be registered at all? Non-chat deployments (embeddings, TTS, image models, …)
 * are filtered out, but a curated or locally overridden id always survives.
 */
export function isExcluded(
  id: string,
  context: Pick<MetadataContext, "presets" | "overrides" | "excludeExtra">,
): boolean {
  if (context.presets.models?.[id] || context.overrides?.[id]) return false;
  return anyMatch([...(context.presets.exclude ?? []), ...(context.excludeExtra ?? [])], id);
}

/** "llama-3.3-70b-instruct" → "Llama 3.3 70b Instruct". Only used for ids nobody curated. */
export function prettifyName(id: string): string {
  return id
    .split(/[-_/ ]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

/** Heuristic: does this unknown id look reasoning-capable? */
export function inferReasoning(id: string, patterns: string[] | undefined): boolean {
  return anyMatch(patterns ?? [], id);
}

/** Thinking-format values accepted by pi's openai-completions API. */
export type ThinkingFormat = NonNullable<NonNullable<ModelMetadata["compat"]>["thinkingFormat"]>;

/** Heuristic chat-template dialect for toggling thinking; `undefined` lets pi auto-detect. */
export function inferThinkingFormat(
  id: string,
  rules: PresetsFile["thinkingFormats"],
): ThinkingFormat | undefined {
  if (!rules) return undefined;
  for (const rule of rules) {
    if (!rule?.pattern || !rule.format) continue;
    if (tryRegex(rule.pattern)?.test(id)) return rule.format;
  }
  return undefined;
}

/** Clamp the completion budget into the shared context window. */
export function clampMaxTokens(maxTokens: number, contextWindow: number): number {
  const ceiling = Math.max(MIN_MAX_TOKENS, Math.floor(contextWindow / 2));
  const lowerBounded = Math.max(MIN_MAX_TOKENS, Math.round(maxTokens));
  return Math.min(lowerBounded, ceiling);
}

/** Positive integer or `undefined`; the gateway sends junk (nulls, strings) often enough. */
function positiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/** Validate one raw `/v1/models` entry. Returns `null` for anything unusable. */
export function parseGatewayEntry(value: unknown): GatewayModelEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) return null;
  const entry: GatewayModelEntry = { id: record.id.trim() };
  const maxInput = positiveInt(record.max_input_tokens);
  const maxOutput = positiveInt(record.max_output_tokens);
  if (maxInput !== undefined) entry.max_input_tokens = maxInput;
  if (maxOutput !== undefined) entry.max_output_tokens = maxOutput;
  if (typeof record.owned_by === "string") entry.owned_by = record.owned_by;
  return entry;
}

/** True when the id has curated (presets or local settings) metadata, i.e. not `(unverified)`. */
export function isCurated(
  id: string,
  context: Pick<MetadataContext, "presets" | "overrides">,
): boolean {
  return Boolean(context.presets.models?.[id] || context.overrides?.[id]);
}

function mergeMetadata(
  base: ModelMetadata | undefined,
  patch: ModelMetadata | undefined,
): ModelMetadata {
  if (!base && !patch) return {};
  const merged: ModelMetadata = { ...(base ?? {}), ...(patch ?? {}) };
  if (base?.compat || patch?.compat)
    merged.compat = { ...(base?.compat ?? {}), ...(patch?.compat ?? {}) };
  return merged;
}

/**
 * Build the pi model record for one gateway id.
 * `entry` may be a bare `{ id }` when generating the offline preset baseline.
 */
export function toPiModel(entry: GatewayModelEntry, context: MetadataContext): ChatModel {
  const { presets, overrides, baseUrl } = context;
  const preset = presets.models?.[entry.id];
  const override = overrides?.[entry.id];
  const curated = mergeMetadata(preset, override);
  const defaults = presets.defaults ?? {};

  // Token limits follow the deployment: what /v1/models reports wins over the curated fallback so
  // a bumped context needs no code change. An explicit settings override still beats the gateway.
  const contextWindow =
    override?.contextWindow ??
    entry.max_input_tokens ??
    preset?.contextWindow ??
    defaults.contextWindow ??
    DEFAULT_CONTEXT_WINDOW;
  const maxTokens = clampMaxTokens(
    override?.maxTokens ??
      entry.max_output_tokens ??
      preset?.maxTokens ??
      defaults.maxTokens ??
      DEFAULT_MAX_TOKENS,
    contextWindow,
  );

  const thinkingFormat = inferThinkingFormat(entry.id, presets.thinkingFormats);
  const compat: NonNullable<ChatModel["compat"]> = {
    // vLLM/LiteLLM reject `max_completion_tokens`; the user's hand-written models.json used this too.
    maxTokensField: "max_tokens",
    // Route this Pi conversation to the same LiteLLM deployment for vLLM prefix-cache reuse.
    sendSessionAffinityHeaders: true,
    sessionAffinityFormat: "openrouter",
    ...(thinkingFormat ? { thinkingFormat } : {}),
    ...(curated.compat ?? {}),
  };

  const input: ModelInput[] = curated.input ?? ["text"];
  const curatedName = curated.name;
  const name = curatedName ?? `${prettifyName(entry.id)} (unverified)`;

  return {
    id: entry.id,
    name,
    type: "chat",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    input,
    cost: { ...ZERO_COST },
    reasoning: curated.reasoning ?? inferReasoning(entry.id, presets.reasoningPatterns),
    contextWindow,
    maxTokens,
    compat,
    ...(curated.thinkingLevelMap ? { thinkingLevelMap: curated.thinkingLevelMap } : {}),
  };
}

/**
 * The registered set after a discovery run: exactly the ids the gateway reported, minus excluded
 * ones. Curated ids are *not* force-added — a model the gateway no longer serves disappears from
 * `/model` on the next refresh, which is what makes the list trustworthy. `presets.json` only
 * supplies metadata for the ids that are actually being served.
 */
export function buildModels(entries: GatewayModelEntry[], context: MetadataContext): ChatModel[] {
  const seen = new Set<string>();
  const models: ChatModel[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id) || isExcluded(entry.id, context)) continue;
    seen.add(entry.id);
    models.push(toPiModel(entry, context));
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}
