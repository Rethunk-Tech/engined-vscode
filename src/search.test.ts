import { describe, expect, test } from 'bun:test'
import { chunkFile, cosineSimilarity, mergeRerank, planIndexUpdate, topK } from './search.ts'

describe('chunkFile', () => {
  test('one chunk when the whole file fits under maxChars', () => {
    const chunks = chunkFile('a.ts', 'line one\nline two\nline three')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({
      path: 'a.ts',
      startLine: 0,
      endLine: 2,
      text: 'line one\nline two\nline three',
    })
  })

  test('splits on line boundaries once maxChars is exceeded, never mid-line', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`.padEnd(10, 'x'))
    const chunks = chunkFile('a.ts', lines.join('\n'), 50, 0)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      for (const line of chunk.text.split('\n')) {
        expect(lines).toContain(line)
      }
    }
  })

  test('overlaps consecutive chunks by roughly overlapChars', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}-payload`)
    const chunks = chunkFile('a.ts', lines.join('\n'), 60, 20)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[1]?.startLine).toBeLessThanOrEqual(chunks[0]?.endLine ?? 0)
  })

  test('a single line longer than maxChars still becomes its own chunk', () => {
    const longLine = 'x'.repeat(5000)
    const chunks = chunkFile('a.ts', `${longLine}\nshort`, 100, 10)
    expect(chunks[0]?.text).toBe(longLine)
    expect(chunks.at(-1)?.text).toContain('short')
  })

  test('makes forward progress on every iteration (no infinite loop)', () => {
    const content = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n')
    const chunks = chunkFile('a.ts', content, 30, 29)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.at(-1)?.endLine).toBe(199)
  })
})

describe('cosineSimilarity', () => {
  test('1 for identical vectors, 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  test('0 rather than NaN for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('topK', () => {
  test('ranks by cosine similarity, highest first, capped at k', () => {
    const entries = [
      { vector: [1, 0], item: 'a' },
      { vector: [0, 1], item: 'b' },
      { vector: [0.9, 0.1], item: 'c' },
    ]
    const ranked = topK([1, 0], entries, 2)
    expect(ranked.map((r) => r.item)).toEqual(['a', 'c'])
  })
})

describe('planIndexUpdate', () => {
  test('new and changed-mtime files go to toEmbed; vanished ones go to toRemove', () => {
    const current = [
      { path: 'unchanged.ts', mtime: 1 },
      { path: 'changed.ts', mtime: 5 },
      { path: 'new.ts', mtime: 1 },
    ]
    const indexed = [
      { path: 'unchanged.ts', mtime: 1 },
      { path: 'changed.ts', mtime: 3 },
      { path: 'gone.ts', mtime: 1 },
    ]
    const plan = planIndexUpdate(current, indexed)
    expect(plan.toEmbed.sort()).toEqual(['changed.ts', 'new.ts'])
    expect(plan.toRemove).toEqual(['gone.ts'])
  })
})

describe('mergeRerank', () => {
  test('reorders candidates by descending rerank score, dropping an out-of-range index', () => {
    const candidates = ['a', 'b', 'c']
    const merged = mergeRerank(
      candidates,
      [
        { index: 1, score: 0.9 },
        { index: 0, score: 0.5 },
        { index: 5, score: 0.99 },
      ],
      5,
    )
    expect(merged).toEqual(['b', 'a'])
  })

  test('caps at maxResults', () => {
    const merged = mergeRerank(
      ['a', 'b', 'c'],
      [
        { index: 0, score: 1 },
        { index: 1, score: 0.5 },
        { index: 2, score: 0.1 },
      ],
      1,
    )
    expect(merged).toEqual(['a'])
  })
})
