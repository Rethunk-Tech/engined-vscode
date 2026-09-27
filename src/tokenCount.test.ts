import { describe, expect, test } from 'bun:test'
import { resolveTokenCount, TokenCountCache } from './tokenCount.ts'

describe('resolveTokenCount', () => {
  test('not served falls back to the chars/3 estimate, never calling the door', async () => {
    const cache = new TokenCountCache()
    let calls = 0
    const tokens = await resolveTokenCount(
      cache,
      async () => {
        calls++
        return 999
      },
      '@/claude/sonnet-5',
      'abcdef',
      false,
    )
    expect(tokens).toBe(2)
    expect(calls).toBe(0)
  })

  test('served: calls the door once, then serves the cache on the second call', async () => {
    const cache = new TokenCountCache()
    let calls = 0
    const fetchTokenize = async () => {
      calls++
      return 42
    }
    const first = await resolveTokenCount(cache, fetchTokenize, '@/llama/ornith', 'hello', true)
    const second = await resolveTokenCount(cache, fetchTokenize, '@/llama/ornith', 'hello', true)
    expect(first).toBe(42)
    expect(second).toBe(42)
    expect(calls).toBe(1)
  })

  test('served but the door call fails -> falls back to the estimate', async () => {
    const cache = new TokenCountCache()
    const tokens = await resolveTokenCount(
      cache,
      async () => {
        throw new Error('aborted')
      },
      '@/llama/ornith',
      'abcdef',
      true,
    )
    expect(tokens).toBe(2)
  })

  test('a different model does not share a cache entry with the same content', async () => {
    const cache = new TokenCountCache()
    let calls = 0
    const fetchTokenize = async () => {
      calls++
      return 10
    }
    await resolveTokenCount(cache, fetchTokenize, '@/llama/a', 'hello', true)
    await resolveTokenCount(cache, fetchTokenize, '@/llama/b', 'hello', true)
    expect(calls).toBe(2)
  })
})
