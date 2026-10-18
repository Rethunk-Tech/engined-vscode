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

## Warm Model and Hold Model open an empty picker when nothing is listed

`warmModel` (`src/commands.ts:20`) maps `s.poller.rows` into a quick pick. `holdModel` (`src/commands.ts:47`) maps `qualifiedEngineIds(s.poller.rows, ...)`. When that list is empty — door unreachable, or three failed polls emptied the poller (`src/polling.ts`) — VS Code still opens a picker with no items. The operator gets no sentence saying why, unlike `releaseHold` which already shows `engined: no engines are held` (`src/commands.ts:72`).

Decided shape: if there is nothing to pick, show an information message and return without opening the picker. Warm names models; hold names engines. The wording stays parallel to the release-hold empty path. A non-empty list is unchanged.

Rejected: auto-refreshing then picking. Refresh is a separate command. Rejected: an error message; this is an empty state, not a failed HTTP call.

### Read

1. `src/commands.ts:20` `warmModel` — the pick at `:22`. Empty `s.poller.rows` is the gap.
2. `src/commands.ts:47` `holdModel` — `qualifiedEngineIds` at `:48`. Empty engines is the gap.
3. `src/commands.ts:72` — the existing empty-state message to copy the `engined: …` prefix from.
4. `src/polling.ts` — consecutive poll failures empty the list; that is a normal way to arrive here.

### Traps

- **Do not treat a cancelled pick as empty.** `showQuickPick` returning `undefined` is the user backing out of a non-empty list. The new message fires only when the list was empty before the pick.
- **Warm lists model rows, hold lists engines.** A poller with rows but no `engine` id on those rows can still make hold empty. Guard each command on its own list, not on `poller.rows.length` for both.

### Acceptance

- With `s.poller.rows` empty, Warm Model shows an information message and does not open a quick pick.
- With `qualifiedEngineIds` empty, Hold Model shows an information message and does not open a quick pick.
- With at least one item, each command still opens the same picker it opens today.
- Cancelling a non-empty pick still returns without a message.
- `bun test` and `bun run ci` stay clean.

## Copy Fix with no `fix` string writes an empty clipboard

`copyFixCommand` (`src/engineExplorer.ts:235`) does `vscode.env.clipboard.writeText(fix ?? '')`. There is no toast when `fix` is undefined or empty. The command is offered on `engine-unavailable` and `engine-has-fix`. A race where the next poll dropped `fix` still copies nothing and looks like success.

Decided shape: when `fix` is undefined or empty, show an error message and do not write the clipboard. When it is non-empty, write it exactly as today. Extract the empty-vs-text decision to a vscode-free function so `bun test` covers it.

Rejected: copying `last_error` as a fallback. Copy Fix is the door's `fix` command string (`HUMANS.md:58`).

### Read

1. `src/engineExplorer.ts:235` `copyFixCommand` — the `?? ''` write.
2. `src/commands.ts:284` — the tree-item wrapper that passes `item.node.fix`.
3. `src/engineTree.ts:201` — `EngineNode.fix`.
4. `src/engineTree.test.ts:38` — unavailable rows that carry `fix`.

### Traps

- **Do not write an empty string on the failure path.** A previous successful copy would stay in the clipboard, which is better than replacing it with nothing.
- **The tree-item command still no-ops when `item.kind !== 'engine'`.** That guard stays in `commands.ts`; the empty-fix check is only for a real engine row.

### Acceptance

- A call with `fix` undefined or `''` does not write the clipboard and surfaces an error message.
- A call with a non-empty `fix` writes that string and does not show the error.
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
