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
  /** Only an agentic-CLI hop reports one (engined `x-engined-cost-usd`/streamed `engined.cost_usd`); absent for every other engine. */
  costUsd?: number
}

/** `$0.0123`, four decimal places -- these are per-call agentic-CLI costs, always sub-dollar. */
function formatCostUsd(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`
}

/** `$(server) sonnet-5 · local · 1.2k→340 · 2.3s`; `$(cloud)` when egress is not local; cost appended only when the hop reported one. */
export function formatCallLine(call: CallRecord): string {
  const local = isLocalEgress(call.egress)
  const glyph = local ? '$(server)' : '$(cloud)'
  const inTokens = call.promptTokens === undefined ? '?' : abbreviateTokenCount(call.promptTokens)
  const outTokens =
    call.completionTokens === undefined ? '?' : abbreviateTokenCount(call.completionTokens)
  const cost = call.costUsd === undefined ? '' : ` · ${formatCostUsd(call.costUsd)}`
  return `${glyph} ${shortModelName(call.route)} · ${local ? 'local' : 'remote'} · ${inTokens}→${outTokens} · ${formatSeconds(call.wallMs)}${cost}`
}

export function formatLoadingText(modelId: string): string {
  return `$(loading~spin) loading ${shortModelName(modelId)}…`
}

/** `~31k-token prompt` -- the estimate is already a deliberate over-count (`requestBuilder.ts`), so a finer unit would be false precision. */
export function formatProcessingText(promptTokenEstimate: number): string {
  return `$(loading~spin) processing ~${Math.round(promptTokenEstimate / 1000)}k-token prompt…`
}

/**
 * A row already `warming` (or not resolved to a row at all, e.g. still
 * starting) is honestly "loading"; a `running` row that just hasn't answered
 * yet is processing the prompt it was given, not loading the model.
 */
export function formatWaitingText(
  rowState: string | undefined,
  modelId: string,
  promptTokenEstimate: number,
): string {
  if (rowState === undefined || rowState === 'warming') {
    return formatLoadingText(modelId)
  }
  return formatProcessingText(promptTokenEstimate)
}

/** The 1.5s "no first token yet" rule, as a pure function of two timestamps. */
export function hasExceededLoadingThreshold(
  startedAtMs: number,
  nowMs: number,
  thresholdMs = 1500,
): boolean {
  return nowMs - startedAtMs >= thresholdMs
}

export interface DefaultModelLine {
  /** e.g. "Image" */
  label: string
  /** `undefined` when nothing installed qualifies for the role. */
  modelName: string | undefined
}

export interface TooltipInput {
  doorReachable: boolean
  doorUrl: string
  modelCount: number
  lastChat?: CallRecord
  lastCompletion?: CallRecord
  defaults: readonly DefaultModelLine[]
  /** Engines this session has itself put on hold -- see `AGENTS.md`'s Engines-view invariant for why nothing else can be known here. */
  heldEngines?: readonly string[]
  /** `engined.useForAllChatFeatures` is in effect and `engined.restoreChatSettings` can undo it. */
  chatSettingsRouted?: boolean
}

/** Every command id `buildTooltip`'s links use -- what an `isTrusted.enabledCommands` allowlist must carry. */
export const TOOLTIP_COMMANDS = {
  refresh: 'engined.refreshModels',
  defaultModels: 'engined.chooseDefaultModels',
  warm: 'engined.warmModel',
  engines: 'engined.engines.focus',
  useForAll: 'engined.useForAllChatFeatures',
  restore: 'engined.restoreChatSettings',
  log: 'engined.showLog',
} as const

function commandLink(label: string, command: string): string {
  return `[${label}](command:${command})`
}

/**
 * The rich status popup, as Markdown -- codicons and command links only
 * work once `extension.ts` wraps this in a `MarkdownString` with
 * `supportThemeIcons: true` and `isTrusted.enabledCommands` set to
 * `Object.values(TOOLTIP_COMMANDS)`.
 */
export function buildTooltip(input: TooltipInput): string {
  const header = [
    '**engined**',
    input.doorReachable
      ? '$(pass-filled) reachable'
      : '$(error) unreachable -- start it with `systemctl --user start engined`',
    `${input.modelCount} model(s)`,
  ]
  if (input.heldEngines !== undefined && input.heldEngines.length > 0) {
    header.push(`held: ${input.heldEngines.join(', ')}`)
  }
  if (input.chatSettingsRouted === true) {
    header.push('Chat features routed to engined')
  }

  const sections = [header.join(' · ')]
  if (input.lastChat !== undefined) {
    sections.push(`**Last chat**\n\n${formatCallLine(input.lastChat)}`)
  }
  if (input.lastCompletion !== undefined) {
    sections.push(`**Last completion**\n\n${formatCallLine(input.lastCompletion)}`)
  }
  if (input.defaults.length > 0) {
    const lines = input.defaults.map((d) => `${d.label}: ${d.modelName ?? 'automatic'}`)
    sections.push(`**Defaults**\n\n${lines.join('  \n')}`)
  }

  const actions = [
    commandLink('Refresh', TOOLTIP_COMMANDS.refresh),
    commandLink('Default models', TOOLTIP_COMMANDS.defaultModels),
    commandLink('Warm up', TOOLTIP_COMMANDS.warm),
    commandLink('Engines', TOOLTIP_COMMANDS.engines),
    input.chatSettingsRouted === true
      ? commandLink('Restore', TOOLTIP_COMMANDS.restore)
      : commandLink('Use engined everywhere', TOOLTIP_COMMANDS.useForAll),
    commandLink('Log', TOOLTIP_COMMANDS.log),
  ]
  sections.push(actions.join(' · '))

  return sections.join('\n\n---\n\n')
}
