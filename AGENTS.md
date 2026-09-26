# AGENTS.md — Contributor Map

Onboarding for this extension. Operators: [HUMANS.md](HUMANS.md). What it does: [README.md](README.md).

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/door.ts` | `/openai/v1/models` row -> `EnginedModelInfo` mapping, poll-change serialization, reasoning-level ordering/snapping. No `vscode` import. |
| `src/chatStream.ts` | SSE reader for `/openai/v1/chat/completions`, ported from engined's own `src/cursorChat.ts`. No `vscode` import. |
| `src/requestBuilder.ts` | Plain VS Code-shaped messages -> the OpenAI chat request body; token estimation. No `vscode` import. |
| `src/toolRequests.ts` | Route picking and request shapes for the four `engined_*` tools. No `vscode` import. |
| `src/pathGuard.ts` | The workspace-folder trust boundary every tool path crosses. No `vscode` import. |
| `src/polling.ts` | `ModelPoller`: fires only on an actual list change, empties after 3 consecutive failures. No `vscode` import. |
| `src/doorClient.ts` | The only file that calls `fetch` against the door. No `vscode` import. |
| `src/config.ts` | Reads/writes `engined.*` settings. The only file besides `extension.ts` that imports `vscode`. |
| `src/extension.ts` | The adapter: registers the chat provider, tools, status bar, and log; converts real `vscode` values to/from the plain shapes above. Everything decision-shaped belongs in the files above, not here. |

## Invariants

- No request to engined that would load a model just to answer a *listing* question — `GET /openai/v1/models` is always safe to poll; nothing else is called from the poller.
- Never send `tools`/`tool_choice` to a model row whose `tools` is `false` — the door refuses it anyway (engined `src/responses.ts:133-147`), but this extension must not rely on that refusal.
- Every tool input/output path resolves inside an open workspace folder (`pathGuard.ts`) before it touches the filesystem.
- The "engined" output channel never logs request or response content — only poll failures, HTTP status + door error text, and state changes.
- `reasoning_effort` is sent only when a row's `capabilities.reasoning` is non-empty, snapped to a level that row actually lists.

## Testing

`bun test`, no VS Code host, no mocks: see [CONTRIBUTING.md](CONTRIBUTING.md) § Testing.
