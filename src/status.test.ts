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
  meterDataUri,
  resolveRoute,
  shortModelName,
  TOOLTIP_COMMANDS,
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

/**
 * VS Code's sanitizer keeps `style=` on a `<span>` only when it matches this
 * exact pattern (microsoft/vscode `src/vs/base/browser/markdownRenderer.ts`,
 * the `attributeName: 'style'` `shouldKeep`, read at HEAD 2026-09) -- copied
 * here, not imported, so this test fails the moment `status.ts` emits
 * something the real sanitizer would silently strip.
 */
const VSCODE_SPAN_STYLE_RE =
  /^(color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(display:inline-block;)?(border-radius:[0-9]+px;)?$/

function everySpanStyle(html: string): string[] {
  return [...html.matchAll(/<span style="([^"]*)"/g)].map((m) => m[1] ?? '')
}

describe('buildTooltip', () => {
  const baseInput = {
    doors: [{ name: 'local', url: 'http://x', reachable: true }],
    modelCount: 5,
    defaults: [],
  }

  test('every emitted span style survives the real VS Code sanitizer regex', () => {
    const tooltip = buildTooltip({
      ...baseInput,
      lastChat: {
        route: '@/claude/sonnet-5',
        egress: 'remote',
        promptTokens: 25300,
        completionTokens: 900,
        wallMs: 54000,
        costUsd: 0.0123,
        promptTokenMax: 262144,
      },
      lastBackground: { route: '@/llama/ornith', egress: 'none', wallMs: 300 },
      lastCompletion: { route: '@/llama/ornith', egress: 'none', wallMs: 100 },
      defaults: [
        { label: 'Image', resolvedName: '@/comfy/local', configured: true },
        { label: 'OCR', resolvedName: '@/llama/ocr', configured: false },
        {
          label: 'Speech',
          resolvedName: '@/chatterbox-en/local',
          configured: true,
          unusableConfigured: '@/whisper/x',
        },
      ],
      heldEngines: ['@/llama/ocr'],
      chatSettingsRouted: true,
      todayUsage: { requests: 12, promptTokens: 4000, completionTokens: 900 },
      themeKind: 'light' as const,
    })
    const styles = everySpanStyle(tooltip)
    expect(styles.length).toBeGreaterThan(0)
    for (const style of styles) {
      expect(VSCODE_SPAN_STYLE_RE.test(style)).toBe(true)
    }
  })

  test('header is a table-free chip line naming reachability and model count', () => {
    const tooltip = buildTooltip(baseInput)
    const header = tooltip.split('\n\n<hr>\n\n')[0]
    expect(header).toContain('<b>engined</b>')
    expect(header).toContain('$(pass-filled) reachable')
    expect(header).toContain('5 model(s)')
  })

  test('unreachable single door names the fix command, still uncolored code span', () => {
    const tooltip = buildTooltip({
      ...baseInput,
      doors: [{ name: 'local', url: 'http://x', reachable: false }],
    })
    expect(tooltip).toContain('$(error) unreachable')
    expect(tooltip).toContain('`systemctl --user start engined`')
  })

  test('more than one door renders a Doors table, one row per door', () => {
    const tooltip = buildTooltip({
      ...baseInput,
      doors: [
        { name: 'local', url: 'http://127.0.0.1:29200', reachable: true },
        { name: 'gpu-box', url: 'http://10.0.0.5:29200', reachable: false },
      ],
    })
    expect(tooltip).toContain('<b>Doors</b>')
    expect(tooltip).toMatch(/<table>(<tr>.*?<\/tr>){2}<\/table>/)
    expect(tooltip).toContain('http://127.0.0.1:29200')
    expect(tooltip).toContain('http://10.0.0.5:29200')
  })

  test('calls render as columns in one table, header names only the calls that exist', () => {
    const chatOnly = buildTooltip({
      ...baseInput,
      lastChat: {
        route: '@/llama/ornith',
        egress: 'none',
        promptTokens: 1200,
        completionTokens: 340,
        wallMs: 2300,
      },
    })
    expect(chatOnly).toContain('<table width="100%">')
    expect(chatOnly).toContain('Chat')
    expect(chatOnly).not.toContain('Background')
    expect(chatOnly).not.toContain('Completion')
    expect(chatOnly).toContain('1.2k')
    expect(chatOnly).toContain('340')
    expect(chatOnly).not.toContain('Cost')

    const allThree = buildTooltip({
      ...baseInput,
      lastChat: {
        route: '@/llama/ornith',
        egress: 'none',
        promptTokens: 1200,
        completionTokens: 340,
        wallMs: 2300,
      },
      lastBackground: { route: '@/llama/ornith', egress: 'none', wallMs: 300 },
      lastCompletion: { route: '@/llama/ornith', egress: 'none', wallMs: 100 },
    })
    // one calls table, not three -- a single header row naming all three columns.
    expect(allThree.match(/<table width="100%">/g)?.length).toBeGreaterThanOrEqual(1)
    const headerRow = allThree.match(/<tr><td><\/td>.*?<\/tr>/)?.[0]
    expect(headerRow).toBeDefined()
    expect(headerRow).toContain('Chat')
    expect(headerRow).toContain('Background')
    expect(headerRow).toContain('Completion')
  })

  test('a lone call still renders as a single column', () => {
    const tooltip = buildTooltip({
      ...baseInput,
      lastCompletion: { route: '@/llama/ornith', egress: 'none', wallMs: 100 },
    })
    const callsTableHtml = tooltip.match(/<table width="100%">.*?<\/table>/)?.[0] ?? ''
    expect(callsTableHtml).toContain('Completion')
    expect(callsTableHtml).not.toContain('>Chat<')
    expect(callsTableHtml).not.toContain('Background')
  })

  test('cost row appears only when some column reported a cost', () => {
    const tooltip = buildTooltip({
      ...baseInput,
      lastChat: { route: '@/opencode/ornith', egress: 'none', wallMs: 500, costUsd: 0.0123 },
      lastBackground: { route: '@/llama/ornith', egress: 'none', wallMs: 300 },
    })
    expect(tooltip).toContain('$0.0123')

    const noCost = buildTooltip({
      ...baseInput,
      lastChat: { route: '@/llama/ornith', egress: 'none', wallMs: 500 },
    })
    expect(noCost).not.toContain('Cost')
  })

  test('context row appears only when some column has both prompt tokens and a max', () => {
    const withMax = buildTooltip({
      ...baseInput,
      lastChat: {
        route: '@/claude/sonnet-5',
        egress: 'remote',
        promptTokens: 25300,
        wallMs: 1000,
        promptTokenMax: 262144,
      },
      lastCompletion: { route: '@/llama/ornith', egress: 'none', wallMs: 100 },
    })
    expect(withMax).toContain('Context')
    expect(withMax).toContain('data:image/svg+xml;base64,')
    expect(withMax).toContain('25.3k / 262.1k')

    const withoutMax = buildTooltip({
      ...baseInput,
      lastChat: {
        route: '@/claude/sonnet-5',
        egress: 'remote',
        promptTokens: 25300,
        wallMs: 1000,
      },
    })
    expect(withoutMax).not.toContain('Context')
    expect(withoutMax).not.toContain('data:image/svg+xml;base64,')
  })

  test('Today and Defaults render side by side as one 2-cell row', () => {
    const both = buildTooltip({
      ...baseInput,
      todayUsage: { requests: 12, promptTokens: 4000, completionTokens: 900 },
      defaults: [
        { label: 'Image', resolvedName: '@/comfy/local', configured: true },
        { label: 'OCR', resolvedName: '@/llama/ocr', configured: false },
        {
          label: 'Speech',
          resolvedName: '@/chatterbox-en/local',
          configured: true,
          unusableConfigured: '@/whisper/x',
        },
      ],
    })
    expect(both).toContain('<b>Today</b>')
    expect(both).toContain('<b>Defaults</b>')
    // one row, two cells -- no fresh outer table opens between them, so they
    // sit in the same row rather than as two stacked full-width tables.
    const todayIdx = both.indexOf('<b>Today</b>')
    const defaultsIdx = both.indexOf('<b>Defaults</b>', todayIdx)
    expect(defaultsIdx).toBeGreaterThan(todayIdx)
    expect(both.slice(todayIdx, defaultsIdx)).not.toContain('<table width="100%">')
    expect(both).toContain('12')
    expect(both).toContain('@/comfy/local')
    expect(both).toContain('(automatic)')
    expect(both).toContain('@/whisper/x unavailable')
    expect(both).toContain('using @/chatterbox-en/local')

    const neither = buildTooltip(baseInput)
    expect(neither).not.toContain('<b>Today</b>')
    expect(neither).not.toContain('<b>Defaults</b>')
  })

  test('at most one <hr> sits between the calls table and the Today/Defaults row', () => {
    const tooltip = buildTooltip({
      ...baseInput,
      lastChat: { route: '@/llama/ornith', egress: 'none', wallMs: 300 },
      todayUsage: { requests: 12 },
    })
    const between = tooltip.split('Today')[0]?.split('<table width="100%">').pop() ?? ''
    expect(between.match(/<hr>/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  test('chat-routed chip swaps the "use everywhere" action for "Restore"', () => {
    const routed = buildTooltip({ ...baseInput, chatSettingsRouted: true })
    expect(routed).toContain('Chat features routed to engined')
    expect(routed).toContain(`command:${TOOLTIP_COMMANDS.restore}`)
    expect(routed).not.toContain('Use engined everywhere')

    const notRouted = buildTooltip(baseInput)
    expect(notRouted).toContain(`command:${TOOLTIP_COMMANDS.useForAll}`)
  })

  test('every action command id is one of TOOLTIP_COMMANDS -- what isTrusted.enabledCommands must allow', () => {
    const tooltip = buildTooltip(baseInput)
    const commandIds = [...tooltip.matchAll(/command:([a-zA-Z0-9._]+)/g)].map((m) => m[1] ?? '')
    expect(commandIds.length).toBeGreaterThan(0)
    for (const id of commandIds) {
      expect(Object.values(TOOLTIP_COMMANDS)).toContain(
        id as (typeof TOOLTIP_COMMANDS)[keyof typeof TOOLTIP_COMMANDS],
      )
    }
  })
})

describe('meterDataUri', () => {
  function decode(uri: string): string {
    const b64 = uri.slice('data:image/svg+xml;base64,'.length)
    return Buffer.from(b64, 'base64').toString('utf8')
  }

  test('decodes to a valid, explicitly sized SVG', () => {
    const uri = meterDataUri(0.5, 'dark')
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const svg = decode(uri)
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+">/)
    expect(svg).toContain('</svg>')
    expect(svg).toContain('<rect')
  })

  test('clamps fractions outside 0-1 and omits the fill rect at zero', () => {
    const zero = decode(meterDataUri(0, 'dark'))
    expect(zero.match(/<rect/g)?.length).toBe(1) // track only, no fill

    const over = decode(meterDataUri(4, 'dark'))
    const under = decode(meterDataUri(-1, 'dark'))
    expect(over).toContain('<rect')
    expect(under.match(/<rect/g)?.length).toBe(1)
  })

  test('light and dark themes pick different, both fixed (non-var) fill colors', () => {
    const light = decode(meterDataUri(1, 'light'))
    const dark = decode(meterDataUri(1, 'dark'))
    expect(light).not.toContain('var(')
    expect(dark).not.toContain('var(')
    expect(light).not.toBe(dark)
  })
})
