/**
 * Pure formatting/aggregation for the status bar: the last chat call, the
 * last completion, the loading state, and the rich HTML tooltip. No
 * `vscode` import, so `bun test` exercises it with no extension host;
 * `extension.ts` supplies timestamps, theme kind, and header values.
 *
 * The tooltip is built as HTML (`MarkdownString.supportHtml = true`), not
 * stacked markdown text, because VS Code's hover sanitizer
 * (microsoft/vscode `domSanitize.ts`/`markdownRenderer.ts`) allows table
 * markup and a narrow `style` allowlist on `<span>` -- see the exact regex
 * quoted next to `SPAN_STYLE_RE` below. Every `style=` this file emits must
 * match that regex or the hover strips it silently.
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
  /** The requested model's own `maxInputTokens` (`door.ts`) -- the context meter's denominator. Absent means no meter, not a zero-width one. */
  promptTokenMax?: number
}

/** `$0.0123`, four decimal places -- these are per-call agentic-CLI costs, always sub-dollar. */
function formatCostUsd(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`
}

/** `$(server) sonnet-5 · local · 1.2k→340 · 2.3s`; `$(cloud)` when egress is not local; cost appended only when the hop reported one. Kept as the plain status-bar text and the unreachable-door fallback tooltip; the popup tooltip uses `callTable` instead. */
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
  /** The resolved row's `display_name ?? id`; `undefined` when nothing installed qualifies for the role. */
  resolvedName: string | undefined
  /** Whether `engined.defaultModels.<role>` is non-empty. */
  configured: boolean
  /** The configured id/name, set only when it fell through to automatic because it is no longer usable. */
  unusableConfigured?: string
}

export interface DoorLine {
  name: string
  url: string
  reachable: boolean
}

/** `/engined/v1/usage?days=1` folded to what the popup shows -- `extension.ts` caches/refreshes this, never blocking a render. */
export interface TodayUsage {
  requests: number
  promptTokens?: number
  completionTokens?: number
}

/** `vscode.ColorThemeKind`, collapsed to the two palettes a static SVG meter needs (a high-contrast theme reads fine off the dark palette). */
export type ThemeKind = 'light' | 'dark'

export interface TooltipInput {
  /** One entry per configured `engined.doors` door. */
  doors: readonly DoorLine[]
  modelCount: number
  lastChat?: CallRecord
  /** The last tool-less chat request (e.g. Copilot's own title/summary calls) -- never the source of the status-bar text. */
  lastBackground?: CallRecord
  lastCompletion?: CallRecord
  defaults: readonly DefaultModelLine[]
  /** Engines this session has itself put on hold -- see `AGENTS.md`'s Engines-view invariant for why nothing else can be known here. */
  heldEngines?: readonly string[]
  /** `engined.useForAllChatFeatures` is in effect and `engined.restoreChatSettings` can undo it. */
  chatSettingsRouted?: boolean
  /** Active editor theme, for the SVG meters. Defaults to `'dark'` (VS Code's own default theme family). */
  themeKind?: ThemeKind
  todayUsage?: TodayUsage
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
  usage: 'engined.showUsageReport',
} as const

// --- theme-aware colors ------------------------------------------------

const COLOR_OK = 'var(--vscode-testing-iconPassed)'
const COLOR_ERROR = 'var(--vscode-errorForeground)'
const COLOR_WARN = 'var(--vscode-editorWarning-foreground)'
const COLOR_MUTED = 'var(--vscode-descriptionForeground)'
const COLOR_ROUTED = 'var(--vscode-textLink-foreground)'

/**
 * VS Code's sanitizer keeps `style=` on a `<span>` only when it matches
 * this exact sequence (microsoft/vscode `src/vs/base/browser/markdownRenderer.ts`,
 * the `attributeName: 'style'` `shouldKeep`, read at HEAD 2026-09).
 * `chip` below only ever emits `color:<value>;`, the first alternative.
 */
const SPAN_STYLE_RE =
  /^(color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(display:inline-block;)?(border-radius:[0-9]+px;)?$/

function chip(text: string, color: string): string {
  const style = `color:${color};`
  if (!SPAN_STYLE_RE.test(style)) {
    // Unreachable with the fixed COLOR_* constants above; guards against a future one breaking the sanitizer contract silently.
    throw new Error(`chip style would be stripped by the hover sanitizer: ${style}`)
  }
  return `<span style="${style}">${text}</span>`
}

function muted(text: string): string {
  return chip(text, COLOR_MUTED)
}

// --- SVG meters ---------------------------------------------------------

const METER_WIDTH = 120
const METER_HEIGHT = 8

/** A static `data:` image can't read `var(--vscode-...)`, so light/dark get their own fixed, readable-on-both palette. */
function meterColors(theme: ThemeKind): { track: string; fill: string } {
  return theme === 'light'
    ? { track: '#00000026', fill: '#1a73c7' }
    : { track: '#ffffff33', fill: '#3ba6ff' }
}

/** A small horizontal bar, `fraction` (0-1, clamped) filled, as a base64 `data:image/svg+xml` URI -- VS Code's sanitizer allows `data:` image sources (`isMediaSourceAllowed`) but keeps no CSS width on `span`/`div`, only an `<img>`'s own `width`/`height`. */
export function meterDataUri(fraction: number, theme: ThemeKind): string {
  const clamped = Math.max(0, Math.min(1, fraction))
  const { track, fill } = meterColors(theme)
  const filledWidth = Math.round(METER_WIDTH * clamped)
  const fillRect =
    filledWidth > 0
      ? `<rect width="${filledWidth}" height="${METER_HEIGHT}" rx="2" fill="${fill}"/>`
      : ''
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${METER_WIDTH}" height="${METER_HEIGHT}">` +
    `<rect width="${METER_WIDTH}" height="${METER_HEIGHT}" rx="2" fill="${track}"/>${fillRect}</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

function meterImg(fraction: number, theme: ThemeKind, title: string): string {
  return `<img src="${meterDataUri(fraction, theme)}" width="${METER_WIDTH}" height="${METER_HEIGHT}" alt="${title}" title="${title}">`
}

// --- table rows ----------------------------------------------------------

function row(label: string, value: string): string {
  return `<tr><td>${muted(label)}</td><td align="right">${value}</td></tr>`
}

function table(rows: readonly string[]): string {
  return `<table>${rows.join('')}</table>`
}

function section(title: string, body: string): string {
  return `<div><b>${title}</b></div>\n\n${body}`
}

// --- header --------------------------------------------------------------

function singleDoorHeaderChip(reachable: boolean): string {
  return reachable
    ? chip('$(pass-filled) reachable', COLOR_OK)
    : `${chip('$(error) unreachable', COLOR_ERROR)} -- start it with \`systemctl --user start engined\``
}

/** More than one door -- a summary count, error only when every door is down, warning when some are. */
function multiDoorHeaderChip(doors: readonly DoorLine[]): string {
  const reachableCount = doors.filter((d) => d.reachable).length
  const allUp = reachableCount === doors.length
  const allDown = reachableCount === 0
  const color = allDown ? COLOR_ERROR : allUp ? COLOR_OK : COLOR_WARN
  const glyph = allDown ? '$(error)' : allUp ? '$(pass-filled)' : '$(warning)'
  return chip(`${glyph} ${reachableCount}/${doors.length} doors reachable`, color)
}

function doorRow(d: DoorLine): string {
  const glyph = d.reachable ? chip('$(pass-filled)', COLOR_OK) : chip('$(error)', COLOR_ERROR)
  const suffix = d.reachable ? '' : ` ${muted('unreachable')}`
  return row(d.name, `${glyph} ${d.url}${suffix}`)
}

// --- call/usage/defaults tables -------------------------------------------

function callTable(call: CallRecord, theme: ThemeKind): string {
  const local = isLocalEgress(call.egress)
  const glyph = local ? '$(server)' : '$(cloud)'
  const inTokens = call.promptTokens === undefined ? '?' : abbreviateTokenCount(call.promptTokens)
  const outTokens =
    call.completionTokens === undefined ? '?' : abbreviateTokenCount(call.completionTokens)
  const rows = [
    row('Route', `${glyph} ${shortModelName(call.route)} ${muted(local ? '(local)' : '(remote)')}`),
    row('Tokens', `${inTokens} → ${outTokens}`),
    row('Time', formatSeconds(call.wallMs)),
  ]
  if (call.costUsd !== undefined) {
    rows.push(row('Cost', formatCostUsd(call.costUsd)))
  }
  if (
    call.promptTokens !== undefined &&
    call.promptTokenMax !== undefined &&
    call.promptTokenMax > 0
  ) {
    const fraction = call.promptTokens / call.promptTokenMax
    rows.push(
      row(
        'Context',
        `${meterImg(fraction, theme, 'prompt tokens used')} ${abbreviateTokenCount(call.promptTokens)} / ${abbreviateTokenCount(call.promptTokenMax)}`,
      ),
    )
  }
  return table(rows)
}

function todayTable(usage: TodayUsage): string {
  const rows = [row('Requests', String(usage.requests))]
  if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
    const inTokens =
      usage.promptTokens === undefined ? '?' : abbreviateTokenCount(usage.promptTokens)
    const outTokens =
      usage.completionTokens === undefined ? '?' : abbreviateTokenCount(usage.completionTokens)
    rows.push(row('Tokens', `${inTokens} → ${outTokens}`))
  }
  return table(rows)
}

/** `Image: @/comfy/local` / `Image: @/comfy/local (automatic)` / `Image: @/whisper/x unavailable, using @/comfy/local`, as a table row. */
function defaultRow(line: DefaultModelLine): string {
  if (line.resolvedName === undefined) {
    return row(line.label, muted('none available'))
  }
  if (line.unusableConfigured !== undefined) {
    return row(
      line.label,
      `${chip(`${line.unusableConfigured} unavailable`, COLOR_WARN)}, using ${line.resolvedName}`,
    )
  }
  return row(
    line.label,
    line.configured ? line.resolvedName : `${line.resolvedName} ${muted('(automatic)')}`,
  )
}

// --- actions ---------------------------------------------------------------

function actionLink(label: string, icon: string, command: string): string {
  return `<a href="command:${command}">$(${icon}) ${label}</a>`
}

function actionsHtml(chatSettingsRouted: boolean): string {
  const links = [
    actionLink('Refresh', 'refresh', TOOLTIP_COMMANDS.refresh),
    actionLink('Default models', 'gear', TOOLTIP_COMMANDS.defaultModels),
    actionLink('Warm up', 'flame', TOOLTIP_COMMANDS.warm),
    actionLink('Engines', 'list-tree', TOOLTIP_COMMANDS.engines),
    actionLink('Usage', 'graph-line', TOOLTIP_COMMANDS.usage),
    chatSettingsRouted
      ? actionLink('Restore', 'discard', TOOLTIP_COMMANDS.restore)
      : actionLink('Use engined everywhere', 'sync', TOOLTIP_COMMANDS.useForAll),
    actionLink('Log', 'output', TOOLTIP_COMMANDS.log),
  ]
  return links.join(' &nbsp;·&nbsp; ')
}

/**
 * The rich status popup, as HTML -- tables, chips, and inline SVG meters
 * only work once `extension.ts` wraps this in a `MarkdownString` with
 * `supportHtml: true`, `supportThemeIcons: true`, and `isTrusted.enabledCommands`
 * set to `Object.values(TOOLTIP_COMMANDS)`.
 */
export function buildTooltip(input: TooltipInput): string {
  const theme = input.themeKind ?? 'dark'

  const headerParts = [
    '<b>engined</b>',
    input.doors.length <= 1
      ? singleDoorHeaderChip(input.doors[0]?.reachable ?? false)
      : multiDoorHeaderChip(input.doors),
    muted(`${input.modelCount} model(s)`),
  ]
  if (input.heldEngines !== undefined && input.heldEngines.length > 0) {
    headerParts.push(muted(`held: ${input.heldEngines.join(', ')}`))
  }
  if (input.chatSettingsRouted === true) {
    headerParts.push(chip('Chat features routed to engined', COLOR_ROUTED))
  }

  const sections = [headerParts.join(' &nbsp;·&nbsp; ')]
  if (input.doors.length > 1) {
    sections.push(section('Doors', table(input.doors.map(doorRow))))
  }
  if (input.lastChat !== undefined) {
    sections.push(section('Last chat', callTable(input.lastChat, theme)))
  }
  if (input.lastBackground !== undefined) {
    sections.push(section('Last background', callTable(input.lastBackground, theme)))
  }
  if (input.lastCompletion !== undefined) {
    sections.push(section('Last completion', callTable(input.lastCompletion, theme)))
  }
  if (input.todayUsage !== undefined) {
    sections.push(section('Today', todayTable(input.todayUsage)))
  }
  if (input.defaults.length > 0) {
    sections.push(section('Defaults', table(input.defaults.map(defaultRow))))
  }
  sections.push(actionsHtml(input.chatSettingsRouted === true))

  return sections.join('\n\n<hr>\n\n')
}
