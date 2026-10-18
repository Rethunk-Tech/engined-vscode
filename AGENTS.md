# AGENTS.md — Contributor Map

Onboarding for this extension. Operators: [HUMANS.md](HUMANS.md). What it does: [README.md](README.md).

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/door.ts` | `/openai/v1/models` row -> `EnginedModelInfo` mapping, poll-change serialization, reasoning-level ordering/snapping, and door id qualification (`qualifyId`/`splitQualifiedId`/`doorByName`/`qualifiedEngineIds`). No `vscode` import. |
| `src/chatStream.ts` | SSE reader for `/openai/v1/chat/completions`, ported from the SSE reader in [`Rethunk-Tech/engined`](https://github.com/Rethunk-Tech/engined), and `buildCopilotUsage` (the reader's own `ChatUsage` -> the OpenAI usage JSON Copilot's context-window meter reads). No `vscode` import. |
| `src/imageStream.ts` | SSE reader for image `progress`/`preview`/`image`/`error` events. No `vscode` import. |
| `src/requestBuilder.ts` | Plain VS Code-shaped messages -> the OpenAI chat request body; token estimation. No `vscode` import. |
| `src/toolRequests.ts` | Request shapes for the `engined_*` tools, built against an already-resolved row. No `vscode` import. |
| `src/defaultModels.ts` | `resolveDefaultModel`: the one selection rule behind every `engined.defaultModels.*` setting (configured id if it still qualifies, else the automatic pick). No `vscode` import. |
| `src/completions.ts` | Prefix/suffix slicing, the `/openai/v1/completions` request/reply shapes, and the inline-completion provider's document-selector schemes. No `vscode` import. |
| `src/neighbourContext.ts` | Snippet selection for completions' `extra` field (cap, ordering, exclusion). No `vscode` import. |
| `src/configUi.ts` | Runs `engined --configsvc-url` (runner injectable) and turns its output into the config UI URL or the CLI's explanation behind `engined: Open Config UI`. No `vscode` import. |
| `src/status.ts` | Status bar text/tooltip formatting and the route-header-vs-fallback resolution. No `vscode` import. |
| `src/usageReport.ts` | Aggregates `GET /engined/v1/usage` rows across doors into totals and the per-day/per-route Markdown tables `engined: Usage Report` shows. No `vscode` import. |
| `src/workspaceTools.ts` | The five `engined_*` language-model tools (confirmation dialogs, workspace file I/O); reaches the activation module's state only through `ToolHost`. Imports `vscode`. |
| `src/background.ts` | `runInBackground`: starts a promise without awaiting it and routes a rejection to a handler instead of an unhandled rejection. No `vscode` import. |
| `src/cancellation.ts` | `vscode.CancellationToken` -> `AbortSignal` for tool calls. No `vscode` import. |
| `src/constants.ts` | Shared numeric/HTTP/context-key literals. No `vscode` import. |
| `src/describeError.ts` | Thrown value -> the one-line status/log/tool text. No `vscode` import. |
| `src/unreachable.ts` | Exhaustive-`switch` terminator (`never`). No `vscode` import. |
| `src/compareCodeUnits.ts` | UTF-16 code-unit string order. No `vscode` import. |
| `src/pathGuard.ts` | The workspace-folder trust boundary every tool path crosses. No `vscode` import. |
| `src/polling.ts` | `ModelPoller`: tracks both the chat-only model list and every answerable row; fires only on an actual change, empties after 3 consecutive failures. No `vscode` import. |
| `src/doorClient.ts` | The only file that calls `fetch` against the door; `fetchAllDoors` fans a poll out across every configured door and merges the reachable ones. No `vscode` import. |
| `src/search.ts` | Chunking a file into overlapping windows, cosine top-k, index-update planning (which files a refresh must touch), and folding a rerank reply back over the cosine order. No `vscode` import. |
| `src/engineEvents.ts` | SSE frame parsing for `GET /engined/v1/engines/events` and the reconnect-backoff sequence. No `vscode` import -- `pollDriver.ts` owns the reader loop. |
| `src/engineTree.ts` | `GET /engined/v1/engines` JSON -> the plain tree-item rows the Engines view renders (door-qualified, category-based description, resource-fetch eligibility), and `GET .../resources` JSON -> its one-line display. No `vscode` import. |
| `src/tokenCount.ts` | `provideTokenCount`'s cache-then-door-then-estimate decision, and the small LRU keyed by (model, content hash) behind it. No `vscode` import. |
| `src/chatSettingsPlan.ts` | The settings `engined.useForAllChatFeatures` writes and how to restore them. No `vscode` import. |
| `src/promptFingerprint.ts` | Content-free hashes/offsets locating where a chat request first differs from the previous one (prompt-cache diagnostics). No `vscode` import. |
| `src/promptSplit.ts` | Splits long prompt text at structural boundaries so hybrid models can resume a cached prompt at more points. No `vscode` import. |
| `src/config.ts` | Reads/writes `engined.*` settings, including `engined.doors`. Imports `vscode`. |
| `src/searchIndex.ts` | The workspace-scanning/storage half of `engined_search`: finds candidate files, keeps the chunk+vector index in `context.storageUri`, calls `search.ts` for the pure logic. No `vscode` import. |
| `src/searchHost.ts` | `SearchHost` plus the production `vscode` implementation `engined_search` uses. Imports `vscode`. |
| `src/engineExplorer.ts` | The Engines `TreeDataProvider`, its commands (warm/hold/release/stop/logs/copy-fix), a door-group parent level once more than one door is configured (its description and tooltip carry that list's `config_error` when present), and the view message naming each door that failed or refused its config. Imports `vscode`. |
| `src/routeHeaders.ts` | `x-engined-route/egress/chain/cost-usd` response headers -> a call's route and cost. No `vscode` import. |
| `src/session.ts` | The `Session` object `activate` builds once: output channel, status bar, poller, caches and timers, passed explicitly to every module below (the shape `ToolHost` and `SearchHost` use for the tools and the search index). Type-only `vscode` import. |
| `src/chatProvider.ts` | The `LanguageModelChatProvider`: VS Code messages <-> plain shapes, the streamed reply, token counts, and each call's status-bar record. Imports `vscode`. |
| `src/completionProvider.ts` | The inline-completion provider and the recent-document tracking behind its neighbour context. Imports `vscode`. |
| `src/statusBar.ts` | Status bar text and tooltip, today's-usage cache, the loading ticker, the one-time unreachable notice. Imports `vscode`. |
| `src/pollDriver.ts` | The model-poll timer and the per-door engine-events streams that slow it to a fallback. |
| `src/routes.ts` | `resolveRoleRow`: a tool's route through `resolveDefaultModel`, logging an unusable configured id once per change. |
| `src/chatSettings.ts` | `engined.useForAllChatFeatures` / `restoreChatSettings`. Imports `vscode`. |
| `src/commands.ts` | Quick-pick, warm/hold/release, effort, default-model and usage-report commands, and the Engines tree-item commands. Imports `vscode`. |
| `src/extension.ts` | `activate`/`deactivate`: builds the `Session`, registers every provider, tool, view and command. |

## Invariants

- No request to engined that would load a model just to answer a *listing* question — `GET /openai/v1/models` is always safe to poll; nothing else is called from the poller.
- Token counts prefer `POST /engined/v1/tokenize` (vocab-only, no weights loaded) for a row that lists it in `serves`, and fall back to the chars/3 estimate on any failure or when the row doesn't serve it -- never the chat-template-expanding `GET /engined/v1/engines/:id/tokenize`.
- Never send `tools`/`tool_choice` to a model row whose `tools` is `false` — the door refuses it anyway (see [`Rethunk-Tech/engined`](https://github.com/Rethunk-Tech/engined)'s request-validation path), but this extension must not rely on that refusal.
- Every tool input/output path resolves inside an open workspace folder (`pathGuard.ts`) before it touches the filesystem.
- A tool, the completions picker, and `engined: Choose Default Models` all pick a route through `defaultModels.ts`'s `resolveDefaultModel` -- there is no second picking rule anywhere else.
- A tool picks its route from `ModelPoller.rows` (every answerable row), never from `.models` (the chat-only subset) -- a comfy, TTS, or STT row never serves chat.
- The "engined" output channel never logs request or response content — only poll failures, HTTP status + door error text, and state changes.
- `reasoning_effort` is sent only when a row's `capabilities.reasoning` is non-empty, snapped to a level that row actually lists.
- `engined_search` only embeds/reranks through a route whose `egress` is `none`, unless `engined.search.allowRemote` is set.
- The Engines view marks a row held when `GET /engined/v1/engines` reports `held_until` (ISO-8601) still in the future, and appends that time; an absent field means the list is not holding it. A hold this session just placed stays in `heldEngineIds` so it shows before the next poll returns the field. Release Hold offers the union of that set and every row whose `held_until` is still ahead.
- The same listing's `idle_until` (ISO-8601), present on a running engine with zero leases, is appended as `idle until <time>` while that instant is still ahead. A past, equal, or missing value adds nothing. Hold text, categorization, and resource fetches stay as they are.
- The same listing's `superseded`, present on a running engine whose config generation `reload` has replaced, is appended as `config stale <stop path>` (the field's value, e.g. `/engined/v1/engines/foo/stop`). An absent field adds nothing. Hold text, idle-until text, categorization, and resource fetches stay as they are.
- The same listing's `roles` and `active_leases` are read off the engines response already in hand. When any role has `waiting` greater than zero, the row description appends the sum as `N waiting`, and the tooltip lists each busy role as `<role> <active> active, <waiting> waiting`. A role's optional `model` is appended on that tooltip line when the door sends it. When `active` is 0 and `waiting` is greater than zero, that id is the queue-head GGUF and the description appends it after `N waiting`. An absent `model` adds nothing. Idle-until, hold, and config-stale text stay as they are. A positive `active_leases` fills the tooltip when the engine reports no busy role. Resource fetches, hold text, and categorization are unchanged.
- The same listing's `last_error`, present on an engine whose state is `failed` or `unavailable`, is appended on the row (and on the unavailable tooltip, which is otherwise only the fix). An absent or empty field adds nothing, and any other state, including a running engine that still carries the field, does not show it. Idle-until, hold, config-stale, and role-model text stay as they are.
- The same listing's `capabilities`, when the engine declares any model ids, appends a compact summary of those ids on the Engines tooltip. Four or fewer are named in full; a longer list names the count and one id. An absent field, or entries with no model id, adds nothing. The summary is the engine's declared models, separate from a live role's `model`.
- The same listing's `config_error`, present while a config reload failed to parse, is the door group's description and tooltip. An absent or empty field adds nothing. Idle-until, hold, last_error, capabilities, and role-model text stay as they are.
- The same listing's `discovery`, keyed by engine id, appends that entry's `last_error` and `fetched_at` on the matching agentic-cli row's tooltip when those fields are present (`fetched <time>` for the timestamp). An absent `discovery`, or an entry missing the field, adds nothing. `models` and `findings` stay on the status shape and are not a second capabilities model-id line.
- `engined.doors` is the only configured address list (an array of `{ name, url }`; there is no single-URL setting). A row's `id` is `qualifyId`'d against its door and is what VS Code/settings see; `routeId` is the door's own unqualified id and is the only thing ever sent in a request body. Every request goes to the door that owns the row/engine it names.
- `GET /engined/v1/engines/:id/resources` is fetched only for an engine the Engines view categorizes as a running, local, container-kind engine -- an `agentic-cli` engine, an unavailable one, and one backing only remote-egress rows never get a `resources` call, and their raw JSON never reaches the tree.

## Testing

`bun test`, no VS Code host, no mocks: see [CONTRIBUTING.md](CONTRIBUTING.md) § Testing.

## Gate budget

`.gate.toml` adds the one CI step detection missed: `bunx @vscode/vsce ls --no-dependencies`, which catches a manifest or `.vscodeignore` that would fail packaging, so it runs after the build. GitHub CI, `package.json` `ci`, and pre-push run `gate` (including `workflows` / actionlint).
