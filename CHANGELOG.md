# Changelog

All notable changes to `pi-isisllm` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1

### Fixed

- Enable Pi's native `x-session-id` affinity for ISIS Chat Completions models, including newly
  discovered ids, so LiteLLM can reuse the same vLLM prefix cache across conversation turns.
  Existing compatibility metadata and explicit per-model overrides are preserved.
- Document gateway requirements, cached-catalog refresh, shared-key isolation, and the different
  compatibility configuration used by Pi's Responses API.
- Add request-level regression coverage using Pi's native stream path and in-memory conversations.

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
