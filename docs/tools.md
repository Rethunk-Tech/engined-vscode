# Agent tools reference

Detailed parameters for the four `engined_*` tools. See [HUMANS.md](../HUMANS.md#usage) for the overview.

Every tool works from whatever chat model is currently answering -- engined's own models or any other vendor's (Copilot's included). The tool itself always runs against engined's local door; only the tool's result travels back to whichever model is running the conversation, so with a cloud model that result leaves the machine even though the tool ran locally.

Each tool can be attached to a chat request by typing `#enginedImage`, `#enginedReadImage`, `#enginedTranscribe`, or `#enginedSpeak`.

Every path a tool reads or writes must resolve inside an open workspace folder; a `..` escape or an absolute path outside every folder is refused (`src/pathGuard.ts`).

## `engined_generateImage`

| Input | Type | Notes |
| --- | --- | --- |
| `prompt` | string | required |
| `outputPath` | string | required, workspace-relative |
| `size` | string | `WIDTHxHEIGHT`, e.g. `1024x1024` |
| `sourcePath` | string | when given, edits that image instead of generating fresh |

Route: `/openai/v1/images/generations`, or `/openai/v1/images/edits` when `sourcePath` is given. Route selection: `engined.defaultModels.image`, falling back to the first installed row that serves the needed path.

Returns the written path as text and opens the image beside the chat. The image is not sent back to the model: a tool cannot tell which model called it, and Copilot models fail their next turn fetching an image result.

## `engined_readImage`

| Input | Type | Notes |
| --- | --- | --- |
| `path` | string | required, workspace-relative |
| `mode` | `"ocr" \| "describe"` | required |
| `question` | string | optional, overrides the default prompt for the mode |

Route: `/openai/v1/chat/completions` against a vision row. `mode: "ocr"` needs a row with `vision: "read"`; `"describe"` needs `vision: "describe"`. Route selection: `engined.defaultModels.ocr`/`.vision`.

## `engined_transcribe`

| Input | Type | Notes |
| --- | --- | --- |
| `path` | string | required, workspace-relative |
| `translate` | boolean | render as English rather than the spoken language |

Route: `/openai/v1/audio/transcriptions`, or `/openai/v1/audio/translations` when `translate: true` and the resolved row also serves that path. Route selection: `engined.defaultModels.transcription`.

`translate: true` appends a note to the result: speech translation is measured unreliable on this route (large-v3-turbo-q8_0 has rendered "El gato negro..." as "The black man...", per engined's own `AGENTS.md`) -- prefer transcribing and translating the text with a chat model instead.

## `engined_speak`

| Input | Type | Notes |
| --- | --- | --- |
| `text` | string | required |
| `outputPath` | string | required, workspace-relative |
| `voice` | string | optional |

Route: `/openai/v1/audio/speech`. Route selection: `engined.defaultModels.speech`. Writes the synthesized audio to `outputPath`.
