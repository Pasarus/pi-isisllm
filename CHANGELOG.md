# Changelog

All notable changes to `pi-isisllm` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

### Added

- **Image (vision) ingestion, driven by what the gateway reports.** A model is registered with
  `input: ["text", "image"]` — which is what makes pi attach images to a request — when the gateway
  says it can read them. Precedence is your settings override, then whatever the gateway reported,
  then `presets.json`, then text-only. Capability flags are read from the `GET {baseUrl}/models`
  entry (`supports_vision`, `supports_image_input`, or an `input_modalities` list containing
  `image`) and, when it carries none, from a best-effort `GET {baseUrl}/model/info`; deployments
  behind one model id are merged conservatively, so a single text-only deployment keeps the id
  text-only.
- The capability probe never fails a refresh: a locked (403), missing, or HTML-answering
  `{baseUrl}/model/info` degrades to "no capability data" and the model list is unaffected. Only
  the capability flags are read from that payload, and turn it off entirely with
  `"capabilities": "off"` in `~/.pi/agent/settings/pi-isisllm.json`.
- Opt-in `"capabilities": "probe"` for gateways that cannot answer the question — custom
  deployments report `supports_vision: null` because their names are not in LiteLLM's cost map. For
  every model nobody vouched for it sends one completion with a 1×1 PNG and a one-token budget and
  reads the reply: accepted means image-capable, a refusal naming images/multimodal means text-only,
  anything else (auth, rate limit, timeout, an unrelated 400) is treated as no verdict. At most
  three in flight, never for excluded ids, never able to fail a refresh, and it outranks
  `presets.json` in both directions because deployments are reconfigured without anyone editing this
  repo. The default `"auto"` sends no completions.
- `/isisllm models` gained an `images` column; `/isisllm status` and `/isisllm doctor` report how
  many models accept images and how that was decided (`image input: 1/4 · model/info reported no
  capability flags`), so a text-only model is explainable instead of mysterious.

### Notes

- Nothing is guessed from a model id: an unreported modality stays `"text"`, because a false "yes"
  lets pi attach an image the gateway rejects with a 400 mid-task.
- Verified against the live gateway on 2026-11-03: it reports `supports_vision: null` for every
  model (those ids are not in LiteLLM's cost map), so the capability flags come from nowhere and
  the curated metadata decides. `qwen3.8-flash-next` is now served by a multimodal engine (it names
  the colour of a solid square) and is curated as `["text", "image"]`; `qwen3.8-27b`
  (`At most 0 image(s) may be provided`) and `qwen3-coder-next` (`is not a multimodal model`) stay
  text-only. Declaring `model_info: {supports_vision: true}` in the LiteLLM config makes the
  gateway itself vouch for a model, which this extension then prefers over its presets.

## 0.1.1

### Fixed

- Enable Pi's native `x-session-id` affinity for ISIS Chat Completions models, including newly
  discovered ids, so LiteLLM can reuse the same vLLM prefix cache across conversation turns.
  Existing compatibility metadata and explicit per-model overrides are preserved.
- Document gateway requirements, cached-catalog refresh, shared-key isolation, and the different
  compatibility configuration used by Pi's Responses API.
- Add request-level regression coverage using Pi's native stream path and in-memory conversations.

### Changed

- Removed the persistent startup status widget; startup model discovery now stays silent when it
  succeeds and emits a warning notification only when the API key is missing or the refresh fails.

## 0.1.0 - initial release

### Added

- Registers the `isisllm` provider with Pi at runtime; no `models.json` entry is required.
- Live model discovery from the gateway's OpenAI-compatible `GET /v1/models` endpoint. The catalog
  is live-only: exactly the ids the gateway reports, and Pi caches that list in
  `~/.pi/agent/models-store.json` so offline startup still lists the last known live set. On a
  machine with no cache yet, the extension makes one bounded live call while loading so `--model`
  and `--list-models` work immediately; `/isisllm status` labels the catalog `live`, `cached` or
  `none`.
- Curated metadata (name, `reasoning`, token fallbacks) for `qwen3-coder-next`,
  `qwen3-coder-next-4bit`, `qwen3.8-27b` and `qwen3.8-flash-next`; metadata only — any other model
  the key can see is registered with safe defaults and labelled `(unverified)`.
- Token limits follow the gateway: reported `max_input_tokens`/`max_output_tokens` win over the
  bundled presets, clamped so `maxTokens` never exceeds half the context window.
- Authentication through `ISISLLM_API_KEY` (preferred) or a key stored with `/login` →
  `ISIS LLM`, which writes to Pi's own `auth.json`.
- `/isisllm` command with `status`, `models`, `refresh` and `doctor` subcommands.
- Optional local overrides in `~/.pi/agent/settings/pi-isisllm.json` for base URL, exclusions and
  per-model metadata.
- Licensed AGPL-3.0-or-later; every source file carries its SPDX header.
