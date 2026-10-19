import { describe, expect, test } from 'bun:test'
import {
  buildCompletionsRequestBody,
  COMPLETIONS_DOCUMENT_SELECTOR_SCHEMES,
  completionRequestAllowed,
  completionWaitingBehind,
  extractCompletionText,
  extractCompletionUsage,
  sliceContext,
} from './completions.ts'

describe('COMPLETIONS_DOCUMENT_SELECTOR_SCHEMES', () => {
  test('covers on-disk, untitled and notebook-cell documents', () => {
    expect(COMPLETIONS_DOCUMENT_SELECTOR_SCHEMES).toEqual([
      'file',
      'untitled',
      'vscode-notebook-cell',
    ])
  })
})

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

describe('completionWaitingBehind', () => {
  const routeId = '@/llama/ornith'
  const engine = 'llama'

  test('pauses only when the completion model is queued and not already active', () => {
    const cases: {
      name: string
      engines: Parameters<typeof completionWaitingBehind>[0]
      completion: { engine?: string; routeId: string }
      want: boolean
    }[] = [
      {
        name: 'idle engine',
        engines: [{ id: engine, roles: [{ active: 0, waiting: 0 }] }],
        completion: { engine, routeId },
        want: false,
      },
      {
        name: 'chat running, nobody queued',
        engines: [{ id: engine, roles: [{ active: 1, waiting: 0, model: 'chat.gguf' }] }],
        completion: { engine, routeId },
        want: false,
      },
      {
        name: 'waiting behind another GGUF',
        engines: [{ id: engine, roles: [{ active: 1, waiting: 2, model: 'chat.gguf' }] }],
        completion: { engine, routeId },
        want: true,
      },
      {
        name: 'queue-head is another GGUF',
        engines: [{ id: engine, roles: [{ active: 0, waiting: 3, model: 'chat.gguf' }] }],
        completion: { engine, routeId },
        want: true,
      },
      {
        name: 'queue-head is the completion GGUF',
        engines: [{ id: engine, roles: [{ active: 0, waiting: 1, model: 'ornith.gguf' }] }],
        completion: { engine, routeId },
        want: true,
      },
      {
        name: 'completion model is the active job',
        engines: [{ id: engine, roles: [{ active: 1, waiting: 2, model: 'ornith.gguf' }] }],
        completion: { engine, routeId },
        want: false,
      },
      {
        name: 'queue is on a different engine',
        engines: [{ id: 'whisper', roles: [{ active: 0, waiting: 4, model: 'other.gguf' }] }],
        completion: { engine, routeId },
        want: false,
      },
      {
        name: 'no engine id, queue-head matches the route GGUF',
        engines: [{ id: engine, roles: [{ active: 0, waiting: 1, model: 'ornith.gguf' }] }],
        completion: { routeId },
        want: true,
      },
      {
        name: 'no engine id, waiting behind a role that is not us',
        engines: [{ id: engine, roles: [{ active: 1, waiting: 1, model: 'chat.gguf' }] }],
        completion: { routeId },
        want: false,
      },
    ]
    for (const c of cases) {
      expect(completionWaitingBehind(c.engines, c.completion), c.name).toBe(c.want)
    }
  })
})

describe('completionRequestAllowed', () => {
  const js = { lineComment: '//', blockComment: ['/*', '*/'] as const }
  test('gates disabled languages and comments', () => {
    const cases: {
      name: string
      languageId?: string
      disabledLanguages?: string[]
      inComments?: boolean
      text: string
      offset?: number
      commentTokens?: { lineComment?: string; blockComment?: readonly [string, string] }
      want: boolean
    }[] = [
      {
        name: 'allowed language, comments on',
        text: 'const x = 1',
        want: true,
      },
      {
        name: 'disabled language id',
        languageId: 'markdown',
        disabledLanguages: ['markdown', 'plaintext'],
        text: 'hello',
        want: false,
      },
      {
        name: 'comments on, cursor in a line comment',
        text: '// todo',
        offset: 4,
        commentTokens: js,
        want: true,
      },
      {
        name: 'comments off, line comment from language config',
        inComments: false,
        text: '  // todo',
        offset: 8,
        commentTokens: js,
        want: false,
      },
      {
        name: 'comments off, code line with language config',
        inComments: false,
        text: 'const x = 1',
        offset: 6,
        commentTokens: js,
        want: true,
      },
      {
        name: 'comments off, inside a block comment',
        inComments: false,
        text: 'const x = 1 /* n */',
        offset: 15,
        commentTokens: js,
        want: false,
      },
      {
        name: 'comments off, after a closed block comment',
        inComments: false,
        text: 'const x = 1 /* n */ y',
        offset: 21,
        commentTokens: js,
        want: true,
      },
      {
        name: 'comments off, no config, common // prefix',
        inComments: false,
        text: '// hint',
        offset: 4,
        want: false,
      },
      {
        name: 'comments off, no config, common # prefix',
        inComments: false,
        text: '# hint',
        offset: 3,
        want: false,
      },
      {
        name: 'comments off, no config, code is not a comment prefix',
        inComments: false,
        text: 'print(1)',
        offset: 5,
        want: true,
      },
      {
        name: 'comments off, language config present does not use fallback prefixes',
        inComments: false,
        text: '# not python',
        offset: 4,
        commentTokens: js,
        want: true,
      },
    ]
    for (const c of cases) {
      expect(
        completionRequestAllowed({
          languageId: c.languageId ?? 'typescript',
          disabledLanguages: c.disabledLanguages ?? [],
          inComments: c.inComments ?? true,
          text: c.text,
          offset: c.offset ?? c.text.length,
          commentTokens: c.commentTokens,
        }),
        c.name,
      ).toBe(c.want)
    }
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
