# Contributing

## Setup

```bash
bun install
bun run setup-hooks   # lefthook install
```

## Workflow

1. Make a change under `src/`.
2. `bun run ci` locally before opening a PR (lint, typecheck, test, build, `vsce ls`).
3. Conventional Commits (`feat:`, `fix:`, `chore:`, ...).
4. Open a PR against `main` using the PR template.

## Source layout

See [AGENTS.md](AGENTS.md) for the file-by-file map and invariants.

## Testing

`bun test` runs every `src/**/*.test.ts` without a VS Code host. Pure modules (`door.ts`, `chatStream.ts`, `requestBuilder.ts`, `pathGuard.ts`, `polling.ts`, `toolRequests.ts`, …) are exercised against fixtures recorded from a real engined door in `src/fixtures/`. Do not hand-edit those fixtures; re-record them from a real door instead. `doorClient.test.ts` talks to an in-process `Bun.serve`. `searchIndex.test.ts` drives `SearchIndex` through an in-memory `SearchHost`. Modules that import `vscode` (`extension.ts`, `config.ts`, `engineExplorer.ts`, `searchHost.ts`) stay thin adapters — the decisions they make live in the pure modules they wire together.

## Documentation tiers

- [README.md](README.md) — what the extension does; doubles as the Marketplace listing.
- [HUMANS.md](HUMANS.md) — build/package/run runbook.
- [AGENTS.md](AGENTS.md) — contributor map and invariants for AI and human contributors alike.
- [CHANGELOG.md](CHANGELOG.md) — notable changes, Keep a Changelog format.

Don't duplicate one tier's content into another; link instead.
