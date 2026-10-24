import { describe, expect, test } from 'bun:test'
import { parseTokenizeReply, tokenizeRequestBody } from './tokenizeRequest.ts'

describe('tokenize request', () => {
  test('builds {model,content} and reads a finite tokens field', () => {
    expect(tokenizeRequestBody('ornith', 'hello')).toEqual({ model: 'ornith', content: 'hello' })
    const cases: { data: unknown; tokens?: number }[] = [
      { data: { tokens: 7 }, tokens: 7 },
      { data: { tokens: 0 }, tokens: 0 },
      { data: {} },
      { data: { tokens: '7' } },
      { data: { tokens: Number.NaN } },
      { data: null },
    ]
    for (const row of cases.filter((c) => c.tokens === undefined)) {
      expect(() => parseTokenizeReply(row.data)).toThrow('tokenize reply missing tokens')
    }
    const parsed = cases.flatMap((c) =>
      c.tokens === undefined ? [] : [{ data: c.data, tokens: c.tokens }],
    )
    for (const row of parsed) {
      expect(parseTokenizeReply(row.data)).toBe(row.tokens)
    }
  })
})
