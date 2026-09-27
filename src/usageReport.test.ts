import { describe, expect, test } from 'bun:test'
import type { DoorUsage, UsageRow } from './doorClient.ts'
import { buildUsageReport, formatTotalsLine, totalsFor } from './usageReport.ts'

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    date: '2026-01-02',
    route: 'llama/ornith',
    requests: 1,
    ok: 1,
    failed: 0,
    duration_ms: 100,
    ...over,
  }
}

describe('totalsFor', () => {
  test('sums requests/ok/failed/duration across rows', () => {
    const t = totalsFor([row({ ok: 1, failed: 0 }), row({ ok: 0, failed: 1, duration_ms: 50 })])
    expect(t.requests).toBe(2)
    expect(t.ok).toBe(1)
    expect(t.failed).toBe(1)
    expect(t.durationMs).toBe(150)
  })

  test('cost/tokens stay undefined until a row reports one -- never a fabricated zero', () => {
    const t = totalsFor([row(), row()])
    expect(t.costUsd).toBeUndefined()
    expect(t.promptTokens).toBeUndefined()
    const withCost = totalsFor([row({ cost_usd: 0.02 }), row({ cost_usd: 0.03 }), row()])
    expect(withCost.costUsd).toBeCloseTo(0.05)
  })

  test('egress split counts local vs remote vs unknown by request count', () => {
    const t = totalsFor([
      row({ egress: 'none', requests: 3 }),
      row({ egress: 'lan', requests: 1 }),
      row({ egress: undefined, requests: 2 }),
    ])
    expect(t.localRequests).toBe(3)
    expect(t.remoteRequests).toBe(1)
    expect(t.unknownEgressRequests).toBe(2)
  })
})

describe('formatTotalsLine', () => {
  test('shows "unknown" cost and "?" tokens when absent', () => {
    const line = formatTotalsLine(totalsFor([row()]))
    expect(line).toContain('Cost: unknown')
    expect(line).toContain('? in / ? out')
  })

  test('formats known cost to 4 decimals and known tokens abbreviated', () => {
    const line = formatTotalsLine(
      totalsFor([row({ cost_usd: 1.5, prompt_tokens: 29123, completion_tokens: 400 })]),
    )
    expect(line).toContain('$1.5000')
    expect(line).toContain('29.1k in / 400 out')
  })

  test('egress split reads "egress unknown" when no row reported one', () => {
    const line = formatTotalsLine(totalsFor([row({ egress: undefined })]))
    expect(line).toContain('egress unknown')
  })
})

describe('buildUsageReport', () => {
  test('single door: no Door column, per-day and per-route sections present', () => {
    const usages: DoorUsage[] = [
      {
        door: { name: 'local', url: 'http://x' },
        status: 'ok',
        rows: [
          row({ date: '2026-01-01', route: 'llama/ornith', requests: 5 }),
          row({ date: '2026-01-02', route: 'llama/embed', requests: 2 }),
        ],
      },
    ]
    const report = buildUsageReport(usages, 7)
    expect(report).toContain('# engined usage (last 7 days)')
    expect(report).toContain('## Per day')
    expect(report).toContain('## Per route')
    expect(report).not.toContain('| Door |')
    expect(report).toContain('llama/ornith')
    expect(report).toContain('llama/embed')
  })

  test('multi-door: rows merge under one report with a Door column, sorted by requests', () => {
    const usages: DoorUsage[] = [
      {
        door: { name: 'local', url: 'http://x' },
        status: 'ok',
        rows: [row({ route: 'llama/ornith', requests: 1 })],
      },
      {
        door: { name: 'gpu', url: 'http://y' },
        status: 'ok',
        rows: [row({ route: 'llama/ornith', requests: 9 })],
      },
    ]
    const report = buildUsageReport(usages, 1)
    expect(report).toContain('| Door |')
    const routeSection = report.split('## Per route')[1] ?? ''
    const gpuLine = routeSection.split('\n').find((l) => l.includes('gpu'))
    const localLine = routeSection
      .split('\n')
      .find((l) => l.includes('| local |') || l.includes('local'))
    expect(gpuLine).toBeDefined()
    expect(localLine).toBeDefined()
    // gpu (9 requests) sorts before local (1 request).
    expect(routeSection.indexOf('gpu')).toBeLessThan(routeSection.indexOf('local'))
  })

  test('a 404 door shows the "not served" note without dropping other doors\' data', () => {
    const usages: DoorUsage[] = [
      { door: { name: 'old', url: 'http://x' }, status: 'unsupported' },
      { door: { name: 'new', url: 'http://y' }, status: 'ok', rows: [row()] },
    ]
    const report = buildUsageReport(usages, 7)
    expect(report).toContain("old: this engined doesn't serve usage yet")
    expect(report).toContain('Requests: 1')
  })

  test('an unreachable door is noted and every door failing yields "no usage data"', () => {
    const usages: DoorUsage[] = [{ door: { name: 'down', url: 'http://x' }, status: 'unreachable' }]
    const report = buildUsageReport(usages, 7)
    expect(report).toContain('down: unreachable')
    expect(report).toContain('No usage data')
  })
})
