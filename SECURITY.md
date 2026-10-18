# Security policy

## Reporting a vulnerability

Do not open a public GitHub issue for undisclosed security bugs. Use [GitHub Security Advisories](https://github.com/Rethunk-Tech/engined-vscode/security/advisories/new) with a description, impact, steps to reproduce, and affected versions or commit SHAs.

This policy covers the extension and its `package.json` dependencies. Report engined itself against [Rethunk-Tech/engined](https://github.com/Rethunk-Tech/engined). VS Code and Marketplace infrastructure are out of scope.

## Supported versions

Only the latest release receives security fixes.

## Risk profile

- **No authentication on the door** — engined's door is loopback-only with no auth. No `engined.doors` entry should point at a non-loopback address unless that connection is separately secured (e.g. SSH via Remote-SSH); this extension authenticates nothing.
- **Filesystem writes from a language model** — `engined_generateImage` and `engined_speak` write at a path the model chooses. Every path crosses `src/pathGuard.ts` and is rejected outside an open workspace folder; there is no other sandbox. Rule: [AGENTS.md](AGENTS.md).
- **Egress from tool confirmations** — the confirmation names the route and states when `egress` is not local (prompt or file content leaves this machine). Review it before approving.
- **No prompt/response logging** — the "engined" output channel never logs request or response content; do not add such logging in a PR.
