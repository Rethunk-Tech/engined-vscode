/**
 * Pure formatting/aggregation for the status bar: the last chat call, the
 * last completion, the loading state, and the header-vs-fallback route
 * resolution. No `vscode` import, so `bun test` exercises it with no
 * extension host; `extension.ts` supplies timestamps and header values.
 */

/** engined's own egress values (engined src/types.ts `Egress`); "none" is fully local. */
export function isLocalEgress(egress: string | undefined): boolean {
  return egress === 'none'
}

/** The last path segment of a model id, e.g. `sonnet-5` from `@/claude/sonnet-5`. */
export function shortModelName(id: string): string {
  const parts = id.split('/')
  return parts[parts.length - 1] || id
}

/** `29123` -> `29.1k`; under 1000 stays a plain integer. */
export function abbreviateTokenCount(n: number): string {
  if (n < 1000) {
    return String(Math.round(n))
  }
  return `${(n / 1000).toFixed(1)}k`
}

/** `2300` -> `2.3s`; ten seconds and over drops the decimal. */
export function formatSeconds(ms: number): string {
  const seconds = ms / 1000
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`
}

export interface RouteHeaders {
  route?: string
  egress?: string
  chain?: string
}

export interface RouteFallback {
  id: string
  egress?: string
}

/**
 * `x-engined-route`/`x-engined-egress` when engined sent them, else the
 * requested row's own id/egress -- the header is a parallel engined change
 * that may not have landed yet.
 */
export function resolveRoute(
  headers: RouteHeaders,
  fallback: RouteFallback,
): { route: string; egress: string | undefined } {
  return {
    route: headers.route ?? fallback.id,
    egress: headers.egress ?? fallback.egress,
  }
}

export interface CallRecord {
  route: string
  egress: string | undefined
  promptTokens?: number
  completionTokens?: number
  wallMs: number
}

/** `$(server) sonnet-5 · local · 1.2k→340 · 2.3s`; `$(cloud)` when egress is not local. */
export function formatCallLine(call: CallRecord): string {
  const local = isLocalEgress(call.egress)
  const glyph = local ? '$(server)' : '$(cloud)'
  const inTokens = call.promptTokens === undefined ? '?' : abbreviateTokenCount(call.promptTokens)
  const outTokens =
    call.completionTokens === undefined ? '?' : abbreviateTokenCount(call.completionTokens)
  return `${glyph} ${shortModelName(call.route)} · ${local ? 'local' : 'remote'} · ${inTokens}→${outTokens} · ${formatSeconds(call.wallMs)}`
}

export function formatLoadingText(modelId: string): string {
  return `$(loading~spin) loading ${shortModelName(modelId)}…`
}

/** The 1.5s "no first token yet" rule, as a pure function of two timestamps. */
export function hasExceededLoadingThreshold(
  startedAtMs: number,
  nowMs: number,
  thresholdMs = 1500,
): boolean {
  return nowMs - startedAtMs >= thresholdMs
}

export interface TooltipInput {
  lastChat?: CallRecord
  lastCompletion?: CallRecord
  doorUrl: string
  modelCount: number
}

export function buildTooltip(input: TooltipInput): string {
  const lines: string[] = []
  if (input.lastChat !== undefined) {
    lines.push(`Last chat: ${formatCallLine(input.lastChat)}`)
  }
  if (input.lastCompletion !== undefined) {
    lines.push(`Last completion: ${formatCallLine(input.lastCompletion)}`)
  }
  lines.push(`Door: ${input.doorUrl}`)
  lines.push(`${input.modelCount} model(s) available`)
  return lines.join('\n')
}

export function unreachableTooltip(doorUrl: string): string {
  return `Could not reach engined at ${doorUrl}\nStart it with: systemctl --user start engined`
}
