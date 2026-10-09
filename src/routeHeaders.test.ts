import { describe, expect, test } from 'bun:test'
import { costUsdHeader, routeFromHeaders } from './routeHeaders.ts'

describe('costUsdHeader', () => {
  test('parses a reported cost', () => {
    expect(costUsdHeader(new Headers({ 'x-engined-cost-usd': '0.0123' }))).toBe(0.0123)
  })

  test('absent and unparseable mean no cost, not zero', () => {
    expect(costUsdHeader(new Headers())).toBeUndefined()
    expect(costUsdHeader(new Headers({ 'x-engined-cost-usd': 'free' }))).toBeUndefined()
  })
})

describe('routeFromHeaders', () => {
  test('headers win over the requested row', () => {
    const headers = new Headers({ 'x-engined-route': 'cloud/x', 'x-engined-egress': 'remote' })
    expect(routeFromHeaders(headers, { id: 'local', egress: 'none' })).toEqual({
      route: 'cloud/x',
      egress: 'remote',
    })
  })

  test('falls back to the requested row without headers', () => {
    expect(routeFromHeaders(new Headers(), { id: 'local', egress: 'none' })).toEqual({
      route: 'local',
      egress: 'none',
    })
  })
})
