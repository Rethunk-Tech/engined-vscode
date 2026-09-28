import { describe, expect, test } from 'bun:test'
import { DoorHttpError, doorErrorMessage } from './doorClient.ts'

describe('doorErrorMessage', () => {
  test('reads a flat string and an OpenAI error object', () => {
    expect(doorErrorMessage('"llama" is not running')).toBe('"llama" is not running')
    expect(
      doorErrorMessage({
        message: '"llama" is not running',
        type: 'not_found_error',
        param: null,
        code: null,
      }),
    ).toBe('"llama" is not running')
    expect(new DoorHttpError(404, '{"error":"stopped"}').message).toBe('stopped')
    expect(
      new DoorHttpError(
        404,
        '{"error":{"message":"stopped","type":"not_found_error","param":null,"code":null},"attempts":[]}',
      ).message,
    ).toBe('stopped')
    expect(new DoorHttpError(502, 'gateway timeout').message).toBe('gateway timeout')
  })
})
