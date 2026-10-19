/**
 * Cursor + poll for engine log follow. The door's `GET .../logs?tail=` has no
 * follow/stream, so live-follow re-fetches that dump and emits only the lines
 * past the previous window. No `vscode` import -- the Engines view owns the
 * output channel, 1s wait, and visibility stop.
 */

import { truncateLogLines } from './engineTree.ts'

/** Longest suffix of `cursor` that is a prefix of `fetched` -- the overlap of two tail windows. */
export function advanceLogCursor(
  cursor: readonly string[],
  fetched: readonly string[],
): { added: string[]; cursor: string[] } {
  const next = [...fetched]
  if (cursor.length === 0) {
    return { added: next, cursor: next }
  }
  const max = Math.min(cursor.length, fetched.length)
  let overlap = 0
  for (let n = max; n > 0; n--) {
    if (suffixIsPrefix(cursor, fetched, n)) {
      overlap = n
      break
    }
  }
  return { added: fetched.slice(overlap), cursor: next }
}

function suffixIsPrefix(cursor: readonly string[], fetched: readonly string[], n: number): boolean {
  const start = cursor.length - n
  for (let i = 0; i < n; i++) {
    if (cursor[start + i] !== fetched[i]) {
      return false
    }
  }
  return true
}

export async function pollLogFollow(opts: {
  fetch: () => Promise<string[]>
  onLines: (lines: readonly string[]) => void
  wait: (ms: number) => Promise<void>
  isActive: () => boolean
  intervalMs: number
}): Promise<void> {
  let cursor: readonly string[] = []
  while (opts.isActive()) {
    const { added, cursor: next } = advanceLogCursor(cursor, truncateLogLines(await opts.fetch()))
    cursor = next
    if (added.length > 0) {
      opts.onLines(added)
    }
    if (!opts.isActive()) {
      break
    }
    await opts.wait(opts.intervalMs)
  }
}
