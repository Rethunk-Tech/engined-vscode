import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { parseTokenizeReply } from './tokenizeRequest'

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
      if (typeof tokens === 'number' && Number.isFinite(tokens)) {
        expect(parseTokenizeReply(data)).toBe(tokens)
      } else {
        expect(() => parseTokenizeReply(data)).toThrow()
      }
    }),
  )
})
