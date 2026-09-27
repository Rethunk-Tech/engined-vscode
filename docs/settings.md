# Settings reference

Every `engined.*` setting. Configure through VS Code's Settings UI (search "engined") or `settings.json`. `src/settings.test.ts` fails if this table's keys or defaults drift from `package.json`'s `contributes.configuration`.

| Setting | Default | Description |
| --- | --- | --- |
| `engined.doors` | `[{ "name": "local", "url": "http://127.0.0.1:29200" }]` | Every engined door to poll and route to. With one door, model/engine ids stay plain; with more than one, an id becomes `<door name>/<id>` and every request routes to the door that owns it. |
| `engined.pollSeconds` | `30` | How often to re-poll the model list. `0` disables polling (use `engined: Refresh Models` instead). |
| `engined.reasoningEffort` | `medium` | Default reasoning effort for models that support it. Mapping details: [reasoning-effort.md](reasoning-effort.md). |
| `engined.reasoningEffortByModel` | `{}` | Per-model override, keyed by model id. |
| `engined.chat.splitChunkChars` | `2000` | Split long user messages into turns of about this many characters, at blank lines, closing tags or line ends, never inside a code fence or JSON value. A hybrid model like Ornith reuses a cached prompt only up to a message boundary, so this makes new chats faster. `0` disables. |
| `engined.chat.splitAboveChars` | `8000` | Only messages longer than this are split. `0` disables. |
| `engined.completions.enabled` | `true` | Offer inline completions (ghost text). |
| `engined.completions.neighbourContext` | `true` | Send snippets from other open/recent editors as completions context. Only sent to a local (`egress: none`) completions route. |
| `engined.defaultModels.image` | `""` | Model id for `engined_generateImage`. Empty is automatic. |
| `engined.defaultModels.ocr` | `""` | Model id for `engined_readImage` OCR mode. Empty is automatic. |
| `engined.defaultModels.vision` | `""` | Model id for `engined_readImage` describe mode. Empty is automatic. |
| `engined.defaultModels.completion` | `""` | Model id for inline completions. Empty is automatic. |
| `engined.defaultModels.speech` | `""` | Model id for `engined_speak`. Empty is automatic. |
| `engined.defaultModels.transcription` | `""` | Model id for `engined_transcribe`. Empty is automatic. |
| `engined.defaultModels.embedding` | `""` | Model id for `engined_search`. Empty is automatic. |
| `engined.search.allowRemote` | `false` | Allow `engined_search` to embed/rerank through a non-local route. |
| `engined.search.maxChunks` | `20000` | Cap on the search index's chunk count. |

Run **engined: Choose Default Models** (also in the status bar's quick pick) to set any of the `defaultModels.*` settings from a list of the rows that currently qualify. A configured id that stops qualifying falls back to automatic and logs one line to the "engined" output channel.
