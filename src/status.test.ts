import { describe, expect, test } from 'bun:test'
import {
  abbreviateTokenCount,
  buildTooltip,
  formatCallLine,
  formatLoadingText,
  formatProcessingText,
  formatSeconds,
  formatWaitingText,
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

  test('appends cost only when the hop reported one', () => {
    expect(
      formatCallLine({ route: '@/opencode/ornith', egress: 'none', wallMs: 500, costUsd: 0.0123 }),
    ).toBe('$(server) ornith · local · ?→? · 0.5s · $0.0123')
  })
})

describe('formatLoadingText', () => {
  test('spins on the short model name', () => {
    expect(formatLoadingText('@/claude/sonnet-5')).toBe('$(loading~spin) loading sonnet-5…')
  })
})

describe('formatProcessingText', () => {
  test('rounds the estimate to the nearest thousand', () => {
    expect(formatProcessingText(30779)).toBe('$(loading~spin) processing ~31k-token prompt…')
  })
})

describe('formatWaitingText', () => {
  test('warming, or no row resolved yet, is honestly "loading"', () => {
    expect(formatWaitingText('warming', '@/llama/ornith', 30779)).toBe(
      '$(loading~spin) loading ornith…',
    )
    expect(formatWaitingText(undefined, '@/llama/ornith', 30779)).toBe(
      '$(loading~spin) loading ornith…',
    )
  })

  test('a running row that has not answered yet is processing the prompt', () => {
    expect(formatWaitingText('running', '@/llama/ornith', 30779)).toBe(
      '$(loading~spin) processing ~31k-token prompt…',
    )
  })
})

describe('hasExceededLoadingThreshold', () => {
  test('false before 1.5s, true at and after', () => {
    expect(hasExceededLoadingThreshold(1000, 2499)).toBe(false)
    expect(hasExceededLoadingThreshold(1000, 2500)).toBe(true)
  })
})

describe('buildTooltip', () => {
  test('lists header, last chat, last completion, and defaults, separated by rules', () => {
    const tooltip = buildTooltip({
      doorReachable: true,
      doorUrl: 'http://127.0.0.1:29200',
      modelCount: 5,
      lastChat: { route: '@/llama/ornith', egress: 'none', wallMs: 1000 },
      lastCompletion: { route: '@/llama/ornith', egress: 'none', wallMs: 100 },
      defaults: [{ label: 'Completion', modelName: 'ornith' }],
    })
    const sections = tooltip.split('\n\n---\n\n')
    expect(sections[0]).toBe('**engined** · $(pass-filled) reachable · 5 model(s)')
    expect(sections[1]).toBe('**Last chat**\n\n$(server) ornith · local · ?→? · 1.0s')
    expect(sections[2]).toBe('**Last completion**\n\n$(server) ornith · local · ?→? · 0.1s')
    expect(sections[3]).toBe('**Defaults**\n\nCompletion: ornith')
    expect(sections[4]).toContain('[Refresh](command:engined.refreshModels)')
    expect(sections[4]).toContain('[Use engined everywhere](command:engined.useForAllChatFeatures)')
  })

  test('shows the unreachable header with how to start it', () => {
    const tooltip = buildTooltip({
      doorReachable: false,
      doorUrl: 'http://x',
      modelCount: 0,
      defaults: [],
    })
    expect(tooltip.split('\n\n---\n\n')[0]).toBe(
      '**engined** · $(error) unreachable -- start it with `systemctl --user start engined` · 0 model(s)',
    )
  })

  test('says when chat features are routed to engined, and shows Restore instead of Use everywhere', () => {
    const tooltip = buildTooltip({
      doorReachable: true,
      doorUrl: 'http://x',
      modelCount: 0,
      defaults: [],
      chatSettingsRouted: true,
    })
    const sections = tooltip.split('\n\n---\n\n')
    expect(sections[0]).toContain('Chat features routed to engined')
    const actions = sections.at(-1)
    expect(actions).toContain('[Restore](command:engined.restoreChatSettings)')
    expect(actions).not.toContain('Use engined everywhere')
  })

  test('omits chat/completion/defaults sections when there is nothing to show', () => {
    const tooltip = buildTooltip({
      doorReachable: true,
      doorUrl: 'http://x',
      modelCount: 0,
      defaults: [],
    })
    expect(tooltip.split('\n\n---\n\n')).toHaveLength(2)
  })
})
