# AGENTS.md — Contributor Map

Onboarding for this extension. Operators: [HUMANS.md](HUMANS.md). What it does: [README.md](README.md).

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/door.ts` | `/openai/v1/models` row -> `EnginedModelInfo` mapping, poll-change serialization, reasoning-level ordering/snapping, and door id qualification (`qualifyId`/`splitQualifiedId`/`doorByName`/`qualifiedEngineIds`). No `vscode` import. |
| `src/chatStream.ts` | SSE reader for `/openai/v1/chat/completions`, ported from the SSE reader in [`Rethunk-Tech/engined`](https://github.com/Rethunk-Tech/engined). No `vscode` import. |
| `src/requestBuilder.ts` | Plain VS Code-shaped messages -> the OpenAI chat request body; token estimation. No `vscode` import. |
| `src/toolRequests.ts` | Request shapes for the four `engined_*` tools, built against an already-resolved row. No `vscode` import. |
| `src/defaultModels.ts` | `resolveDefaultModel`: the one selection rule behind every `engined.defaultModels.*` setting (configured id if it still qualifies, else the automatic pick). No `vscode` import. |
| `src/completions.ts` | Prefix/suffix slicing, the `/openai/v1/completions` request/reply shapes, and the inline-completion provider's document-selector schemes. No `vscode` import. |
| `src/neighbourContext.ts` | Snippet selection for completions' `extra` field (cap, ordering, exclusion). No `vscode` import. |
| `src/status.ts` | Status bar text/tooltip formatting and the route-header-vs-fallback resolution. No `vscode` import. |
| `src/usageReport.ts` | Aggregates `GET /engined/v1/usage` rows across doors into totals and the per-day/per-route Markdown tables `engined: Usage Report` shows. No `vscode` import. |
| `src/pathGuard.ts` | The workspace-folder trust boundary every tool path crosses. No `vscode` import. |
| `src/polling.ts` | `ModelPoller`: tracks both the chat-only model list and every answerable row; fires only on an actual change, empties after 3 consecutive failures. No `vscode` import. |
| `src/doorClient.ts` | The only file that calls `fetch` against the door; `fetchAllDoors` fans a poll out across every configured door and merges the reachable ones. No `vscode` import. |
| `src/search.ts` | Chunking a file into overlapping windows, cosine top-k, index-update planning (which files a refresh must touch), and folding a rerank reply back over the cosine order. No `vscode` import. |
| `src/engineEvents.ts` | SSE frame parsing for `GET /engined/v1/engines/events` and the reconnect-backoff sequence. No `vscode` import. |
| `src/engineTree.ts` | `GET /engined/v1/engines` JSON -> the plain tree-item rows the Engines view renders (door-qualified, category-based description, resource-fetch eligibility), and `GET .../resources` JSON -> its one-line display. No `vscode` import. |
| `src/tokenCount.ts` | `provideTokenCount`'s cache-then-door-then-estimate decision, and the small LRU keyed by (model, content hash) behind it. No `vscode` import. |
| `src/config.ts` | Reads/writes `engined.*` settings, including `engined.doors`. Imports `vscode`. |
| `src/searchIndex.ts` | The workspace-scanning/storage half of `engined_search`: finds candidate files, keeps the chunk+vector index in `context.storageUri`, calls `search.ts` for the pure logic. Imports `vscode`. |
| `src/engineExplorer.ts` | The Engines `TreeDataProvider`, its commands (warm/hold/release/stop/logs/copy-fix), a door-group parent level once more than one door is configured, and the live-events subscription that refreshes it. Imports `vscode`. |
| `src/extension.ts` | The adapter: registers the chat provider, tools, status bar, and log; converts real `vscode` values to/from the plain shapes above. Everything decision-shaped belongs in the files above, not here. |

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
- The Engines view's "held" flag tracks holds this session itself placed via `engined.holdEngine` -- `GET /engined/v1/engines` reports no held-until field, so a hold placed by another process is invisible until a start attempt hits its 409.
- `engined.doors` replaces `engined.url` outright (greenfield -- no alias). A row's `id` is `qualifyId`'d against its door and is what VS Code/settings see; `routeId` is the door's own unqualified id and is the only thing ever sent in a request body. Every request goes to the door that owns the row/engine it names, never a single configured URL.
- `GET /engined/v1/engines/:id/resources` is fetched only for an engine the Engines view categorizes as a running, local, container-kind engine -- an `agentic-cli` engine, an unavailable one, and one backing only remote-egress rows never get a `resources` call, and their raw JSON never reaches the tree.

## Testing

`bun test`, no VS Code host, no mocks: see [CONTRIBUTING.md](CONTRIBUTING.md) § Testing.
