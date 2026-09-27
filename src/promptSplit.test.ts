import { describe, expect, test } from 'bun:test'
import { splitAtBoundaries } from './promptSplit.ts'

const opts = { chunkChars: 400, splitAboveChars: 800 }

function section(name: string, lines: number): string {
  const body = Array.from(
    { length: lines },
    (_, i) => `${name} rule ${i}: keep this line intact.`,
  ).join('\n')
  return `<${name}>\n${body}\n</${name}>\n`
}

describe('splitAtBoundaries', () => {
  test('rejoins exactly and leaves short text whole', () => {
    const text = section('instructions', 60) + '\n' + section('toolUseInstructions', 40)
    expect(splitAtBoundaries(text, opts).join('')).toBe(text)
    expect(splitAtBoundaries('short', opts)).toEqual(['short'])
  })

  test('prefers a blank line, then a closing tag, over a plain line end', () => {
    const text = `${'a line of prose here.\n'.repeat(12)}\n${'more prose continues.\n'.repeat(30)}`
    const [first] = splitAtBoundaries(text, opts)
    expect(first?.endsWith('\n\n')).toBe(true)
    const tagged =
      `<a>\n${'x'.repeat(30)}\n`.repeat(1) +
      `${'a line of prose here.\n'.repeat(9)}</a>\n${'more prose continues.\n'.repeat(30)}`
    expect(splitAtBoundaries(tagged, opts)[0]?.endsWith('</a>\n')).toBe(true)
  })

  test('never cuts inside a JSON value or a code fence when a line end outside exists', () => {
    const json = `{\n${Array.from({ length: 12 }, (_, i) => `  "key${i}": "value ${i}",`).join('\n')}\n  "last": [1, 2, 3]\n}\n`
    const fence = '```ts\n' + 'const x = 1\n'.repeat(15) + '```\n'
    const text = `${'intro line.\n'.repeat(10)}${json}${'middle line.\n'.repeat(10)}${fence}${'outro line.\n'.repeat(60)}`
    for (const piece of splitAtBoundaries(text, opts).slice(0, -1)) {
      const opens = (piece.match(/[{[]/g) ?? []).length
      const closes = (piece.match(/[}\]]/g) ?? []).length
      expect(opens).toBe(closes)
      expect((piece.match(/```/g) ?? []).length % 2).toBe(0)
    }
  })

  test('a shared prefix splits identically up to the first difference', () => {
    const text = section('instructions', 120)
    const changed = `${text.slice(0, 3000)}CHANGED ${text.slice(3000)}`
    const a = splitAtBoundaries(text, opts)
    const b = splitAtBoundaries(changed, opts)
    const firstDiff = a.findIndex((p, i) => p !== b[i])
    expect(firstDiff).toBeGreaterThanOrEqual(5)
    expect(a.slice(0, firstDiff)).toEqual(b.slice(0, firstDiff))
  })

  test('falls back to a hard cut without splitting a surrogate pair', () => {
    const text = '😀'.repeat(1000)
    const pieces = splitAtBoundaries(text, opts)
    expect(pieces.join('')).toBe(text)
    for (const p of pieces) {
      expect(p.length % 2).toBe(0)
    }
  })
})
