import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { parseTokenizeReply } from './tokenizeRequest.ts'

function tokensOrThrow(data: unknown): { ok: true; tokens: number } | { ok: false } {
  try {
    return { ok: true, tokens: parseTokenizeReply(data) }
  } catch {
    return { ok: false }
  }
}

test('parseTokenizeReply returns any finite tokens field, extra keys ignored', () => {
  fc.assert(
    fc.property(
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.dictionary(fc.string(), fc.jsonValue()),
      (tokens, extra) => {
        expect(parseTokenizeReply({ ...extra, tokens })).toBe(tokens)
      },
    ),
  )
})

test('parseTokenizeReply throws unless tokens is a finite number', () => {
  fc.assert(
    fc.property(fc.jsonValue(), (data) => {
      const record = data !== null && typeof data === 'object' && !Array.isArray(data)
      const tokens = record ? (data as { tokens?: unknown }).tokens : undefined
      const valid = typeof tokens === 'number' && Number.isFinite(tokens)
      expect(tokensOrThrow(data)).toEqual(valid ? { ok: true, tokens } : { ok: false })
    }),
  )
})
