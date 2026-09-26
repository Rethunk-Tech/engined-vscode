# engined

A VS Code language model provider for [engined](https://github.com/Rethunk-Tech/engined), a local inference door. It lists engined's installed chat models in VS Code's model picker, streams chat completions through them, and exposes four tools (`engined_generateImage`, `engined_readImage`, `engined_transcribe`, `engined_speak`) that reach engined's image, vision and audio routes.

## What it does

- Registers an `engined` chat provider (`vendor: "engined"`) backed by engined's `GET /openai/v1/models` and `POST /openai/v1/chat/completions`.
- Polls the model list on a timer and refreshes VS Code's picker only when it actually changes.
- Forwards tool calls and images to models that support them, and snaps a reasoning-effort setting to whatever level each model actually lists.
- Adds four chat tools that generate/edit images, OCR or describe an image, transcribe or translate audio, and synthesize speech — each confirms the route it will use and warns when content will leave the machine.
- A status bar item shows whether the door is reachable and how many models it offers; click it for a quick pick of common actions.

## Requirements

- **engined** running and reachable at `engined.url` — either on the same machine (the default, `http://127.0.0.1:29200`, loopback only, no auth) or reached via VS Code **Remote-SSH** into the machine running engined, since this extension activates as a `workspace`-kind extension and runs on whichever host the workspace is on.
- No engined-side auth exists; do not point `engined.url` at anything but a loopback address you trust.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `engined.url` | `http://127.0.0.1:29200` | Base URL of the engined door. |
| `engined.pollSeconds` | `30` | How often to re-poll the model list. `0` disables polling (use the `engined: Refresh Models` command instead). |
| `engined.reasoningEffort` | `medium` | Default reasoning effort (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`) for models that support it. |
| `engined.reasoningEffortByModel` | `{}` | Per-model override, keyed by model id (e.g. `"@/claude/sonnet-5": "high"`). |

## Tools

| Tool | Route | Notes |
| --- | --- | --- |
| `engined_generateImage` | `/openai/v1/images/generations` or `/openai/v1/images/edits` | Edits when `sourcePath` is given. |
| `engined_readImage` | `/openai/v1/chat/completions` (vision) | `mode: "ocr"` picks a `vision: "read"` route, `"describe"` picks `vision: "describe"`. |
| `engined_transcribe` | `/openai/v1/audio/transcriptions` or `/openai/v1/audio/translations` | `translate: true` requires a route that declares `translate: true`. |
| `engined_speak` | `/openai/v1/audio/speech` | Writes the synthesized audio to a workspace file. |

Every path a tool reads or writes must resolve inside an open workspace folder; a `..` escape or an absolute path outside every folder is refused.

## Privacy

engined logs no request or response content, and this extension follows the same rule: the "engined" output channel records only poll failures, HTTP errors, and state changes — never a prompt, a response, or tool input/output text. A tool's confirmation prompt tells you when its route's `egress` is not local, meaning the content you send it leaves this machine.

## Development

See [HUMANS.md](HUMANS.md) to build and package, and [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.
