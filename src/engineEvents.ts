/**
 * Pure logic for `GET /engined/v1/engines/events`: splitting a decoded SSE
 * byte stream into `event`/`data` frames, and the reconnect-backoff
 * sequence. No `vscode` import -- `engineExplorer.ts` owns the actual
 * `fetch`/reader loop and reconnect timer.
 */

interface SseFrame {
  event: string
  /** The parsed JSON payload, or the raw string when it did not parse as JSON. */
  data: unknown
}

/** One `parseSseChunk` call's result: the frames it found, and the leftover text to prepend to the next chunk. */
export interface SseParseResult {
  frames: SseFrame[]
  rest: string
}

function parseFrameBody(lines: string[]): SseFrame | undefined {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith(':')) {
      continue
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }
  if (dataLines.length === 0) {
    return undefined
  }
  const raw = dataLines.join('\n')
  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return { event, data: raw }
  }
}

/**
 * `buffer` is everything decoded so far, including a previous call's
 * `rest`. Frames are separated by a blank line (`\n\n`); anything after the
 * last one is held back as `rest` for the next chunk.
 */
export function parseSseChunk(buffer: string): SseParseResult {
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  const frames: SseFrame[] = []
  for (const part of parts) {
    if (part.trim().length === 0) {
      continue
    }
    const frame = parseFrameBody(part.split('\n'))
    if (frame !== undefined) {
      frames.push(frame)
    }
  }
  return { frames, rest }
}

const DEFAULT_BASE_MS = 1000
const DEFAULT_MAX_MS = 60_000

/** Reconnect delay for the `attempt`th retry (0-indexed): `baseMs` doubling each time, capped at `maxMs`. */
export function backoffMs(
  attempt: number,
  baseMs = DEFAULT_BASE_MS,
  maxMs = DEFAULT_MAX_MS,
): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs)
}
