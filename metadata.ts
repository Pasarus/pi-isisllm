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
 * Input modalities follow the same "ask the deployment" rule (see `resolveInput`):
 *   local settings override → whatever the gateway reported → curated fallback → text only.
 * A capability nobody reported is *not* guessed: a model that turns out to reject images makes pi
 * fail mid-task, which is worse than a text-only model the user opts into in their settings.
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
  GatewayCapabilities,
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
  /**
   * Capability verdicts from the gateway's model-info endpoint, keyed by the public model id.
   * Absent (or a missing key) when the endpoint was not asked or said nothing.
   */
  capabilities?: Record<string, GatewayCapabilities>;
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

/** LiteLLM sends capability flags as booleans, `"true"` strings, or 0/1 depending on the source. */
function triState(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return undefined;
}

/** Wire keys LiteLLM has used for "this model can read images". */
const IMAGE_FLAG_KEYS = ["supports_vision", "supports_image_input"];
/** Wire keys holding an input modality list (`input_modalities: ["text", "image"]`). */
const IMAGE_LIST_KEYS = ["input_modalities", "supported_input_modalities", "supported_modalities"];

/**
 * Image-input capability carried by a raw gateway object, or `undefined` when the object says
 * nothing. Explicit negatives are kept: "the gateway says it cannot" outranks a curated `"yes"`.
 */
export function parseImageCapability(record: Record<string, unknown>): boolean | undefined {
  for (const key of IMAGE_FLAG_KEYS) {
    const flag = triState(record[key]);
    if (flag !== undefined) return flag;
  }
  for (const key of IMAGE_LIST_KEYS) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    const modalities = list.filter((item): item is string => typeof item === "string");
    if (modalities.length === 0) continue;
    return modalities.some((modality) => modality.trim().toLowerCase() === "image");
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
  const image = parseImageCapability(record);
  if (image !== undefined) entry.capabilities = { image };
  return entry;
}

/**
 * Merge the capability verdicts out of a LiteLLM `GET {baseUrl}/model/info` body:
 * `{ data: [{ model_name, litellm_params, model_info: { supports_vision, … } }] }`.
 *
 * One model id can sit behind several deployments; the answer is conservative — a single
 * deployment that says it cannot read images wins, because LiteLLM may route the request to any
 * of them. Everything else in that payload (internal `api_base` hostnames, cost tables, upstream
 * model names) is dropped here and never reaches a log or a UI string.
 */
export function extractModelInfoCapabilities(parsed: unknown): Record<string, GatewayCapabilities> {
  const capabilities: Record<string, GatewayCapabilities> = {};
  const data =
    typeof parsed === "object" && parsed !== null ? (parsed as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return capabilities;

  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.model_name === "string" ? record.model_name.trim() : "";
    if (!id) continue;
    const modelInfo = record.model_info;
    const sources: Record<string, unknown>[] = [record];
    if (typeof modelInfo === "object" && modelInfo !== null)
      sources.unshift(modelInfo as Record<string, unknown>);

    let image: boolean | undefined;
    for (const source of sources) {
      image = parseImageCapability(source);
      if (image !== undefined) break;
    }

    const existing = capabilities[id];
    if (image === undefined) capabilities[id] ??= {};
    else if (existing?.image === false) capabilities[id] = { image: false };
    else capabilities[id] = { image };
  }
  return capabilities;
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

/** Which layer decided a model's input modalities. */
export type InputSource = "override" | "gateway" | "preset" | "default";

/**
 * What the gateway claims about image input: the flags on the `/v1/models` entry itself win over
 * the model-info endpoint, because they describe the listing being registered. `undefined` means
 * the gateway never said, which is *not* the same as "no".
 */
export function gatewayImageCapability(
  entry: GatewayModelEntry,
  capabilities?: GatewayCapabilities,
): boolean | undefined {
  if (entry.capabilities?.image !== undefined) return entry.capabilities.image;
  return capabilities?.image;
}

/**
 * Input modalities for one model. The deployment is the authority — a bumped or downgraded
 * vLLM deployment must not need an edit here — so the order is local override, then whatever the
 * gateway reported, then curated metadata, then text only. Nothing is guessed from the id: an
 * over-reported "yes" lets pi attach an image that the gateway rejects mid-task with a 400.
 */
export function resolveInput(
  entry: GatewayModelEntry,
  context: MetadataContext,
): { input: ModelInput[]; source: InputSource } {
  const override = context.overrides?.[entry.id]?.input;
  if (override?.length) return { input: [...override], source: "override" };

  const gateway = gatewayImageCapability(entry, context.capabilities?.[entry.id]);
  if (gateway !== undefined)
    return { input: gateway ? ["text", "image"] : ["text"], source: "gateway" };

  const preset = context.presets.models?.[entry.id]?.input;
  if (preset?.length) return { input: [...preset], source: "preset" };
  return { input: ["text"], source: "default" };
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

  const input: ModelInput[] = resolveInput(entry, context).input;
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
