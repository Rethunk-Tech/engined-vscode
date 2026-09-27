/**
 * Pure logic behind `engined_search`: chunking a file into overlapping
 * windows, cosine top-k over embedded chunks, which files an index refresh
 * needs to touch, and folding a rerank reply back over the cosine order. No
 * `vscode` import -- `searchIndex.ts` is the workspace/storage adapter.
 */

export interface TextChunk {
  path: string
  /** 0-indexed, inclusive. */
  startLine: number
  endLine: number
  text: string
}

const DEFAULT_MAX_CHARS = 1500
const DEFAULT_OVERLAP_CHARS = 200

/** Splits on line boundaries, each chunk up to `maxChars`, overlapping the previous chunk's tail by roughly `overlapChars`. A line longer than `maxChars` becomes its own chunk rather than being cut mid-line. */
export function chunkFile(
  path: string,
  content: string,
  maxChars = DEFAULT_MAX_CHARS,
  overlapChars = DEFAULT_OVERLAP_CHARS,
): TextChunk[] {
  const lines = content.split('\n')
  const chunks: TextChunk[] = []
  let i = 0
  while (i < lines.length) {
    const start = i
    const parts: string[] = []
    let length = 0
    while (i < lines.length) {
      const line = lines[i] ?? ''
      if (parts.length > 0 && length + line.length + 1 > maxChars) {
        break
      }
      parts.push(line)
      length += line.length + 1
      i += 1
    }
    chunks.push({ path, startLine: start, endLine: i - 1, text: parts.join('\n') })
    if (i >= lines.length) {
      break
    }
    // Back up so the next chunk overlaps this one's tail, never past `start + 1` so every chunk still makes forward progress.
    let back = i
    let overlapped = 0
    while (back > start + 1 && overlapped < overlapChars) {
      back -= 1
      overlapped += (lines[back] ?? '').length + 1
    }
    i = back
  }
  return chunks
}

const DEFAULT_SNIPPET_CHAR_CAP = 600

/** The displayed snippet, capped -- the chunk's own line range stays full-size regardless, so the model can open the file for the rest instead of VS Code spilling a large result to a `content.txt` it has to read back. */
export function truncateSnippet(text: string, maxChars = DEFAULT_SNIPPET_CHAR_CAP): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    magA += x * x
    magB += y * y
  }
  if (magA === 0 || magB === 0) {
    return 0
  }
  return dot / Math.sqrt(magA * magB)
}

export interface ScoredEntry<T> {
  item: T
  score: number
}

/** The top `k` entries by cosine similarity to `query`, highest first. */
export function topK<T>(
  query: readonly number[],
  entries: readonly { vector: readonly number[]; item: T }[],
  k: number,
): ScoredEntry<T>[] {
  return entries
    .map((entry) => ({ item: entry.item, score: cosineSimilarity(query, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

export interface IndexedFile {
  path: string
  mtime: number
}

export interface IndexUpdatePlan {
  /** New or changed-mtime files needing an (re-)embed. */
  toEmbed: string[]
  /** Indexed files that no longer exist in the workspace. */
  toRemove: string[]
}

/** What a refresh needs to do to catch `indexed` up to `current`, by path and mtime alone -- content never enters the plan. */
export function planIndexUpdate(
  current: readonly IndexedFile[],
  indexed: readonly IndexedFile[],
): IndexUpdatePlan {
  const indexedMtime = new Map(indexed.map((f) => [f.path, f.mtime]))
  const currentPaths = new Set(current.map((f) => f.path))
  const toEmbed = current.filter((f) => indexedMtime.get(f.path) !== f.mtime).map((f) => f.path)
  const toRemove = indexed.filter((f) => !currentPaths.has(f.path)).map((f) => f.path)
  return { toEmbed, toRemove }
}

export interface RerankResult {
  index: number
  score?: number
}

/** `candidates` reordered by the rerank service's own result order (highest score first), capped to `maxResults`. An index the rerank reply omitted is dropped rather than guessed at. */
export function mergeRerank<T>(
  candidates: readonly T[],
  results: readonly RerankResult[],
  maxResults: number,
): T[] {
  return [...results]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxResults)
    .map((r) => candidates[r.index])
    .filter((item): item is T => item !== undefined)
}
