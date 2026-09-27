# HUMANS.md — Operator Guide

Build, run, use, and configure this extension. Contributors: [CONTRIBUTING.md](CONTRIBUTING.md). What it is: [README.md](README.md).

## Quick start

1. Start engined and confirm it answers: `systemctl --user start engined && curl http://127.0.0.1:29200/openai/v1/models`.
2. Open Copilot Chat's model picker and choose an `engined` model.
3. Attach a tool (`#enginedImage`, `#enginedReadImage`, `#enginedTranscribe`, `#enginedSpeak`) to a request, or just start typing for inline completions.

Building the extension from source: see Prerequisites and Build below. Uninstalling: use VS Code's Extensions view, or delete the `.vsix`-installed folder under your VS Code extensions directory.

## Prerequisites

- [Bun](https://bun.sh) 1.4.x
- VS Code ≥ 1.138.0 (see `engines.vscode` in `package.json`)
- engined running locally, or reachable via Remote-SSH

## Build

```bash
bun install
bun run build   # dist/extension.cjs
```

## Test

```bash
bun run test       # bun test, no VS Code host required
bun run typecheck
bun run lint
bun run ci          # lint -> typecheck -> test -> build -> vsce ls
```

## Run inside VS Code

Open this folder in VS Code and press F5 (Run Extension) to launch an Extension Development Host with this extension loaded. Open a workspace folder in that window, open the chat view, and pick a model under the "engined" provider.

## Package

```bash
bun run build
bun run package   # bunx @vscode/vsce package --no-dependencies -> engined-vscode-<version>.vsix
```

The `.vsix` is not committed (`*.vsix` is gitignored); build it locally to verify or to install manually via "Extensions: Install from VSIX...".

## Usage

- **Chat models** — an `engined` provider (`vendor: "engined"`) backed by engined's `GET /openai/v1/models` and `POST /openai/v1/chat/completions`. Polling internals: [docs/polling.md](docs/polling.md). engined's text-only routes (agent CLIs such as Claude or Cursor via engined, `tools: false`) don't show up here — VS Code only lists tool-calling models in the picker; reach those routes from another engined consumer.
- **Agent tools** — `engined_generateImage`, `engined_readImage`, `engined_transcribe`, `engined_speak` reach engined's image, vision and audio routes under any chat model in the picker, not only engined's own. Each confirms the route it will use and warns when content will leave the machine. Full parameters: [docs/tools.md](docs/tools.md).
- **Search** — `engined_search` (`#enginedSearch`) does semantic search over the open workspace via engined's embeddings route. It builds a chunk+vector index lazily on first use (workspace files, minus `files.exclude`/`search.exclude`, capped at `engined.search.maxChunks` chunks), keeps it current on save/create/delete, and, when an installed route serves `/openai/v1/rerank`, reranks its top candidates before returning `maxResults` snippets. Only a local (`egress: none`) embedding/rerank route is used unless `engined.search.allowRemote` is set.
- **Engines view** — an "engined" activity-bar container with an Engines tree: every engine `GET /engined/v1/engines` reports, with a state icon and, expanded, its resource usage. Item actions: show logs (a dedicated "engined: `<engine>` logs" output channel, truncated to the last 500 lines — an engine's own log, never a prompt or reply), warm, hold, release hold, and stop (with a modal confirmation naming the engine). An `unavailable` engine shows its `fix` string as the tooltip, with a "Copy fix command" action.
- **Inline completions** — ghost text backed by engined's `POST /openai/v1/completions`, for whichever row `engined.defaultModels.completion` resolves to (or the first that serves the route, when unset). Debounced and abortable. When `engined.completions.neighbourContext` is on and the resolved row's egress is local, snippets from other open or recently active editors are sent alongside the prompt.
- **Status bar** — shows the last chat call's answering route, local/remote egress, prompt/completion token counts, and wall time; a loading state while a request is in flight or its row is warming up; and whether the door is reachable. Click it for a quick pick: refresh models, warm a model, hold/release an engine, set reasoning effort, choose default models, or show the log.
- **Use engined for everything** — `engined: Use engined for All Chat Features` points VS Code's chat defaults at one engined model (new chats, utility models, plan/explore agents) and turns off Copilot's own inline suggestions. It saves your current values first, and `engined: Restore Previous Chat Settings` puts them back. This steers defaults only — Copilot's models stay in the picker. To guarantee no Copilot charges, set your premium-request budget to $0 in your GitHub Copilot settings, or don't sign VS Code into GitHub.
- **Engine control** — `engined: Warm Model` resolves a model address (or chain name) through `POST /engined/v1/start`. `engined: Hold Model` / `engined: Release Hold` call an engine's `hold`/`unhold` verb, so another process can load the same weights without racing the door for the GPU.
- **Settings** — every `engined.*` setting: [docs/settings.md](docs/settings.md).

## Privacy

engined logs no request or response content, and this extension follows the same rule: the "engined" output channel records only poll failures, HTTP errors, and state changes — never a prompt, a response, or tool input/output text. Only what a remote-egress route actually needs leaves this machine: a chat request to a `remote`-egress row, or a tool's own request to one. Neighbouring-file context for completions is sent only to a local (`egress: none`) route. A tool's result (text read from an image, a transcription) goes back to whichever model is running the chat — with a cloud model, that result leaves the machine even though the tool ran locally.

## Troubleshooting

- **Door unreachable** — the status bar shows `engined unreachable` after 3 failed polls. Start it with `systemctl --user start engined` and watch it come up with `journalctl --user -u engined -f`.
- **Models missing from the picker** — `engined: Refresh Models` forces a poll. A model that never appears may not serve `/openai/v1/chat/completions`, or engined reports it `unavailable` — check `curl http://127.0.0.1:29200/openai/v1/models`.
- **A tool says no route is installed** — it picks from every answerable row (`ModelPoller.rows`), not just chat models — confirm the needed route (image/vision/speech/transcription) is actually installed and not `unavailable`.

## Requirements

- No engined-side auth exists; do not point any `engined.doors` entry at anything but a loopback address you trust.
