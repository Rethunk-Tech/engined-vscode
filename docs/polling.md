# Model-list polling internals

See the [README](../README.md#status-bar) for the status bar overview.

`src/polling.ts`'s `ModelPoller` polls `GET /openai/v1/models` on `engined.pollSeconds` (default `30`; `0` disables the timer -- use the `engined: Refresh Models` command instead). It never calls any other route: listing is always safe to poll and never loads a model.

Each poll tracks two lists from the same response:

- `models` -- the chat-answerable subset, reported to VS Code's `LanguageModelChatProvider`.
- `rows` -- every answerable row (`state !== "unavailable"`), chat or not. A tool, the completions picker, and `engined: Choose Default Models` all pick from this list, since a comfy, TTS, or STT row never serves chat and would never appear in `models`.

VS Code's picker only refreshes when either list actually changed (a stable serialization is diffed against the previous poll), not on every timer tick. A failed poll keeps the last good lists; the 3rd consecutive failure empties both and marks the door unreachable, shown in the status bar with instructions to start it (`systemctl --user start engined`).
