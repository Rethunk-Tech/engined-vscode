import { describe, expect, test } from 'bun:test'
import {
  abbreviateTokenCount,
  buildTooltip,
  formatCallLine,
  formatLoadingText,
  formatSeconds,
  hasExceededLoadingThreshold,
  isLocalEgress,
  resolveRoute,
  shortModelName,
} from './status.ts'

describe('isLocalEgress', () => {
  test('only "none" counts as local', () => {
    expect(isLocalEgress('none')).toBe(true)
    expect(isLocalEgress('lan')).toBe(false)
    expect(isLocalEgress('remote')).toBe(false)
    expect(isLocalEgress(undefined)).toBe(false)
  })
})

describe('shortModelName', () => {
  test('takes the last path segment', () => {
    expect(shortModelName('@/claude/sonnet-5')).toBe('sonnet-5')
    expect(shortModelName('no-slash')).toBe('no-slash')
  })
})

describe('abbreviateTokenCount', () => {
  test('plain integer under 1000', () => {
    expect(abbreviateTokenCount(340)).toBe('340')
  })

  test('one-decimal thousands at and above 1000', () => {
    expect(abbreviateTokenCount(29123)).toBe('29.1k')
    expect(abbreviateTokenCount(1000)).toBe('1.0k')
  })
})

describe('formatSeconds', () => {
  test('one decimal under ten seconds', () => {
    expect(formatSeconds(2300)).toBe('2.3s')
  })

  test('rounds to a whole number at and above ten seconds', () => {
    expect(formatSeconds(12345)).toBe('12s')
  })
})

describe('resolveRoute', () => {
  test('the header wins when engined sends one', () => {
    expect(
      resolveRoute(
        { route: '@/llama/ornith', egress: 'none' },
        { id: '@/chain/main', egress: 'remote' },
      ),
    ).toEqual({ route: '@/llama/ornith', egress: 'none' })
  })

  test('falls back to the requested row when no header is present', () => {
    expect(resolveRoute({}, { id: '@/claude/sonnet-5', egress: 'remote' })).toEqual({
      route: '@/claude/sonnet-5',
      egress: 'remote',
    })
  })
})

describe('formatCallLine', () => {
  test('local egress uses the server glyph', () => {
    expect(
      formatCallLine({
        route: '@/llama/ornith',
        egress: 'none',
        promptTokens: 1200,
        completionTokens: 340,
        wallMs: 2300,
      }),
    ).toBe('$(server) ornith · local · 1.2k→340 · 2.3s')
  })

  test('remote egress uses the cloud glyph', () => {
    expect(
      formatCallLine({
        route: '@/claude/sonnet-5',
        egress: 'remote',
        promptTokens: 29123,
        completionTokens: undefined,
        wallMs: 800,
      }),
    ).toBe('$(cloud) sonnet-5 · remote · 29.1k→? · 0.8s')
  })
})

describe('formatLoadingText', () => {
  test('spins on the short model name', () => {
    expect(formatLoadingText('@/claude/sonnet-5')).toBe('$(loading~spin) loading sonnet-5…')
  })
})

describe('hasExceededLoadingThreshold', () => {
  test('false before 1.5s, true at and after', () => {
    expect(hasExceededLoadingThreshold(1000, 2499)).toBe(false)
    expect(hasExceededLoadingThreshold(1000, 2500)).toBe(true)
  })
})

describe('buildTooltip', () => {
  test('lists last chat, last completion, door url, model count', () => {
    const tooltip = buildTooltip({
      lastChat: { route: '@/llama/ornith', egress: 'none', wallMs: 1000 },
      lastCompletion: { route: '@/llama/ornith', egress: 'none', wallMs: 100 },
      doorUrl: 'http://127.0.0.1:29200',
      modelCount: 5,
    })
    expect(tooltip).toBe(
      [
        'Last chat: $(server) ornith · local · ?→? · 1.0s',
        'Last completion: $(server) ornith · local · ?→? · 0.1s',
        'Door: http://127.0.0.1:29200',
        '5 model(s) available',
      ].join('\n'),
    )
  })

  test('omits chat/completion lines when there is no call yet', () => {
    expect(buildTooltip({ doorUrl: 'http://x', modelCount: 0 })).toBe(
      ['Door: http://x', '0 model(s) available'].join('\n'),
    )
  })
})
