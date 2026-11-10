# pi-isisllm

A [pi](https://github.com/badlogic/pi-mono) package that registers the **ISIS LLM** LiteLLM gateway
as a model provider — including live model discovery — so no one has to hand-maintain a
`models.json` block again.

```bash
pi install git:github.com/Pasarus/pi-isisllm
```

Then give pi a key (either way):

```bash
export ISISLLM_API_KEY=...          # in ~/.bashrc / your shell profile
```

or start `pi`, run `/login`, pick **ISIS LLM**, then **Sign in with an API key**, and paste the key
— pi stores it in `~/.pi/agent/auth.json` (masked input, managed by `/logout`).

After that `--model isisllm/qwen3-coder-next`, the `/model` picker, and everything else work.
There is **no `models.json` involved**: this extension registers the provider at runtime, and pi
caches the discovered catalog itself.

The catalog is **live-only**: it is exactly what `GET {baseUrl}/models` reports. A model the
gateway retires disappears on the next refresh, and `presets.json` only decorates the ids that are
actually being served — it never puts a model on the list.

pi caches each discovered list in `~/.pi/agent/models-store.json` and restores it on the next
startup (offline included). On a machine that has never discovered anything, the extension makes
one bounded live call while it loads, so `--model isisllm/...` and `--list-models` work out of the
box instead of erroring with "Model not found".

## Requirements

- pi `>= 1.5.0` (uses the native `pi.registerProvider(provider)` overload and provider `auth`).
- Node `>= 20`. No build step, no runtime dependencies — pi loads the TypeScript directly.

## Install

```bash
pi install git:github.com/Pasarus/pi-isisllm            # latest default branch
pi install git:github.com/Pasarus/pi-isisllm@v0.1.0     # pinned release
pi remove git:github.com/Pasarus/pi-isisllm             # uninstall
pi update --extensions                                  # update all git packages
```

Try it without installing (development): `pi -e ./ --list-models`.

## Remove your old `models.json` block

If `~/.pi/agent/models.json` still contains an `isisllm` entry, **delete that block** (or the whole
file if it only held this provider). `models.json` is applied *above* extension-registered
providers: its entries replace same-id models discovered live (pinning `baseUrl`, `compat` and
token limits to whatever was written down) and its extra ids keep showing up even after the
gateway retires them. An extension cannot overrule that layer — pi puts user config on top — so
deleting the block is the only way to get a purely live list.

`/isisllm status` and `/isisllm doctor` warn while such a block exists, and tell you the file path.
The extension never reads or rewrites `models.json` beyond that read-only check.

## What you get

| | |
|---|---|
| `/model` | exactly the models your key can see on the gateway right now, discovered live |
| `/isisllm` | base URL, key source, curated/unverified counts, last refresh, last error |
| `/isisllm models` | table of registered models with `reasoning`, window, `thinkingFormat`, `maxTokensField` |
| `/isisllm refresh` | force a network refresh now and report what changed |
| `/isisllm doctor` | key, `models.json` shadowing, settings file, and a live endpoint probe |
| startup widget | one status line under the editor until you type |

Models are discovered from `GET {baseUrl}/models` shortly after the session opens. pi persists the
result in `~/.pi/agent/models-store.json` and restores it on the next cache-only startup, so offline
starts still list the last known live set — `/isisllm status` labels that `cached`, versus `live`
once a fresh fetch has landed, and `none` when nothing has been discovered yet.

## How models are described

`presets.json` supplies **metadata only** — display name, `reasoning`, input modalities and token
fallbacks for ids this extension knows about. It never registers a model by itself: an id appears
only when the gateway reports it. Any other reported id is registered with conservative defaults
and the display name suffix `(unverified)`:

| Field | Curated model | Unknown model |
|---|---|---|
| `reasoning` | from preset | pattern match (`qwen3…`, `deepseek`, `r1`, `-thinking`, `gpt-5`, …) |
| `input` | from preset | `["text"]` — `/v1/models` never reports modalities |
| `contextWindow` | gateway `max_input_tokens`, else preset, else `131072` | gateway `max_input_tokens`, else `131072` |
| `maxTokens` | gateway `max_output_tokens`, else preset, else `16384` | gateway `max_output_tokens`, else `16384` |
| `cost` | `0` | `0` (the gateway bills nothing through pi) |
| `compat.maxTokensField` | `max_tokens` | `max_tokens` (vLLM/LiteLLM reject `max_completion_tokens`) |
| `compat.thinkingFormat` | from preset | `qwen-chat-template` for `qwen*`, `deepseek` for `deepseek*`, otherwise auto-detected |

Token limits follow the gateway, curated preset or otherwise: whatever `/v1/models` reports for an
id wins, and the preset numbers are only the offline / silent-endpoint fallback, so a deployment
bumped to a bigger window needs no code change. Both fields are then clamped: `maxTokens` is
capped at `contextWindow / 2` (minimum 1024). The clamp matters because deployments report
`max_output_tokens == max_input_tokens == contextWindow` — the single window is shared by prompt
and completion — and asking for the whole window as an output budget leaves pi no room for the
prompt. A `settings/pi-isisllm.json` override outranks the gateway for both fields.

### Conversation affinity and prefix caching

Every Chat Completions model registered by this extension defaults to
`compat.sendSessionAffinityHeaders: true` and `compat.sessionAffinityFormat: "openrouter"`.
Pi sends `x-session-id` with its existing conversation UUID; the extension adds no custom HTTP
handling and generates no identifiers. This applies to the `isisllm` provider, including newly
discovered models, and leaves other providers alone. Per-model compatibility overrides still win.

LiteLLM must enable `session_affinity` for the model group. With `least-busy` routing, new
conversations can be assigned independently while subsequent turns reuse the chosen vLLM replica
and its prefix cache. A shared team API key authenticates requests; it is not the affinity ID.
Different conversations have different IDs but may still be assigned to the same replica.
Affinity is best effort: expiry, failover, replica restarts and cache eviction can reduce reuse.
The measured benefit depends on the cached prefix and load; affinity alone does not guarantee a
particular latency.

Verified with Pi 1.5.0 and its
[model compatibility documentation](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/models-configuration.md).
Pi omits affinity headers when `cacheRetention: "none"` or no `sessionId` is supplied.
After upgrading, run `/isisllm refresh` so Pi replaces older cached model metadata; remove any
shadowing `isisllm` block from `models.json`.

This extension currently registers only `openai-completions`. Pi's `openai-responses` API uses
`compat.sessionAffinityFormat: "openrouter"` alone to send `x-session-id`; it does not use the
Chat Completions `sendSessionAffinityHeaders` switch. Do not copy both flags into Responses models.

The `qwen3.8-27b` context fallback is 131072 tokens, matching the deployed vLLM
`--max-model-len`. Gateway-reported limits and explicit settings overrides retain their existing
precedence.

### Fixing or curating a model without forking

Put an override in `~/.pi/agent/settings/pi-isisllm.json`. This is your layer: it wins over the
gateway's reported token limits and over `presets.json`, and it survives `pi update` (unlike the
installed copy of `presets.json`, which is repo data and gets overwritten):

```json
{
  "models": {
    "some-new-model": {
      "name": "Some New Model",
      "reasoning": true,
      "input": ["text", "image"],
      "contextWindow": 262144,
      "maxTokens": 32768,
      "compat": { "thinkingFormat": "qwen-chat-template" }
    }
  }
}
```

Curating it in `presets.json` (a PR) is better for everyone else.

## Configuration

Four layers, highest first. An env var always beats the same value written in the settings file, and
settings always beat `presets.json` and the built-in fallbacks:

| Layer | Set it with | Use it for |
|---|---|---|
| 1 · env vars | `ISISLLM_BASE_URL`, `ISISLLM_API_KEY` (or whatever `apiKeyEnv` names) | per-shell and CI overrides — connection and credentials only |
| 2 · settings file | `~/.pi/agent/settings/pi-isisllm.json` | your permanent defaults: base URL, timeout, extra excludes, per-model pins. Survives `pi update` |
| 3 · `presets.json` | a PR to this repo | defaults for everyone. Don't edit the installed copy — `pi update --extensions` overwrites it |
| 4 · built-in fallbacks | `metadata.ts` constants (`131072` window, `16384` output, `max_tokens`) | last resort for an id nobody configured |

Env vars:

| Env var | Purpose | Default |
|---|---|---|
| `ISISLLM_API_KEY` | API key (checked first; falls back to the `/login` credential) | — |
| `ISISLLM_BASE_URL` | Gateway base URL, **must include `/v1`** | `https://isisllm.rl.ac.uk/v1` |

`~/.pi/agent/settings/pi-isisllm.json` (optional), with every key it accepts:

```json
{
  "baseUrl": "https://isisllm.rl.ac.uk/v1",
  "apiKeyEnv": "ISISLLM_API_KEY",
  "timeoutMs": 8000,
  "exclude": ["^test-", "^sandbox/"],
  "models": {
    "some-model": {
      "name": "Some Model",
      "reasoning": true,
      "input": ["text"],
      "contextWindow": 262144,
      "maxTokens": 131072,
      "compat": { "thinkingFormat": "qwen-chat-template", "maxTokensField": "max_tokens" }
    }
  },
  "quietModelsJsonWarning": false
}
```

Per-model entries accept exactly the fields in the table under [How models are described](#how-models-are-described)
(`thinkingLevelMap` also allowed), and they outrank the gateway's reported token limits for that id.
`exclude` patterns are appended to the bundled ones; an id with a `models` entry is never excluded.

Invalid fields are ignored with a warning shown by `/isisllm status`; the extension still loads.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401 … not allowed to list models` | Missing/expired key, or a key that may call `/chat/completions` but not `/v1/models`. Re-export `ISISLLM_API_KEY` or `/login` again. pi keeps the last cached catalog meanwhile; with none, nothing is listed until the key works. |
| `returned an HTML page, not JSON` | The base URL is wrong. Open WebUI serves an SPA for unknown paths, so the gateway answers `200` with HTML. `ISISLLM_BASE_URL` must end in `/v1`. |
| No ISIS LLM models in `/model` at all | Nothing has been discovered yet — fresh install, no key, or an unreachable gateway. `/isisllm status` shows `· none · refreshed never`; fix the key/URL and run `/isisllm refresh`. |
| Models listed but no new ones appear | Discovery failed and pi kept the last cached catalog — check `/isisllm status` for the last error, and `/isisllm doctor` for a live probe. |
| `/model` shows no ISIS LLM models, but `/isisllm models` lists them | No credentials yet. pi hides models whose provider has no usable key, so export `ISISLLM_API_KEY` (or `/login`) and they appear. `/isisllm status` shows `N/M selectable right now`. |
| A model disappeared from `/model` | The gateway stopped serving that id — the catalog is live-only, so it goes away on the next refresh. Confirm with `/isisllm models` or `curl -H "Authorization: Bearer $ISISLLM_API_KEY" $ISISLLM_BASE_URL/models`. |
| Newly published model shows up a second after launch | Expected: discovery runs shortly after the session opens and retries once if pi's own refresh passes cancelled it. `/isisllm refresh` forces it immediately. |
| A model you expect is missing | Its id matches an `exclude` pattern (embeddings, TTS, image models are filtered by default). Check `/isisllm models`, then add a `models` entry for it — curated and overridden ids are never excluded. |
| Model answers but thinking/tools look wrong | It is `(unverified)`: heuristics guessed its capabilities. Set the right `reasoning` / `compat` in the settings file (see above). |
| Token limits or a retired model look wrong | Your `models.json` still defines `isisllm`: those entries override the live ones and linger after retirement. `/isisllm doctor` confirms; delete that block. |
| Warm turns repeatedly process the full prompt | Run `/isisllm refresh` to replace old cached compatibility metadata, remove a shadowing `isisllm` block in `models.json`, and check per-model affinity overrides and Pi cache retention. The gateway must enable session affinity for the model group; restarts, expiry and failover can still move a conversation. |
| Startup feels slow | It shouldn't: discovery is never awaited during startup and gives up after `timeoutMs` (default 8000 ms). |

## Development

```bash
npm install
npx tsc --noEmit      # types
npx vitest run        # unit tests (fixture-driven, no network)
npx biome check .     # format + lint
pi -e ./ --list-models
pi -e ./ -p "reply with OK" --model isisllm/qwen3-coder-next
```

See [AGENTS.md](AGENTS.md) for the architecture map and invariants, and
[CHANGELOG.md](CHANGELOG.md) for releases.

## How it works

```
index.ts      factory: build the provider, register it, refresh once per session, /isisllm
auth.ts       env-first key resolution, masked /login prompt
discovery.ts  GET {baseUrl}/models, error classification, no secrets in messages
metadata.ts   pure defaults → live limits → preset metadata → local overrides, clamping, heuristics
presets.json  metadata + defaults + exclude/reasoning/thinkingFormat patterns
config.ts     env + settings file + presets merging
```

Caching is deliberately pi's job: `createProvider({ fetchModels })` restores and persists the
catalog (`~/.pi/agent/models-store.json`). This extension keeps only an in-memory record of the
last attempt for `/isisllm status`.

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).

```
pi-isisllm — ISIS LLM gateway provider for pi
Copyright (C) 2026 Samuel Jones

This program is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
```

pi itself is MIT and is consumed as an optional peer dependency, so it stays unaffected by this
licence: nothing of pi's source is redistributed here.
