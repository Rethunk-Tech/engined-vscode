# TODO

Work that is decided but not built. `AGENTS.md` and `HUMANS.md` describe what exists.

## A failing translation or rerank probe is absent from the Engines row

engined `src/probe.ts` scores translation (`:192`, via `probeTranslations`) and rerank (`probeRerank` at `:289`). The Engines view appends `last_error` for an engine whose state is `failed` or `unavailable` (`AGENTS.md:59`, `src/engineTree.ts:209`). A probe failure has nowhere to appear on that row.

Decided shape: a failing translation or rerank probe shows on the engine row beside `last_error`. That needs one field on the engines list from engined, plus the row text and tooltip in this repo. A row with no probe failure stays as `toEngineNodes` renders it today. Idle-until, hold, config-stale, capabilities, discovery, and role-model text stay as they are.

### Read

- `src/engineTree.ts:55` — `EngineRow.last_error`. `EnginesListResponse` at `:82` has `engines`, `config_error`, and `discovery`. It has no probe field.
- `src/engineTree.ts:209` — `lastErrorLabel` appends `last_error` only when `state` is `failed` or `unavailable`. `:437` places that label on the description. `engineTooltip` at `:359` builds the tooltip.
- `src/engineTree.test.ts:291` — the `last_error` cases a probe line must leave intact.
- `AGENTS.md:59` — the `last_error` invariant the new line sits beside.
- The engines JSON has no probe field today. `EngineStatus` in engined `src/responses.ts:37` carries `last_error` at `:87` and nothing for a translation or rerank probe line. `handleEngines` in engined `src/control.ts:71` attaches `config_error` and `discovery` and returns that JSON. engined `src/responses.ts` is the file that has to grow the field. Probe scores are computed in engined `src/probe.ts:189` and are not written onto the list.

### Traps

- **`last_error` is state-gated.** A running engine can fail a translation or rerank probe. Writing the failure into `last_error` hides it, because `lastErrorLabel` returns nothing unless `state` is `failed` or `unavailable`. The probe line is its own field and shows beside `last_error` when both are present.
- **Container readiness is a different probe.** `EngineRegistry.statusFor` calls `lifecycle.probe` (engined `src/engines.ts:251`). That is image readiness, separate from `src/probe.ts`.
- **`discovery.last_error` is the agentic-cli refresh.** `discoveryLines` (`src/engineTree.ts:337`) already appends that string on agentic-cli tooltips. A translation or rerank failure stays out of `discovery`.
- **An absent field adds nothing.** Missing or empty probe data leaves the description and tooltip as they are, the same rule as `last_error` and `discovery`.

### Acceptance

- A row whose probe field reports a failing translation or rerank probe shows that failure on the description beside `last_error` and in the tooltip.
- A row with no probe field, and a row whose probe passed, keeps the description and tooltip `toEngineNodes` already produces, including the cases in `src/engineTree.test.ts:291`.
- `bun test` and `bun run ci` stay clean.

## Transcribe never passes a quality probe into `refuseTranslate`

`refuseTranslate` (`src/toolRequests.ts`) takes an optional `probe` and allows `translate: true` only when `probe.quality === true`. `transcribeTool.invoke` (`src/workspaceTools.ts`) calls it with the input flag alone, so every translate request is refused. `RawModelRow.translate` (`src/door.ts`) is whether the row serves `/openai/v1/audio/translations`, not a quality pass — treating that boolean as `probe.quality` would re-offer the route the refusal exists to block.

Decided shape: pass the door's quality-probe result into `refuseTranslate` once that field exists on the models list (the same engined listing field the Engines-row probe TODO needs). Until then the no-probe refusal stays. A row with no probe field keeps refusing `translate: true`.

Rejected: reading `row.translate` as the probe. That flag means the translations path exists.

### Read

- `src/toolRequests.ts` — `refuseTranslate(translate, probe?)`.
- `src/workspaceTools.ts` — `refuseTranslate(options.input.translate)` with no probe.
- `src/door.ts` — `RawModelRow.translate`.
- The models JSON has no quality-probe field today.

### Traps

- **`row.translate` is not quality.** Wiring it as `probe.quality` undoes the refusal.
- **The Engines-row probe TODO is display.** This one is the transcribe tool's request path. They share the missing engined field, not the UI work.

### Acceptance

- `refuseTranslate(true, { quality: true })` still allows the translations path.
- `refuseTranslate(true)` with no probe, and `refuseTranslate(true, { quality: false })`, still return `TRANSLATE_UNAVAILABLE`.
- `bun test` and `bun run ci` stay clean.

<!--
## A sentence naming the problem, not the solution

What is wrong today, and what it costs — measured where a measurement exists,
because a number is what tells the reader whether to care. Say what is already
true before saying what should change.

Then the decided shape: what will be built, which library or mechanism, and
what was rejected. A section that leaves the design open gets re-litigated
when it is picked up, which is most of the cost of picking it up.

If the change reverses a stated design, say so here and name the file that
states it — a reversal arriving quietly is worse than the reversal.

```
An example of the thing, if it has a syntax or an output worth showing.
```

### Read

Where to start, in the order a reader should open things, with `file:line`
anchors for every function the change touches and one clause on why each
matters. This is what lets the work be picked up cold: without anchors the
first hour is spent rediscovering the problem.

Name the files that record a decision the change invalidates — a comment
claiming something that stops being true is a defect the moment it lands.

### Traps

- **The thing that breaks silently.** Why it breaks, and what it looks like
  when it does. Prefer traps that have actually bitten: the ones written from
  experience are the ones that fire.
- **The invariant that must survive.** Not "be careful" — the specific
  property, and what would quietly violate it.
- **The measurement that constrains the design.** A number that rules an
  approach out is worth more than a preference that argues against it.

### Acceptance

- One line per observable behaviour, written so it can be checked rather than
  believed — a command and its outcome, not "works correctly".
- Include the negative cases: what must NOT happen, what must stay unchanged,
  and what must still be refused.
- Finish with the gates: `make test`, `make lint` and `doc-audit` stay clean,
  and any claim this change makes false is corrected in the same commit.
-->
