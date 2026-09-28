import { describe, expect, test } from 'bun:test'
import {
  agenticBusyMessage,
  DoorHttpError,
  doorErrorMessage,
  postChatCompletion,
} from './doorClient.ts'

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

describe('postChatCompletion', () => {
  test('retries a 429 once when Retry-After is at most 10 s, then reads the 200', async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1
        if (hits === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: 'Too many requests',
                type: 'rate_limit_error',
                param: null,
                code: null,
              },
            }),
            {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '0' },
            },
          )
        }
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    try {
      const { body } = await postChatCompletion(
        `http://127.0.0.1:${server.port}`,
        { model: 'x', messages: [] },
        new AbortController().signal,
      )
      expect(hits).toBe(2)
      expect(body).toBeInstanceOf(ReadableStream)
    } finally {
      server.stop(true)
    }
  })

  test('does not retry a 429 when Retry-After is over 10 s', async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1
        return new Response(
          JSON.stringify({
            error: {
              message: 'Too many requests',
              type: 'rate_limit_error',
              param: null,
              code: null,
            },
          }),
          {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '11' },
          },
        )
      },
    })
    try {
      await expect(
        postChatCompletion(
          `http://127.0.0.1:${server.port}`,
          { model: 'x', messages: [] },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        status: 429,
        message: agenticBusyMessage(11),
      })
      expect(hits).toBe(1)
    } finally {
      server.stop(true)
    }
  })
})
