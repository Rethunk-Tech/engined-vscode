import { describe, expect, test } from 'bun:test'
import { MS_PER_SECOND } from './constants.ts'
import { advanceLogCursor, pollLogFollow } from './logFollow.ts'

describe('log follow cursor and poll', () => {
  test('emits only lines past the previous tail window and waits on the injected clock', async () => {
    const cases: { cursor: string[]; fetched: string[]; added: string[] }[] = [
      { cursor: [], fetched: ['a', 'b'], added: ['a', 'b'] },
      { cursor: ['a', 'b'], fetched: ['a', 'b'], added: [] },
      { cursor: ['a', 'b'], fetched: ['a', 'b', 'c'], added: ['c'] },
      { cursor: ['a', 'b', 'c'], fetched: ['b', 'c', 'd'], added: ['d'] },
      { cursor: ['a', 'b', 'c'], fetched: ['x', 'y'], added: ['x', 'y'] },
    ]
    for (const row of cases) {
      expect(advanceLogCursor(row.cursor, row.fetched)).toEqual({
        added: row.added,
        cursor: row.fetched,
      })
    }

    const dumps = [
      ['a', 'b'],
      ['a', 'b', 'c'],
      ['b', 'c', 'd'],
    ]
    let polls = 0
    const written: string[] = []
    const waits: number[] = []
    await pollLogFollow({
      fetch: async () => {
        const lines = dumps[polls]
        polls += 1
        return lines ?? []
      },
      onLines: (lines) => {
        written.push(...lines)
      },
      wait: async (ms) => {
        waits.push(ms)
      },
      isActive: () => polls < dumps.length,
      intervalMs: MS_PER_SECOND,
    })
    expect(written).toEqual(['a', 'b', 'c', 'd'])
    expect(waits).toEqual([MS_PER_SECOND, MS_PER_SECOND])
  })
})
