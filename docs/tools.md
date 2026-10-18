# Agent tools reference

Detailed parameters for the five `engined_*` tools. See [HUMANS.md](../HUMANS.md#usage) for the overview.

Every tool works from whatever chat model is currently answering -- engined's own models or any other vendor's (Copilot's included). The tool request goes to the door that owns the resolved route (which may be remote-egress); the confirmation names that route and warns when content will leave the machine. The tool's result then travels back to whichever model is running the conversation, so with a cloud chat model that result leaves the machine even when the tool itself stayed local. `engined_search` still refuses a non-local embed/rerank route unless `engined.search.allowRemote` is set.

Each tool can be attached to a chat request by typing `#enginedImage`, `#enginedReadImage`, `#enginedTranscribe`, `#enginedSearch`, or `#enginedSpeak`.

Every path a tool reads or writes must resolve inside an open workspace folder; a `..` escape or an absolute path outside every folder is refused (`src/pathGuard.ts`).

## `engined_generateImage`

| Input | Type | Notes |
| --- | --- | --- |
| `prompt` | string | required |
| `outputPath` | string | required, workspace-relative |
| `size` | string | `WIDTHxHEIGHT`, e.g. `1024x1024` |
| `sourcePath` | string | when given, edits that image instead of generating fresh |

Route: `/openai/v1/images/generations`, or `/openai/v1/images/edits` when `sourcePath` is given. Route selection: `engined.defaultModels.image`, falling back to the first installed row that serves the needed path.

Returns the written path as text and opens the image beside the chat. Progress is reported while the picture renders. An inline preview frame is written to `<outputPath>.preview.jpeg` or `<outputPath>.preview.png`, opened beside the chat, and removed when the final image is written. The image is not sent back to the model: a tool cannot tell which model called it, and Copilot models fail their next turn fetching an image result.

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

Route: `/openai/v1/audio/transcriptions`. Route selection: `engined.defaultModels.transcription`. Speech translation is not offered until a quality probe passes; a `translate` request is refused in the tool result. Transcribe the file and translate the text with a chat model.

## `engined_search`

| Input | Type | Notes |
| --- | --- | --- |
| `query` | string | required |
| `maxResults` | number | maximum snippets returned; defaults to 6 |

Semantic search over the open workspace: file chunks are embedded through `/openai/v1/embeddings` (`engined.defaultModels.embedding`) into an index kept in extension storage, and the nearest chunks are optionally reranked through `/openai/v1/rerank` (`engined.defaultModels.rerank`). Both routes must keep content local unless `engined.search.allowRemote` is set. Returns `path:startLine-endLine` plus the snippet for each hit.

## `engined_speak`

| Input | Type | Notes |
| --- | --- | --- |
| `text` | string | required |
| `outputPath` | string | required, workspace-relative |
| `voice` | string | optional. A workspace-relative path that exists in the workspace is uploaded to `/engined/v1/audio/voices`, and the speech request sends the returned `vc_….wav` handle. A bare voice name or a `vc_` handle is sent unchanged. A path outside the workspace is refused. |

Route: `/openai/v1/audio/speech`. Route selection: `engined.defaultModels.speech`. Writes the synthesized audio to `outputPath`.
