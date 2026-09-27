/**
 * Splits long prompt text into pieces at structural boundaries, so a hybrid (recurrent +
 * attention) model can resume a cached prompt at more points. Such a model resumes only at a
 * message boundary: measured on ornith, a 31k-token prompt changed at 85% reused 0 tokens as one
 * message and 26,014 when split into 64. Cut points depend only on the text before them, so a
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
enum Tier {
  InsideStructure = 1,
  LineEnd = 2,
  AfterClosingTag = 3,
  BlankLine = 4,
}

interface Candidate {
  /** The cut goes right before this index (just after a newline). */
  at: number
  tier: Tier
}

/**
 * Every line end, rated. Inside a ``` fence or an open JSON bracket a cut would split a unit
 * the model reads as one, so those rate lowest; JSON strings can't span lines, so string state
 * resets at each newline and a stray prose quote can't poison the rest of the text.
 */
function rateLineEnds(text: string): Candidate[] {
  const out: Candidate[] = []
  let inFence = false
  let depth = 0
  let inString = false
  let lineStart = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') {
      const line = text.slice(lineStart, i)
      const trimmed = line.trim()
      if (trimmed.startsWith('```')) {
        inFence = !inFence
      }
      let tier: Tier
      if (inFence || depth > 0) {
        tier = Tier.InsideStructure
      } else if (trimmed === '') {
        tier = Tier.BlankLine
      } else if (trimmed.startsWith('</') && trimmed.endsWith('>')) {
        tier = Tier.AfterClosingTag
      } else {
        tier = Tier.LineEnd
      }
      out.push({ at: i + 1, tier })
      inString = false
      lineStart = i + 1
      continue
    }
    if (inFence) {
      continue
    }
    if (c === '"' && text[i - 1] !== '\\') {
      inString = !inString
    } else if (!inString && (c === '{' || c === '[')) {
      depth++
    } else if (!inString && (c === '}' || c === ']')) {
      depth = Math.max(0, depth - 1)
    }
  }
  return out
}

/** A hard cut must not split a UTF-16 surrogate pair. */
function safeHardCut(text: string, at: number): number {
  const code = text.charCodeAt(at - 1)
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at
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
    for (let c = candidates[next]; c !== undefined && c.at <= high; c = candidates[++next]) {
      if (c.at > low && (best === undefined || c.tier >= best.tier)) {
        best = c
      }
    }
    const end = best !== undefined ? best.at : safeHardCut(text, high)
    out.push(text.slice(start, end))
    start = end
  }
  out.push(text.slice(start))
  return out
}
