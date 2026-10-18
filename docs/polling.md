# Model-list polling internals

See [HUMANS.md](../HUMANS.md#usage) for the status bar overview.

`src/polling.ts`'s `ModelPoller` polls `GET /openai/v1/models` on `engined.pollSeconds` (default `30`; `0` disables the timer -- use the `engined: Refresh Models` command instead). It never calls any other route: listing is always safe to poll and never loads a model.

`src/pollDriver.ts` also keeps `GET /engined/v1/engines/events` open per door. While any of those streams is connected, the poll interval is `max(configured, 300)` seconds -- the timer is a fallback, not the primary signal. Each SSE frame (debounced 500 ms) triggers one model re-poll and an Engines-view refresh; a disconnect reconnects with backoff and drops the interval back to the configured value.

Each poll tracks two lists from the same response:

- `models` -- every row that serves `/openai/v1/chat/completions`, is not `unavailable`, and is not a vision-only row (`role: vision`). Reported to VS Code's `LanguageModelChatProvider`, including `tools: false` rows.
- `rows` -- every answerable row (`state !== "unavailable"`), chat or not. A tool, the completions picker, and `engined: Choose Default Models` all pick from this list, since a comfy, TTS, or STT row never serves chat and would never appear in `models`.

VS Code's picker only refreshes when either list actually changed (a stable serialization is diffed against the previous poll), not on every timer tick. A failed poll keeps the last good lists; the 3rd consecutive failure empties both and marks the door unreachable, shown in the status bar with instructions to start it (`systemctl --user start engined`).
