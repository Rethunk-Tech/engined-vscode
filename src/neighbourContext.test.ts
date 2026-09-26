import { describe, expect, test } from 'bun:test'
import { isExcluded, selectSnippets } from './neighbourContext.ts'

function candidate(
  filename: string,
  text: string,
  cursorOffset?: number,
  scheme = 'file',
): {
  filename: string
  scheme: string
  text: string
  cursorOffset?: number
} {
  return { filename, scheme, text, cursorOffset }
}

describe('isExcluded', () => {
  test('matches a **/ prefix pattern at any depth', () => {
    expect(isExcluded('src/node_modules/x.ts', ['**/node_modules/**'])).toBe(true)
    expect(isExcluded('node_modules/x.ts', ['**/node_modules/**'])).toBe(true)
    expect(isExcluded('src/x.ts', ['**/node_modules/**'])).toBe(false)
  })

  test('a plain top-level pattern only matches that segment', () => {
    expect(isExcluded('out/main.js', ['out/**'])).toBe(true)
    expect(isExcluded('src/out/main.js', ['out/**'])).toBe(false)
  })
})

describe('selectSnippets', () => {
  test('excludes the current document', () => {
    const out = selectSnippets([candidate('a.ts', 'aaa')], 'a.ts', [])
    expect(out).toEqual([])
  })

  test('excludes non-file/untitled schemes', () => {
    const out = selectSnippets([candidate('a.ts', 'aaa', undefined, 'git')], 'current.ts', [])
    expect(out).toEqual([])
  })

  test('excludes files matching an exclude glob', () => {
    const out = selectSnippets([candidate('node_modules/a.ts', 'aaa')], 'current.ts', [
      '**/node_modules/**',
    ])
    expect(out).toEqual([])
  })

  test('dedupes by filename, keeping the first (higher-priority) occurrence', () => {
    const out = selectSnippets(
      [candidate('a.ts', 'first'), candidate('a.ts', 'second')],
      'current.ts',
      [],
    )
    expect(out).toEqual([{ filename: 'a.ts', text: 'first' }])
  })

  test('caps at 3 files even with more candidates', () => {
    const out = selectSnippets(
      [
        candidate('a.ts', 'a'),
        candidate('b.ts', 'b'),
        candidate('c.ts', 'c'),
        candidate('d.ts', 'd'),
      ],
      'current.ts',
      [],
    )
    expect(out.map((f) => f.filename)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  test('takes a window around the cursor offset, not the file head', () => {
    const text = `${'x'.repeat(2000)}CURSOR${'y'.repeat(2000)}`
    const out = selectSnippets([candidate('a.ts', text, 2000)], 'current.ts', [])
    expect(out[0]?.text).toContain('CURSOR')
    expect(out[0]?.text.length).toBe(1500)
  })

  test('no cursor offset takes the head of the file', () => {
    const text = `HEAD${'z'.repeat(3000)}`
    const out = selectSnippets([candidate('a.ts', text)], 'current.ts', [])
    expect(out[0]?.text.startsWith('HEAD')).toBe(true)
    expect(out[0]?.text.length).toBe(1500)
  })

  test('enforces the 4500-char total cap across files, trimming the last one that overflows it', () => {
    const big = 'a'.repeat(1500)
    const out = selectSnippets(
      [
        candidate('a.ts', big, 750),
        candidate('b.ts', big, 750),
        candidate('c.ts', big, 750),
        candidate('d.ts', big, 750),
      ],
      'current.ts',
      [],
    )
    const total = out.reduce((sum, f) => sum + f.text.length, 0)
    expect(total).toBeLessThanOrEqual(4500)
    expect(out).toHaveLength(3)
  })
})
