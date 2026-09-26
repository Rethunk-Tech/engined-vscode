# HUMANS.md — Operator Guide

Build, package, and run this extension from source. Contributors: [CONTRIBUTING.md](CONTRIBUTING.md). What it does and its settings: [README.md](README.md).

## Prerequisites

- [Bun](https://bun.sh) 1.4.x
- VS Code ≥ 1.106.0 (see `engines.vscode` in `package.json`)
- engined running locally, or reachable via Remote-SSH

## Build

```bash
bun install
bun run build   # dist/extension.cjs
```

## Test

```bash
bun run test       # bun test, no VS Code host required
bun run typecheck
bun run lint
bun run ci          # lint -> typecheck -> test -> build
```

## Run inside VS Code

Open this folder in VS Code and press F5 (Run Extension) to launch an Extension Development Host with this extension loaded. Open a workspace folder in that window, open the chat view, and pick a model under the "engined" provider.

## Package

```bash
bun run build
bun run package   # bunx @vscode/vsce package --no-dependencies -> engined-vscode-<version>.vsix
```

The `.vsix` is not committed (`*.vsix` is gitignored); build it locally to verify or to install manually via "Extensions: Install from VSIX...".
