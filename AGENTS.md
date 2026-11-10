# AGENTS.md — working in this repo

## What this is

`pi-isisllm` is a pi package (a provider extension, no build step) that registers the ISIS LLM
LiteLLM gateway as a model provider. The model list comes from the gateway's OpenAI-compatible
`GET /v1/models` at runtime, merged with curated defaults from `presets.json`. The extension
deliberately **does not write `~/.pi/agent/models.json`** — users are expected to *delete* their
`isisllm` block, because `models.json` layers above extension providers and would shadow discovery.
Distribution is from git (`github.com/Pasarus/pi-isisllm`), never npm.

## Architecture map

```
index.ts      extension factory: createProvider(...) → pi.registerProvider(provider)
              · live-only catalog: cold-start seed, then each refresh replaces it wholesale
              · deferred, retried, fire-and-forget refresh on session_start (pi boots cache-only)
              · startup widget + /isisllm [status|models|refresh|doctor]
   ├─ auth.ts        ApiKeyAuth: env var first, then the /login credential; masked login()
   ├─ discovery.ts   fetchGatewayModels(): GET {baseUrl}/models + error classification
   │                 discoverModels(): key resolution → fetch → metadata → in-memory state
   ├─ metadata.ts    pure functions: toPiModel(), buildModels()
   │                 live token limits → preset metadata → local overrides, + clamping
   └─ presets.json   metadata for known ids + defaults, exclude/reasoning/thinkingFormat patterns
config.ts     env + ~/.pi/agent/settings/pi-isisllm.json + presets → IsisllmConfig
types.ts      shared shapes (no runtime imports beyond pi types)
test/         vitest suites + fixtures/models.json (captured real gateway response)
```

Caching belongs to pi, not to us: `createProvider({ fetchModels })` restores the persisted catalog
from `~/.pi/agent/models-store.json`, skips the fetch when `allowNetwork` is false, and publishes
**and persists** whatever `fetchModels` returns. Never hand-roll a cache here. `discovery.ts` keeps
only an in-memory `DiscoveryState` (last attempt, count, source, error) for the status command.

## Commands

```bash
npm install              # dev deps only (pi packages are peer deps, provided by the host)
npx tsc --noEmit         # types
npx vitest run           # unit tests, no network
npx biome check .        # format + lint (biome check . --write to fix)
pi -e ./ --list-models   # live catalog (needs a key; one bounded fetch on a cold cache)
pi -e ./ -p "reply with OK" --model isisllm/qwen3-coder-next   # real round trip
```

Isolate your real config when testing install/auth behaviour:
`PI_CODING_AGENT_DIR=$(mktemp -d) pi -e ./ --list-models`. pi's persisted catalog is
`$PI_CODING_AGENT_DIR/models-store.json` — delete it to test cold start, or write an entry to
simulate an offline start with a stale catalog (that is how to watch a retired model disappear).

The widget and `/isisllm` need a TTY. Drive the real TUI from a script with `script`(1) — sleep
long enough for the deferred refresh, then feed keystrokes:

```bash
D=$(mktemp -d)
( sleep 8; printf '/isisllm doctor\r'; sleep 5; printf '/exit\r'; sleep 2 ) \
  | PI_CODING_AGENT_DIR=$D timeout 40 script -qec "pi -e ./" /dev/null 2>&1 \
  | tr -d '\r' | grep -a "ISIS LLM\|- "
```

To exercise discovery without touching the gateway, point `ISISLLM_BASE_URL` at a throwaway server
that answers `GET /v1/models` with `{"data":[{"id":…}]}` and honours any Bearer token:

```bash
printf '%s\n' 'import { createServer } from "node:http";' \
  'createServer((_q, res) => res.end(JSON.stringify({ data: [' \
  + '{ id: "qwen3-coder-next", max_input_tokens: 131072, max_output_tokens: 131072 },' \
  + '{ id: "zzz-live-only", max_input_tokens: 65536, max_output_tokens: 8192 } ] })))' \
  '.listen(8731, "127.0.0.1");' > /tmp/fakegw.mjs && node /tmp/fakegw.mjs &
ISISLLM_BASE_URL=http://127.0.0.1:8731/v1 ISISLLM_API_KEY=x PI_CODING_AGENT_DIR=$(mktemp -d) \
  pi -e ./ --list-models     # expect exactly the two ids above, never the presets
```

Tests that unset an env var use `delete process.env.X` (assigning `undefined` would store the
string `"undefined"`), which is why `performance/noDelete` is off for `test/**` in `biome.json`.

## Invariants — read before changing anything

- **Never write or migrate `models.json`** (or `auth.json`). The only file access allowed is
  read-only: `presets.json`, the settings file, and the shadow check in `readModelsJsonShadow()`.
- **Never log, echo, or notify an API key.** Keys may only be requested through pi's
  `interaction.prompt({ type: "secret" })`, and only the *source label* (`ISISLLM_API_KEY` /
  `stored credential`) may reach a UI string. `discovery.ts` additionally redacts the key from any
  message built from a response body.
- **Provider id stays `isisllm`.** Existing sessions, `--model isisllm/...`, and `ISISLLM_API_KEY`
  all depend on it. Display name is `ISIS LLM`.
- **The catalog is live-only: exactly what `/v1/models` reported, minus `exclude` matches.** The
  provider starts from the cold-start seed (or nothing) and is then replaced wholesale by each
  refresh, so a retired model disappears on the next refresh. Do not "helpfully" re-add curated
  presets to the registration — a list the user cannot trust is worse than an empty one.
  `presets.json` is metadata only. Offline starts still work because *pi* restores the persisted
  catalog; `modelSource()` labels that state `cached` (vs `live` after our own fetch, `none` when
  nothing has been discovered).
- **`presets.json` never registers a model.** Its `models` map only decorates ids the gateway is
  already serving (name, `reasoning`, `input`, token fallbacks). Keep it that way.
- **Token limits follow the deployment.** `contextWindow`/`maxTokens` resolve as settings override →
  gateway `max_input_tokens`/`max_output_tokens` → preset fallback → bundled defaults, because
  deployments get bumped without anyone editing this repo. Every other field keeps the ordinary
  defaults → preset → override order. Both token fields are then clamped (see below).
- **No network in the extension factory, and never await the startup refresh.** pi starts the model
  runtime with `allowModelNetwork: false`; `session_start` triggers the network refresh
  unawaited with its own deadline so a dead gateway cannot stall boot. The refresh is deliberately
  delayed (750 ms) and retried once, because pi aborts an in-flight provider refresh whenever
  another pass starts for the same provider — including the cache-only passes it fires around
  startup and on session events. Any immediate refresh you add will be silently cancelled; its
  result surfaces as `model discovery was cancelled`. Refresh timers are `unref()`d so a print-mode
  run can still exit. And never await it *in a mode that is about to run a model*: a forced refresh
  in flight while `pi -p` resolves its model makes the run print **nothing at all** (verified).
- **The only factory-time network call is the cold-start seed.** pi resolves `--model` and renders
  `--list-models` *before* `session_start`, so a live-only provider would answer "Model not found"
  on a fresh machine. `hasCachedIsisllmCatalog()` (a read of `~/.pi/agent/models-store.json`) gates
  one bounded `discoverModels({ timeoutMs: SEED_TIMEOUT_MS })` whose result becomes the provider's
  initial `models`. Once pi has a cached catalog the call never happens again; without a key it is
  skipped, and a failure just leaves the catalog empty.
- **Never dereference a captured `ctx` after an `await`.** pi throws (`This extension ctx is
  stale …`) once the session is replaced or a print run ends, and an escaped rejection from an
  unawaited task takes the process down. Copy `ctx.modelRegistry` / `ctx.ui` into `Services`
  (`servicesOf`) before the first await, and swallow the rest.
- **Report registered models, not `getAvailable()`.** pi hides models whose provider has no usable
  credentials, so `getAvailable()` reads "0 models" while the user is still signing in. Widget and
  `/isisllm` count `provider.getModels()` and add a `N/M selectable right now` note instead.
- **Pass the signal to every fetch.** `RefreshModelsContext.signal` is always present; our own
  `AbortController` deadline wraps it in `discovery.ts`/`index.ts`.
- **`maxTokens` is always clamped to `contextWindow / 2`** (`clampMaxTokens`), minimum 1024.
  Several deployments report `max_output_tokens == max_input_tokens == 131072`, and prompt plus
  completion share the window.
- **Unknown ids keep the `(unverified)` name suffix.** `index.ts` derives curated/unverified counts
  from that suffix — don't rename it casually, and don't strip it in overrides without a reason.
- **Every `.ts` file starts with the two SPDX lines** (`AGPL-3.0-or-later`, copyright Samuel
  Jones). New files must carry them; `LICENSE` is verbatim FSF text — never edit it.
- **No runtime `dependencies`, no build step.** pi loads the `.ts` files with jiti; imports use
  `.js` specifiers (NodeNext style) and `import type` for types, which is what keeps `tsc` and
  jiti both happy.
- **Conversation affinity uses pi's own session id.** All models built here are `isisllm`
  `openai-completions` models. Default `compat.sendSessionAffinityHeaders` to `true` and
  `compat.sessionAffinityFormat` to `"openrouter"` before merging curated/local compatibility,
  so pi sends `x-session-id` and explicit overrides still win. Never derive affinity from an API
  key or generate a replacement UUID. Pi omits these headers with `cacheRetention: "none"`.
  Responses uses `sessionAffinityFormat` alone; this extension does not register that API.
- **Stream path is pi's own** (`api: openAICompletionsApi()`). Don't add a custom `streamSimple`
  unless the gateway stops being OpenAI-compatible.

## Adding or fixing a model

1. Confirm the id and token limits: `curl -H "Authorization: Bearer $ISISLLM_API_KEY" $ISISLLM_BASE_URL/models`.
   If the gateway does not report the id, nothing added here will make it appear — the catalog is
   live-only.
2. Add an entry to `presets.json` → `models`:
   - `name` — label in `/model` (no `(unverified)` suffix; curated entries don't get one).
   - `reasoning` — true only if the model actually emits reasoning/thinking output.
   - `input` — `["text"]` unless you verified image input works; `/v1/models` never tells us.
   - `contextWindow` / `maxTokens` — fallbacks only: the gateway's reported limits win, so these are
     what users get when `/v1/models` omits them. Keep `maxTokens` at most half of `contextWindow`.
   - `compat.maxTokensField` — `"max_tokens"` for vLLM/LiteLLM (`max_completion_tokens` is rejected).
   - `compat.thinkingFormat` — chat-template dialect used to toggle thinking, e.g.
     `"qwen-chat-template"`; omit for models pi can auto-detect.
   - Optional `thinkingLevelMap` to map pi's levels onto provider values.
3. If the id looks non-chat but shouldn't be excluded, add a `models` entry (curated and
   overridden ids bypass `exclude`), or adjust `exclude`.
4. Add/adjust a case in `test/metadata.test.ts`, update `CHANGELOG.md`, and bump `package.json`
   `version` in the same commit.
5. Local-only experiment instead of a PR: put the same metadata under `models` in
   `~/.pi/agent/settings/pi-isisllm.json`.

## Gateway gotchas

- Only `/v1/models` answers JSON. Other LiteLLM admin paths (`/v2/model/info`, `/model/group`, …)
  are swallowed by the Open WebUI SPA and return **HTML with status 200**, which is why a wrong
  base URL must be detected by content type, not status code.
- No key → `401`. A key that can chat but not list models also fails here — surface it as an
  auth error; pi keeps showing whatever it had cached.
- `max_output_tokens` frequently equals the context window (see the clamp invariant), and some
  models report no limits at all.
- `/v1/models` carries **no** capability data: no reasoning flag, no modalities, no cost. Cost is
  always `0` here.
- pi composes `~/.pi/agent/models.json` *above* this provider (`composeModelProvider` →
  `applyModelsJson`): same-id entries replace the discovered definitions, and extra ids are
  appended — so a stale block can pin `baseUrl`/`compat`/token limits and resurrect retired models.
  A native provider cannot overrule that layer (only the legacy object-form
  `pi.registerProvider(name, { models })` replaces the whole list, and it would cost us
  `fetchModels` plus native `/login`), which is why `readModelsJsonShadow()` only warns.

## Release / distribution

CI (`.github/workflows/ci.yml`) is typecheck + `biome check .` + `vitest run` on Node 22 with
`npm ci`, so a stale `package-lock.json` or a lint failure blocks the merge. `.github/dependabot.yml`
opens weekly npm PRs (minor+patch grouped, majors separate — majors can break the pi peer
dependency, so read them) and monthly GitHub Actions PRs.

Ships from git, not npm:

1. Update `CHANGELOG.md` under a `## X.Y.Z` heading and set the same `version` in `package.json`
   in the same commit (pi shows package changelogs by version).
2. `git tag vX.Y.Z && git push origin main --tags`.
3. Users install with `pi install git:github.com/Pasarus/pi-isisllm` (optionally `@vX.Y.Z` to pin);
   `pi update --extensions` reconciles.
4. Verify the tag actually installs into a clean agent dir:
   `PI_CODING_AGENT_DIR=$(mktemp -d) pi install git:github.com/Pasarus/pi-isisllm@vX.Y.Z`.

## Requirements for code changes

Only run the checks that the changed files make relevant — a `.md`-only change needs none of them.
When you touch TypeScript, `presets.json`, or config, before calling the change done:

1. `npx tsc --noEmit`, `npx biome check .`, `npx vitest run` — all three, clean, no new skips.
2. Add or update a Vitest case for any behaviour change; the suites are pure (no network), so
   new logic belongs in `metadata.ts`/`discovery.ts` behind injectable `fetchImpl`/`env`.
3. If the change is user-visible, update `README.md` (and its Troubleshooting table), then
   `CHANGELOG.md` and `package.json` `version` in the same commit.
4. Anything touching startup, the catalog, or credentials: run the manual checks under *Commands*
   against the fake gateway as well as the real one. Unit tests cannot see pi's refresh races, the
   live-only catalog, or the widget.

## General working practices

- Prefer the `read` tool over `sed`/`cat` for files, and `edit`/`write` over shell `sed -i` or
  heredocs. The permission policy in this workspace denies `sed`/`rm -rf` one-liners on purpose.
- Never write outside the repo: no `~/.pi/agent/models.json`, no `auth.json`, no editing the user's
  settings file. Ask the user before touching their own config, and take a timestamped backup.
- Never `git push`, tag, or create a repo without an explicit go-ahead, and do not add
  `Co-Authored-By` model trailers to commits in this repo.
- If a task is ambiguous — does this belong in `presets.json` or the settings file, should a model
  be excluded, does a pi API behave the way I assume — ask, or read pi's `dist/` source for the
  answer. Do not guess and ship.

## Keeping this document up to date

If a change makes anything here wrong — a new invariant, a renamed file, a changed command, a new
pi version whose refresh/registration behaviour differs, a new CI workflow or Dependabot group —
fix this file in the same commit. Stale agent docs are worse than none.

## Licence

AGPL-3.0-or-later (`LICENSE` is the verbatim FSF text, `package.json` carries the SPDX id, every
source file has the two header lines). pi is MIT and only an optional peer dependency, so it is
not relicensed and no pi source is redistributed. If you vendor code from elsewhere, check its
licence is compatible with AGPL (MIT/Apache-2.0 yes, GPL-incompatible or proprietary no).
