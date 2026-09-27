import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readChatStream } from './chatStream.ts'

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
    let text = ''
    const calls = await readChatStream(streamFromText(sse), { text: (delta) => (text += delta) })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('get_weather')
    expect(calls[0]?.arguments).toEqual({ city: 'Vancouver' })
    expect(calls[0]?.id).toBe('Op4N4KrFSABiXPlhFM0Z642YsDktQ9Ec')
  })

  test('ignores malformed data lines and ends cleanly', async () => {
    const stream = streamFromText('data: not json\n\ndata: [DONE]\n\n')
    const calls = await readChatStream(stream, { text: () => {} })
    expect(calls).toEqual([])
  })

  test("reports the final chunk's usage via sink.usage", async () => {
    const stream = streamFromText(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n' +
        'data: [DONE]\n\n',
    )
    let usage: { promptTokens?: number; completionTokens?: number } | undefined
    await readChatStream(stream, { text: () => {}, usage: (u) => (usage = u) })
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
    await readChatStream(stream, { text: () => {}, usage: (u) => (usage = u) })
    expect(usage).toEqual({ promptTokens: 12, completionTokens: 5, costUsd: 0.0123 })
  })
})
