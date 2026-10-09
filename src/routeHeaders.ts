/** The `x-engined-*` response headers a call's status-bar record is built from. No `vscode` import. */

import { resolveRoute } from './status.ts'

/** `x-engined-cost-usd`, parsed -- absent or unparseable means no cost was reported, not zero. */
export function costUsdHeader(headers: Headers): number | undefined {
  const raw = headers.get('x-engined-cost-usd')
  if (raw === null) {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The route and egress a reply reports, falling back to the requested row's own id and egress. */
export function routeFromHeaders(
  headers: Headers,
  fallback: { id: string; egress: string | undefined },
): { route: string; egress: string | undefined } {
  return resolveRoute(
    {
      route: headers.get('x-engined-route') ?? undefined,
      egress: headers.get('x-engined-egress') ?? undefined,
      chain: headers.get('x-engined-chain') ?? undefined,
    },
    fallback,
  )
}
