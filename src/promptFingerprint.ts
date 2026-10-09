/**
 * Content-free diagnostics for prompt-cache misses: where a chat request first differs from
 * the previous one. llama can only reuse the prompt up to that point, so the position explains
 * how much of a new chat is recomputed. Only hashes, counts and offsets leave this module.
 */

import { createHash } from 'node:crypto'

const HASH_LENGTH = 8

export interface FingerprintInput {
  /** Each outgoing message serialized exactly as it is sent. */
  messages: readonly string[]
  /** The outgoing tools array serialized exactly as it is sent. */
  tools: string
}

export interface Fingerprint {
  messageCount: number
  totalChars: number
  toolsHash: string
  /** Where this request first differs from the previous one; undefined when there's no previous or nothing differs. */
  firstDifference?: { message: number; charInMessage: number; charOverall: number }
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, HASH_LENGTH)
}

function firstDiff(a: string, b: string): number | undefined {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) {
      return i
    }
  }
  return a.length === b.length ? undefined : n
}

export function fingerprint(current: FingerprintInput, previous?: FingerprintInput): Fingerprint {
  const result: Fingerprint = {
    messageCount: current.messages.length,
    totalChars: current.messages.reduce((sum, m) => sum + m.length, 0),
    toolsHash: shortHash(current.tools),
  }
  if (previous === undefined) {
    return result
  }
  let offset = 0
  const count = Math.max(current.messages.length, previous.messages.length)
  for (let i = 0; i < count; i++) {
    const a = current.messages[i] ?? ''
    const b = previous.messages[i] ?? ''
    const at = firstDiff(a, b)
    if (at !== undefined) {
      result.firstDifference = { message: i, charInMessage: at, charOverall: offset + at }
      return result
    }
    offset += a.length
  }
  return result
}

export function describeFingerprint(f: Fingerprint, previousToolsHash?: string): string {
  const tools =
    previousToolsHash === undefined
      ? `tools ${f.toolsHash}`
      : `tools ${f.toolsHash}${f.toolsHash === previousToolsHash ? ' (same set)' : ' (CHANGED)'}`
  const diff =
    f.firstDifference === undefined
      ? 'no difference from previous request'
      : `first differs from previous at message ${f.firstDifference.message}, char ${f.firstDifference.charInMessage} (overall char ${f.firstDifference.charOverall})`
  return `prompt fingerprint: ${f.messageCount} messages, ${f.totalChars} chars, ${tools}; ${diff}`
}
