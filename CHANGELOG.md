# Changelog

All notable changes to this project are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- `engined: Use engined for All Chat Features` routes VS Code chat defaults (default, utility, plan and explore models) to an engined model and turns off Copilot inline suggestions, after listing every setting; `engined: Restore Previous Chat Settings` puts the saved values back.
- Initial release: an `engined` VS Code language model chat provider backed by engined's `/openai/v1/models` and `/openai/v1/chat/completions`, model-list polling, reasoning-effort settings, and four tools (`engined_generateImage`, `engined_readImage`, `engined_transcribe`, `engined_speak`).
- Inline completions (ghost text) via engined's `POST /openai/v1/completions`, debounced and abortable, with an `engined.completions.enabled` setting.
- Per-role default-model settings (`engined.defaultModels.{image,ocr,vision,completion,speech,transcription}`), an `engined: Choose Default Models` command, and a shared selection rule (configured id if it still qualifies, else the automatic pick, logging once when it falls through).
- Status bar shows the last chat call's answering route, egress, prompt/completion tokens and wall time, plus a loading state while a request is in flight or its row is warming up.
- Inline completions send neighbouring-file context (`extra`) from other open/recently active editors to a local completions route, gated by `engined.completions.neighbourContext`.
- `engined_generateImage` opens the generated image beside the chat; the model gets only the written path.
- `engined_search`: semantic workspace search over a chunked, embedded index kept in workspace storage, incrementally updated on save/create/delete and reranked when an installed route serves `/openai/v1/rerank`. New settings `engined.defaultModels.embedding`, `engined.search.allowRemote`, `engined.search.maxChunks`.
- `engined: Warm Model`, `engined: Hold Model` and `engined: Release Hold` commands, and a live subscription to `GET /engined/v1/engines/events` that debounces a model re-poll on every frame and reconnects with backoff on disconnect.
- An Engines view (its own activity-bar container) listing every engine with state, resource usage on expand, and per-item warm/hold/release/stop/logs/copy-fix actions.

- Token counts (`provideTokenCount` and the status bar's "processing ~Nk-token prompt" label) call engined's `POST /engined/v1/tokenize` for a route that advertises it, cached by (model, content), falling back to the chars/3 estimate when the route doesn't serve it or the call fails.

### Fixed

- `engined_generateImage`, `engined_readImage`, `engined_transcribe`, `engined_speak`, and the inline-completions model picker now choose a route from every answerable row engined reports, not only the chat-completions subset -- a comfy, TTS or STT row never serves chat and was previously invisible to every tool.
- Inline completions now register for `file`, `untitled` and `vscode-notebook-cell` documents explicitly -- a `pattern`-only selector with no `scheme` is not guaranteed to score a notebook cell document, which never carries a `file` URI.
- Status popup's "Last chat" now shows the last request that actually carried tools, not Copilot's own tool-less title/summary requests, which now show separately as "Last background".
- Status popup's Defaults section now shows the resolved model name for every role (previously showed "automatic" whenever the row had no `display_name`), and marks whether it's the configured id, the automatic pick, or a configured id that fell through to automatic. It also updates immediately after `engined.defaultModels.*` changes.

### Changed

- README restructured: a short pitch/quick-start at the top, logical sections with short intros, and detailed reference material (tool parameters, reasoning-effort mapping, polling internals) moved to `docs/*.md`.
