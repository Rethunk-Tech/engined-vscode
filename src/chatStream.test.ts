import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCopilotUsage, readChatStream } from './chatStream.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const sse = readFileSync(join(FIXTURES, 'ornith-toolcall.sse'), 'utf8')

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

describe('readChatStream', () => {
  test('reconstructs the stitched tool call and its parsed arguments', async () => {
    const calls = await readChatStream(streamFromText(sse), { text: () => undefined })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('get_weather')
    expect(calls[0]?.arguments).toEqual({ city: 'Vancouver' })
    expect(calls[0]?.id).toBe('Op4N4KrFSABiXPlhFM0Z642YsDktQ9Ec')
  })

  test('ignores malformed data lines and ends cleanly', async () => {
    const stream = streamFromText('data: not json\n\ndata: [DONE]\n\n')
    const calls = await readChatStream(stream, { text: () => undefined })
    expect(calls).toEqual([])
  })

  test("reports the final chunk's usage via sink.usage", async () => {
    const stream = streamFromText(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n' +
        'data: [DONE]\n\n',
    )
    let usage: { promptTokens?: number; completionTokens?: number } | undefined
    await readChatStream(stream, {
      text: () => undefined,
      usage: (u) => {
        usage = u
      },
    })
    expect(usage).toEqual({ promptTokens: 12, completionTokens: 5 })
  })

  test("reports an agentic hop's cost from the final chunk's engined.cost_usd, once its usage is already known", async () => {
    const stream = streamFromText(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"engined":{"cost_usd":0.0123}}\n\n' +
        'data: [DONE]\n\n',
    )
    let usage: { promptTokens?: number; completionTokens?: number; costUsd?: number } | undefined
    await readChatStream(stream, {
      text: () => undefined,
      usage: (u) => {
        usage = u
      },
    })
    expect(usage).toEqual({ promptTokens: 12, completionTokens: 5, costUsd: 0.0123 })
  })

  test('reports prompt_tokens_details.cached_tokens when llama sends one', async () => {
    const stream = streamFromText(
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":8}}}\n\n' +
        'data: [DONE]\n\n',
    )
    let usage: { cachedTokens?: number } | undefined
    await readChatStream(stream, {
      text: () => undefined,
      usage: (u) => {
        usage = u
      },
    })
    expect(usage?.cachedTokens).toBe(8)
  })
})

describe('buildCopilotUsage', () => {
  test('undefined when the door reported no prompt/completion tokens at all', () => {
    expect(buildCopilotUsage({})).toBeUndefined()
    expect(buildCopilotUsage({ costUsd: 0.01 })).toBeUndefined()
  })

  test('sums prompt+completion into total_tokens and defaults cached_tokens to 0', () => {
    expect(buildCopilotUsage({ promptTokens: 12, completionTokens: 5 })).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 0 },
    })
  })

  test('carries a reported cached_tokens through unchanged', () => {
    expect(buildCopilotUsage({ promptTokens: 12, completionTokens: 5, cachedTokens: 8 })).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 8 },
    })
  })

  test('a lone completionTokens (no promptTokens) still reports, prompt defaulting to 0', () => {
    expect(buildCopilotUsage({ completionTokens: 5 })).toEqual({
      prompt_tokens: 0,
      completion_tokens: 5,
      total_tokens: 5,
      prompt_tokens_details: { cached_tokens: 0 },
    })
  })
})
