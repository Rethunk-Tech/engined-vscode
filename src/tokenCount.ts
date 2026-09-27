/**
 * `provideTokenCount`'s caching and fallback decision, plus the small LRU
 * behind it. No `vscode` import -- `extension.ts` supplies the door call and
 * the `served` bit (whether the row lists `/engined/v1/tokenize`).
 */

import { estimateTokenCount } from './requestBuilder.ts'

const MAX_CACHE_ENTRIES = 200

/** ponytail: a 32-bit djb2 hash + length as the cache key, not the full content string -- a collision returns a stale count for one call, which is cheaper than keying a 200-entry LRU on multi-KB prompt text. */
function hashContent(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 33) ^ content.charCodeAt(i)
  }
  return `${hash >>> 0}:${content.length}`
}

/** Bounded LRU keyed by (model, content-hash) -- Copilot calls `provideTokenCount` per message, often repeatedly with the same text. */
export class TokenCountCache {
  private readonly entries = new Map<string, number>()

  get(model: string, content: string): number | undefined {
    const key = `${model}\u0000${hashContent(content)}`
    const value = this.entries.get(key)
    if (value === undefined) {
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(model: string, content: string, tokens: number): void {
    const key = `${model}\u0000${hashContent(content)}`
    this.entries.delete(key)
    this.entries.set(key, tokens)
    if (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) {
        this.entries.delete(oldest)
      }
    }
  }
}

export type TokenizeFetcher = (model: string, content: string) => Promise<number>

/**
 * Not served, or the door call fails/is cancelled -> the chars/3 estimate
 * (`requestBuilder.ts`'s deliberate over-count, never used to load a model).
 * Served -> a cached count, or a fresh door call that gets cached.
 */
export async function resolveTokenCount(
  cache: TokenCountCache,
  fetchTokenize: TokenizeFetcher,
  model: string,
  content: string,
  served: boolean,
): Promise<number> {
  if (!served) {
    return estimateTokenCount(content)
  }
  const cached = cache.get(model, content)
  if (cached !== undefined) {
    return cached
  }
  try {
    const tokens = await fetchTokenize(model, content)
    cache.set(model, content, tokens)
    return tokens
  } catch {
    return estimateTokenCount(content)
  }
}
