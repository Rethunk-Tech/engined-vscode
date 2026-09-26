# engined

A VS Code language model provider for [engined](https://github.com/Rethunk-Tech/engined), a local inference door.

- Local chat models in Copilot's model picker, streamed through engined
- Four agent tools: generate/edit images, OCR or describe an image, transcribe or translate audio, synthesize speech
- Inline completions (ghost text), optionally with neighbouring-file context
- Status bar shows what answered, on which route, at what cost, and a loading state

Requires **engined** running on the same machine or reached via VS Code Remote-SSH into the machine running it.

## Quick start

1. Start engined (`systemctl --user start engined`) and confirm it answers: `curl http://127.0.0.1:29200/openai/v1/models`.
2. Open the Chat view's model picker and choose an `engined` model.
3. Attach a tool (`#enginedImage`, `#enginedReadImage`, `#enginedTranscribe`, `#enginedSpeak`) to a request, or just start typing for inline completions.

## Chat models

Registers an `engined` chat provider (`vendor: "engined"`) backed by engined's `GET /openai/v1/models` and `POST /openai/v1/chat/completions`. The model list is polled on a timer and VS Code's picker refreshes only when it actually changes; see [docs/polling.md](docs/polling.md) for the internals. Tool calls and images are forwarded to models that support them, and a reasoning-effort setting is snapped to whatever level each model actually lists -- see [docs/reasoning-effort.md](docs/reasoning-effort.md).

## Agent tools

Four tools reach engined's image, vision and audio routes: `engined_generateImage`, `engined_readImage`, `engined_transcribe`, `engined_speak`. They work under any chat model in the picker, not only engined's own -- the tool itself always runs against engined's local door, but its result goes back to whichever model is running the conversation. Each confirms the route it will use and warns when content will leave the machine. Full parameters and route-selection details: [docs/tools.md](docs/tools.md).

## Inline completions

Offers inline completions (ghost text) backed by engined's `POST /openai/v1/completions`, for whichever row `engined.defaultModels.completion` resolves to (or the first that serves the route, when unset). Debounced and abortable. When `engined.completions.neighbourContext` is on and the resolved row's egress is local, snippets from other open or recently active editors are sent alongside the prompt (capped, current document and configured exclusions dropped).

## Status bar

Shows the last chat call's answering route, local/remote egress, prompt/completion token counts, and wall time; a loading state while a request is in flight or its row is warming up; and whether the door is reachable. The last completion call updates the tooltip only, so ghost text doesn't flicker the status bar text. Click it for a quick pick: refresh models, set reasoning effort, choose default models, or show the log.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `engined.url` | `http://127.0.0.1:29200` | Base URL of the engined door. |
| `engined.pollSeconds` | `30` | How often to re-poll the model list. `0` disables polling (use `engined: Refresh Models` instead). |
| `engined.reasoningEffort` | `medium` | Default reasoning effort for models that support it. |
| `engined.reasoningEffortByModel` | `{}` | Per-model override, keyed by model id. |
| `engined.completions.enabled` | `true` | Offer inline completions (ghost text). |
| `engined.completions.neighbourContext` | `true` | Send snippets from other open/recent editors as completions context. Only sent to a local (`egress: none`) completions route. |
| `engined.defaultModels.image` | `""` | Model id for `engined_generateImage`. Empty is automatic. |
| `engined.defaultModels.ocr` | `""` | Model id for `engined_readImage` OCR mode. Empty is automatic. |
| `engined.defaultModels.vision` | `""` | Model id for `engined_readImage` describe mode. Empty is automatic. |
| `engined.defaultModels.completion` | `""` | Model id for inline completions. Empty is automatic. |
| `engined.defaultModels.speech` | `""` | Model id for `engined_speak`. Empty is automatic. |
| `engined.defaultModels.transcription` | `""` | Model id for `engined_transcribe`. Empty is automatic. |

Run **engined: Choose Default Models** (also in the status bar's quick pick) to set any of the `defaultModels.*` settings from a list of the rows that currently qualify. A configured id that stops qualifying falls back to automatic and logs one line to the "engined" output channel.

## Privacy

engined logs no request or response content, and this extension follows the same rule: the "engined" output channel records only poll failures, HTTP errors, and state changes -- never a prompt, a response, or tool input/output text. Only what a remote-egress route actually needs leaves this machine: a chat request to a `remote`-egress row, or a tool's own request to one. Neighbouring-file context for completions is sent only to a local (`egress: none`) route. A tool's result (text read from an image, a transcription) goes back to whichever model is running the chat -- with a cloud model, that result leaves the machine even though the tool ran locally.

## Troubleshooting

- **Door unreachable**: the status bar shows `engined unreachable` after 3 failed polls. Start it with `systemctl --user start engined` and watch it come up with `journalctl --user -u engined -f`.
- **Models missing from the picker**: `engined: Refresh Models` forces a poll. A model that never appears may not serve `/openai/v1/chat/completions`, or engined reports it `unavailable` -- check `curl http://127.0.0.1:29200/openai/v1/models`.
- **A tool says no route is installed**: it picks from every answerable row (`ModelPoller.rows`), not just chat models -- confirm the needed route (image/vision/speech/transcription) is actually installed and not `unavailable`.

## Requirements

- No engined-side auth exists; do not point `engined.url` at anything but a loopback address you trust.

## Development

See [HUMANS.md](HUMANS.md) to build and package, and [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.
