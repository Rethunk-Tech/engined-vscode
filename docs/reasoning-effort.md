# Reasoning effort mapping

See the [README](../README.md#settings) for the settings table.

`engined.reasoningEffort` and its per-model override `engined.reasoningEffortByModel` name a level from `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`. Not every model declares every level (`capabilities.reasoning` on its `/openai/v1/models` row); this extension snaps a requested level to the nearest one the model actually lists (`src/door.ts` `snapReasoningEffort`), walking outward on the shared ordering above. A model that declares no reasoning levels at all never gets a `reasoning_effort` field.

`reasoning_effort` is sent only when the row's `capabilities.reasoning` is non-empty -- never guessed for a model that never advertised it.
