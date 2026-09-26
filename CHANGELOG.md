# Changelog

All notable changes to this project are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Initial release: an `engined` VS Code language model chat provider backed by engined's `/openai/v1/models` and `/openai/v1/chat/completions`, model-list polling, reasoning-effort settings, and four tools (`engined_generateImage`, `engined_readImage`, `engined_transcribe`, `engined_speak`).
- Inline completions (ghost text) via engined's `POST /openai/v1/completions`, debounced and abortable, with an `engined.completions.enabled` setting.
- Per-role default-model settings (`engined.defaultModels.{image,ocr,vision,completion,speech,transcription}`), an `engined: Choose Default Models` command, and a shared selection rule (configured id if it still qualifies, else the automatic pick, logging once when it falls through).
- Status bar shows the last chat call's answering route, egress, prompt/completion tokens and wall time, plus a loading state while a request is in flight or its row is warming up.
- Inline completions send neighbouring-file context (`extra`) from other open/recently active editors to a local completions route, gated by `engined.completions.neighbourContext`.
- `engined_generateImage` returns the generated image itself alongside the written-file path.

### Fixed

- `engined_generateImage`, `engined_readImage`, `engined_transcribe`, `engined_speak`, and the inline-completions model picker now choose a route from every answerable row engined reports, not only the chat-completions subset -- a comfy, TTS or STT row never serves chat and was previously invisible to every tool.

### Changed

- README restructured: a short pitch/quick-start at the top, logical sections with short intros, and detailed reference material (tool parameters, reasoning-effort mapping, polling internals) moved to `docs/*.md`.
