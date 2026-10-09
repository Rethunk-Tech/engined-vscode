# Contributing

## Setup

```bash
bun install
bun run setup-hooks   # lefthook install
```

## Workflow

1. Make a change under `src/`.
2. `bun run ci` locally before opening a PR (lint, typecheck, test, build).
3. Conventional Commits (`feat:`, `fix:`, `chore:`, ...).
4. Open a PR against `main` using the PR template.

## Source layout

See [AGENTS.md](AGENTS.md) for the file-by-file map and invariants.

## Testing

`bun test` runs every `src/**/*.test.ts` with no VS Code host and no mocks — the pure modules (`door.ts`, `chatStream.ts`, `requestBuilder.ts`, `pathGuard.ts`, `polling.ts`, `toolRequests.ts`) are exercised directly against fixtures recorded from a real engined door in `src/fixtures/`. Do not hand-edit those fixtures; re-record them from a real door instead. The modules that import `vscode` (`extension.ts`, `config.ts`, `searchIndex.ts`, `engineExplorer.ts`) are thin adapters with no unit test — the decisions they make live in the pure modules they wire together.

## Documentation tiers

- [README.md](README.md) — what the extension does; doubles as the Marketplace listing.
- [HUMANS.md](HUMANS.md) — build/package/run runbook.
- [AGENTS.md](AGENTS.md) — contributor map and invariants for AI and human contributors alike.
- [CHANGELOG.md](CHANGELOG.md) — notable changes, Keep a Changelog format.

Don't duplicate one tier's content into another; link instead.
