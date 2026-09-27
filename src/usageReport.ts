/**
 * Pure aggregation and Markdown formatting for `engined: Usage Report`,
 * off the plain `DoorUsage`/`UsageRow` shapes `doorClient.ts` fetches. No
 * `vscode` import, no request content: only the counters engined's own
 * `/engined/v1/usage` reports.
 */

import type { DoorUsage, UsageRow } from './doorClient.ts'
import { abbreviateTokenCount, formatSeconds, isLocalEgress } from './status.ts'

/** `a + b`, where an absent running total or addend means "nothing known yet", not zero -- mirrors engined's own `usage.ts` `addKnown`. */
function addKnown(total: number | undefined, addend: number | undefined): number | undefined {
  return addend === undefined ? total : (total ?? 0) + addend
}

export interface UsageTotals {
  requests: number
  ok: number
  failed: number
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
  durationMs: number
  localRequests: number
  remoteRequests: number
  unknownEgressRequests: number
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    ok: 0,
    failed: 0,
    durationMs: 0,
    localRequests: 0,
    remoteRequests: 0,
    unknownEgressRequests: 0,
  }
}

/** Folds every row into one set of totals -- the report's top line, and the seed for each table cell. */
export function totalsFor(rows: readonly UsageRow[]): UsageTotals {
  const t = emptyTotals()
  for (const row of rows) {
    t.requests += row.requests
    t.ok += row.ok
    t.failed += row.failed
    t.durationMs += row.duration_ms
    t.promptTokens = addKnown(t.promptTokens, row.prompt_tokens)
    t.completionTokens = addKnown(t.completionTokens, row.completion_tokens)
    t.costUsd = addKnown(t.costUsd, row.cost_usd)
    const local = isLocalEgress(row.egress)
    if (row.egress === undefined) {
      t.unknownEgressRequests += row.requests
    } else if (local) {
      t.localRequests += row.requests
    } else {
      t.remoteRequests += row.requests
    }
  }
  return t
}

function formatCostUsd(usd: number): string {
  return `$${usd.toFixed(4)}`
}

function formatEgressSplit(t: UsageTotals): string {
  const known = t.localRequests + t.remoteRequests
  if (known === 0) {
    return 'egress unknown'
  }
  const localPct = Math.round((t.localRequests / known) * 100)
  return `local ${localPct}% / remote ${100 - localPct}%`
}

/** `Requests: 123 (110 ok, 13 failed) · Tokens: 45.6k in / 12.3k out · Cost: $1.2345 · local 80% / remote 20%`. */
export function formatTotalsLine(t: UsageTotals): string {
  const tokens = `${t.promptTokens === undefined ? '?' : abbreviateTokenCount(t.promptTokens)} in / ${
    t.completionTokens === undefined ? '?' : abbreviateTokenCount(t.completionTokens)
  } out`
  const cost = t.costUsd === undefined ? 'unknown' : formatCostUsd(t.costUsd)
  return `Requests: ${t.requests} (${t.ok} ok, ${t.failed} failed) · Tokens: ${tokens} · Cost: ${cost} · ${formatEgressSplit(t)}`
}

function tokensCell(t: UsageTotals): [string, string] {
  return [
    t.promptTokens === undefined ? '?' : abbreviateTokenCount(t.promptTokens),
    t.completionTokens === undefined ? '?' : abbreviateTokenCount(t.completionTokens),
  ]
}

function costCell(t: UsageTotals): string {
  return t.costUsd === undefined ? '' : formatCostUsd(t.costUsd)
}

function mdTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) {
    return '_No usage data._'
  }
  const header = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n')
  return [header, sep, body].join('\n')
}

interface Entry {
  door: string
  row: UsageRow
}

function flatten(usages: readonly DoorUsage[]): Entry[] {
  const entries: Entry[] = []
  for (const usage of usages) {
    if (usage.status !== 'ok') {
      continue
    }
    for (const row of usage.rows) {
      entries.push({ door: usage.door.name, row })
    }
  }
  return entries
}

/** One totals row per group key, in first-seen order -- callers sort as needed. */
function groupBy(entries: readonly Entry[], keyOf: (e: Entry) => string): Map<string, UsageRow[]> {
  const groups = new Map<string, UsageRow[]>()
  for (const entry of entries) {
    const key = keyOf(entry)
    const rows = groups.get(key)
    if (rows === undefined) {
      groups.set(key, [entry.row])
    } else {
      rows.push(entry.row)
    }
  }
  return groups
}

/** One row per (date[, door]), most recent date first. */
function perDayTable(entries: readonly Entry[], multiDoor: boolean): string {
  const keyOf = (e: Entry) => (multiDoor ? `${e.row.date}\u0000${e.door}` : e.row.date)
  const groups = groupBy(entries, keyOf)
  const headers = multiDoor
    ? ['Date', 'Door', 'Requests', 'OK', 'Failed', 'Tokens in', 'Tokens out', 'Cost', 'Duration']
    : ['Date', 'Requests', 'OK', 'Failed', 'Tokens in', 'Tokens out', 'Cost', 'Duration']
  const rows = [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, rows]) => {
      const [date, door] = key.split('\u0000')
      const t = totalsFor(rows)
      const [inTok, outTok] = tokensCell(t)
      const cells = [String(date), ...(multiDoor ? [String(door)] : [])]
      return [
        ...cells,
        String(t.requests),
        String(t.ok),
        String(t.failed),
        inTok,
        outTok,
        costCell(t),
        formatSeconds(t.durationMs),
      ]
    })
  return mdTable(headers, rows)
}

/** One row per (route[, door]), sorted by requests descending. */
function perRouteTable(entries: readonly Entry[], multiDoor: boolean): string {
  const keyOf = (e: Entry) => (multiDoor ? `${e.row.route}\u0000${e.door}` : e.row.route)
  const groups = groupBy(entries, keyOf)
  const headers = multiDoor
    ? ['Route', 'Door', 'Requests', 'OK', 'Failed', 'Tokens in', 'Tokens out', 'Cost']
    : ['Route', 'Requests', 'OK', 'Failed', 'Tokens in', 'Tokens out', 'Cost']
  const rows = [...groups.entries()]
    .map(([key, rows]) => {
      const [route, door] = key.split('\u0000')
      const t = totalsFor(rows)
      const [inTok, outTok] = tokensCell(t)
      const cells = [String(route), ...(multiDoor ? [String(door)] : [])]
      return {
        cells: [
          ...cells,
          String(t.requests),
          String(t.ok),
          String(t.failed),
          inTok,
          outTok,
          costCell(t),
        ],
        requests: t.requests,
      }
    })
    .sort((a, b) => b.requests - a.requests)
    .map((r) => r.cells)
  return mdTable(headers, rows)
}

/** One line per door that could not answer -- keeps a single door's gap from failing the whole report. */
function doorNotesFor(usages: readonly DoorUsage[]): string[] {
  return usages
    .filter((u) => u.status !== 'ok')
    .map((u) =>
      u.status === 'unsupported'
        ? `- ${u.door.name}: this engined doesn't serve usage yet`
        : `- ${u.door.name}: unreachable`,
    )
}

/** The full report shown in the usage-report Markdown preview. */
export function buildUsageReport(usages: readonly DoorUsage[], days: number): string {
  const entries = flatten(usages)
  const multiDoor = usages.length > 1
  const sections = [`# engined usage (last ${days} day${days === 1 ? '' : 's'})`]

  const notes = doorNotesFor(usages)
  if (notes.length > 0) {
    sections.push(notes.join('\n'))
  }

  if (entries.length === 0) {
    sections.push('_No usage data._')
    return sections.join('\n\n')
  }

  sections.push(formatTotalsLine(totalsFor(entries.map((e) => e.row))))
  sections.push(`## Per day\n\n${perDayTable(entries, multiDoor)}`)
  sections.push(`## Per route\n\n${perRouteTable(entries, multiDoor)}`)
  return sections.join('\n\n')
}
