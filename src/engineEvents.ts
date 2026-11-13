/**
 * Pure logic for `GET /engined/v1/engines/events`: splitting a decoded SSE
 * byte stream into `event`/`data` frames, and the reconnect-backoff
 * sequence. No `vscode` import -- `pollDriver.ts` owns the actual
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

/** engined's largest frame is the `snapshot` of the whole engines list, a few KiB; this leaves two orders of magnitude of headroom. */
export const MAX_SSE_PENDING_CHARS = 1024 * 1024

/**
 * `buffer` is everything decoded so far, including a previous call's
 * `rest`. Lines end in `\r\n`, `\n` or `\r`, and frames are separated by
 * a blank line; anything after the last one is held back as `rest` for the
 * next chunk. Throws once `rest` outgrows `MAX_SSE_PENDING_CHARS`.
 */
export function parseSseChunk(buffer: string): SseParseResult {
  const parts = buffer.replace(/\r\n?/g, '\n').split('\n\n')
  let rest = parts.pop() ?? ''
  // A trailing CR may be the first half of a CRLF the next chunk completes.
  if (buffer.endsWith('\r')) {
    rest = `${rest.slice(0, -1)}\r`
  }
  if (rest.length > MAX_SSE_PENDING_CHARS) {
    throw new Error(`event stream frame exceeds ${MAX_SSE_PENDING_CHARS} characters`)
  }
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

/** `parseSseChunk` of a stream's leftover `rest`, treating EOF as a frame boundary. */
export function flushSseRest(rest: string): SseParseResult {
  if (rest.trim() === '') {
    return { frames: [], rest: '' }
  }
  return parseSseChunk(rest.endsWith('\n\n') ? rest : `${rest}\n\n`)
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
