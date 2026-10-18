import { describe, expect, test } from 'bun:test'
import { HTTP_NOT_FOUND, HTTP_TOO_MANY_REQUESTS } from './constants.ts'
import { describeError } from './describeError.ts'
import { DoorHttpError } from './doorClient.ts'

describe('describeError', () => {
  test('the line logs and tool results show, by thrown shape', () => {
    const cases: { error: unknown; want: string }[] = [
      {
        error: new DoorHttpError(HTTP_TOO_MANY_REQUESTS, '{"error":"Too many requests"}'),
        want: 'Too many requests',
      },
      {
        error: new DoorHttpError(HTTP_NOT_FOUND, '{"error":"stopped"}'),
        want: 'HTTP 404: stopped',
      },
      { error: new Error('boom'), want: 'boom' },
      { error: 'nope', want: 'nope' },
    ]
    for (const { error, want } of cases) {
      expect(describeError(error)).toBe(want)
    }
  })
})
