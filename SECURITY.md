# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x (current) | Yes |

Only the latest release receives security fixes.

## Scope

This policy covers the `engined-vscode` extension and its direct dependencies as declared in `package.json`. It does not cover:

- engined itself (report against [Rethunk-Tech/engined](https://github.com/Rethunk-Tech/engined))
- VS Code or its Marketplace infrastructure

## Reporting a vulnerability

**Do not open a public GitHub issue for undisclosed security bugs.**

Report privately via **GitHub Security Advisories** (preferred):

[https://github.com/Rethunk-Tech/engined-vscode/security/advisories/new](https://github.com/Rethunk-Tech/engined-vscode/security/advisories/new)

### What to include

- A clear description of the vulnerability and its potential impact
- Steps to reproduce, including a proof-of-concept if possible
- Affected versions or commit SHAs if known

We will acknowledge receipt promptly and work with you to understand and address the report before any public disclosure.

## Risk profile

- **No authentication on the door** — engined's own door is loopback-only with no auth by design. `engined.url` should never be pointed at a non-loopback address unless you have separately secured that connection (e.g. an SSH tunnel via Remote-SSH), because this extension performs no authentication of its own.
- **Filesystem writes from a language model** — the four `engined_*` tools write files (images, audio) at a path the model chooses. Every path is resolved through `src/pathGuard.ts` and rejected if it would land outside an open workspace folder; there is no other sandboxing.
- **Egress from tool confirmations** — a tool's confirmation prompt names the route it will use and states when that route's `egress` is not local, meaning the prompt or file content leaves this machine. Review that prompt before approving.
- **No prompt/response logging** — the "engined" output channel and this extension's own code never log request or response content, by design; do not add such logging in a PR.
