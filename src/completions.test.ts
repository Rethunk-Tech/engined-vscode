import { describe, expect, test } from 'bun:test'
import {
  buildCompletionsRequestBody,
  COMPLETIONS_PATH,
  extractCompletionText,
  extractCompletionUsage,
  pickCompletionsModel,
  sliceContext,
} from './completions.ts'
import type { EnginedModelInfo } from './door.ts'

function modelInfo(id: string, serves: string[]): EnginedModelInfo {
  return {
    id,
    name: id,
    family: 'test',
    version: id,
    detail: '',
    tooltip: '',
    maxInputTokens: 32768,
    maxOutputTokens: 8192,
    capabilities: { toolCalling: false, imageInput: false },
    row: { id, tools: false, serves, state: 'installed', capabilities: {} },
  }
}

describe('buildCompletionsRequestBody', () => {
  test('carries prefix as prompt, single-line stop, zero temperature, 64 max tokens', () => {
    expect(buildCompletionsRequestBody('@/local/ornith', 'def add(a, b):\n    ', '\n')).toEqual({
      model: '@/local/ornith',
      prompt: 'def add(a, b):\n    ',
      suffix: '\n',
      max_tokens: 64,
      temperature: 0,
      stop: ['\n'],
    })
  })

  test('carries extra when given, omits the field when empty or absent', () => {
    const withExtra = buildCompletionsRequestBody('m', 'p', 's', [{ filename: 'a.ts', text: 'x' }])
    expect(withExtra.extra).toEqual([{ filename: 'a.ts', text: 'x' }])
    expect(buildCompletionsRequestBody('m', 'p', 's', []).extra).toBeUndefined()
    expect(buildCompletionsRequestBody('m', 'p', 's').extra).toBeUndefined()
  })
})

describe('sliceContext', () => {
  test('takes the whole document when it is under both limits', () => {
    const text = 'abc\ndef'
    expect(sliceContext(text, 3)).toEqual({ prefix: 'abc', suffix: '\ndef' })
  })

  test('caps the prefix at 6000 characters before the cursor', () => {
    const text = `${'a'.repeat(6100)}CURSOR`
    const offset = 6100
    const { prefix } = sliceContext(text, offset)
    expect(prefix).toHaveLength(6000)
    expect(prefix).toBe('a'.repeat(6000))
  })

  test('caps the suffix at 2000 characters after the cursor', () => {
    const text = `CURSOR${'b'.repeat(2100)}`
    const { suffix } = sliceContext(text, 6)
    expect(suffix).toHaveLength(2000)
    expect(suffix).toBe('b'.repeat(2000))
  })
})

describe('pickCompletionsModel', () => {
  const chatOnly = modelInfo('@/local/chat-only', ['/openai/v1/chat/completions'])
  const ornith = modelInfo('@/local/ornith', ['/openai/v1/chat/completions', COMPLETIONS_PATH])
  const second = modelInfo('@/local/second', [COMPLETIONS_PATH])

  test('the configured id wins over the default when it answers completions', () => {
    expect(pickCompletionsModel([ornith, second], '@/local/second')).toBe(second)
  })

  test('an empty setting falls back to the first answerable row', () => {
    expect(pickCompletionsModel([chatOnly, ornith, second], '')).toBe(ornith)
  })

  test('no row serves completions -> undefined', () => {
    expect(pickCompletionsModel([chatOnly], '')).toBeUndefined()
  })

  test('a configured id that answers no completions route -> undefined', () => {
    expect(pickCompletionsModel([chatOnly, ornith], '@/local/chat-only')).toBeUndefined()
  })
})

describe('extractCompletionText', () => {
  // Shape emitted by engined's own handler, src/completions.ts `completionEnvelope`
  // (engined/src/completions.test.ts "a buffered infill reply maps to the OpenAI completions shape").
  test('reads choices[0].text from a buffered completions reply', () => {
    const reply = {
      id: 'cmpl-1',
      object: 'text_completion',
      created: 0,
      model: '@/local/ornith',
      choices: [{ index: 0, text: 'return a + b', logprobs: null, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }
    expect(extractCompletionText(reply)).toBe('return a + b')
  })

  test('trims trailing whitespace', () => {
    const reply = { choices: [{ text: 'return a + b\n  ', finish_reason: 'stop' }] }
    expect(extractCompletionText(reply)).toBe('return a + b')
  })

  test('an all-whitespace completion is treated as empty', () => {
    expect(extractCompletionText({ choices: [{ text: '   \n' }] })).toBeUndefined()
  })

  test('a malformed reply -> undefined', () => {
    expect(extractCompletionText({})).toBeUndefined()
    expect(extractCompletionText(undefined)).toBeUndefined()
    expect(extractCompletionText({ choices: [] })).toBeUndefined()
  })
})

describe('extractCompletionUsage', () => {
  test('reads prompt_tokens/completion_tokens from usage', () => {
    expect(extractCompletionUsage({ usage: { prompt_tokens: 12, completion_tokens: 5 } })).toEqual({
      promptTokens: 12,
      completionTokens: 5,
    })
  })

  test('no usage, or a malformed one -> undefined', () => {
    expect(extractCompletionUsage({})).toBeUndefined()
    expect(extractCompletionUsage(undefined)).toBeUndefined()
    expect(extractCompletionUsage({ usage: {} })).toBeUndefined()
  })
})
