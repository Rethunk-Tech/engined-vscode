# Changelog

All notable changes to this project are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Initial release: an `engined` VS Code language model chat provider backed by engined's `/openai/v1/models` and `/openai/v1/chat/completions`, model-list polling, reasoning-effort settings, and four tools (`engined_generateImage`, `engined_readImage`, `engined_transcribe`, `engined_speak`).
- Inline completions (ghost text) via engined's `POST /openai/v1/completions`, debounced and abortable, with `engined.completions.enabled` and `engined.completions.model` settings.
