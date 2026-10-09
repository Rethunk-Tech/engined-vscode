const HIGH_SURROGATE_MIN = 0xd8_00
const HIGH_SURROGATE_MAX = 0xdb_ff

/**
 * Splits long prompt text into pieces at structural boundaries, so a hybrid (recurrent +
 * attention) model can resume a cached prompt at more points. Such a model resumes only at a
 * message boundary, so one huge message reuses nothing after a late change. Cut points depend only on the text before them, so a
 * shared prefix always splits identically, and the pieces concatenate back to the original.
 */

export interface SplitOptions {
  /** Target piece size; a cut is sought in its second half. */
  chunkChars: number
  /** Only text longer than this is split; 0 disables splitting. */
  splitAboveChars: number
}

export const DEFAULT_SPLIT: SplitOptions = { chunkChars: 2000, splitAboveChars: 8000 }

/** Higher is a better place to cut. */
const Tier = {
  InsideStructure: 1,
  LineEnd: 2,
  AfterClosingTag: 3,
  BlankLine: 4,
} as const
type Tier = (typeof Tier)[keyof typeof Tier]

interface Candidate {
  /** The cut goes right before this index (just after a newline). */
  at: number
  tier: Tier
}

function tierFor(trimmed: string, insideStructure: boolean): Tier {
  if (insideStructure) {
    return Tier.InsideStructure
  }
  if (trimmed === '') {
    return Tier.BlankLine
  }
  return trimmed.startsWith('</') && trimmed.endsWith('>') ? Tier.AfterClosingTag : Tier.LineEnd
}

/** The JSON bracket depth and string state after the character at `i`. */
function advanceJson(text: string, i: number, state: { depth: number; inString: boolean }): void {
  const c = text[i]
  if (c === '"' && text[i - 1] !== '\\') {
    state.inString = !state.inString
  } else if (!state.inString && (c === '{' || c === '[')) {
    state.depth += 1
  } else if (!state.inString && (c === '}' || c === ']')) {
    state.depth = Math.max(0, state.depth - 1)
  }
}

/**
 * Every line end, rated. Inside a ``` fence or an open JSON bracket a cut would split a unit
 * the model reads as one, so those rate lowest; JSON strings can't span lines, so string state
 * resets at each newline and a stray prose quote can't poison the rest of the text.
 */
function rateLineEnds(text: string): Candidate[] {
  const out: Candidate[] = []
  let inFence = false
  const json = { depth: 0, inString: false }
  let lineStart = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      const trimmed = text.slice(lineStart, i).trim()
      if (trimmed.startsWith('```')) {
        inFence = !inFence
      }
      out.push({ at: i + 1, tier: tierFor(trimmed, inFence || json.depth > 0) })
      json.inString = false
      lineStart = i + 1
    } else if (!inFence) {
      advanceJson(text, i, json)
    }
  }
  return out
}

/** A hard cut must not split a UTF-16 surrogate pair. */
function safeHardCut(text: string, at: number): number {
  const code = text.charCodeAt(at - 1)
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX ? at - 1 : at
}

export function splitAtBoundaries(text: string, options: SplitOptions = DEFAULT_SPLIT): string[] {
  const { chunkChars } = options
  if (options.splitAboveChars <= 0 || text.length <= options.splitAboveChars || chunkChars <= 0) {
    return [text]
  }
  const candidates = rateLineEnds(text)
  const out: string[] = []
  let start = 0
  let next = 0
  while (text.length - start > chunkChars) {
    const low = start + Math.floor(chunkChars / 2)
    const high = start + chunkChars
    let best: Candidate | undefined
    for (let c = candidates[next]; c !== undefined && c.at <= high; c = candidates[next]) {
      if (c.at > low && (best === undefined || c.tier >= best.tier)) {
        best = c
      }
      next += 1
    }
    const end = best === undefined ? safeHardCut(text, high) : best.at
    out.push(text.slice(start, end))
    start = end
  }
  out.push(text.slice(start))
  return out
}
