/**
 * Image-verb SSE: `progress`, `preview`, `image`, `error`. A preview is not
 * the file; the `image` event is the same JSON a buffered call returns.
 */

import { parseSseChunk } from './engineEvents.ts'

/** One sampler line the chat can show: `Rendering 2/8 node 4`, or `Rendering` when the frame names nothing. */
function imageProgressLine(data: unknown): string {
  if (data === null || typeof data !== 'object') {
    return 'Rendering'
  }
  const frame = data as { value?: unknown; max?: unknown; node?: unknown }
  const parts: string[] = []
  if (typeof frame.value === 'number' && typeof frame.max === 'number') {
    parts.push(`${frame.value}/${frame.max}`)
  }
  if (typeof frame.node === 'string' && frame.node !== '') {
    parts.push(`node ${frame.node}`)
  }
  return parts.length === 0 ? 'Rendering' : `Rendering ${parts.join(' ')}`
}

function imageEventError(data: unknown): string {
  const error = data !== null && typeof data === 'object' && 'error' in data ? data.error : data
  if (typeof error === 'string' && error !== '') {
    return error
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message !== ''
  ) {
    return error.message
  }
  return 'image generation failed'
}

function takeImageEvents(
  frames: { event: string; data: unknown }[],
  onProgress: (line: string) => void,
  image: { value: unknown },
): void {
  for (const frame of frames) {
    if (frame.event === 'progress') {
      onProgress(imageProgressLine(frame.data))
    } else if (frame.event === 'error') {
      throw new Error(imageEventError(frame.data))
    } else if (frame.event === 'image') {
      image.value = frame.data
    }
  }
}

/** Read events until the `image` payload. An `error` event throws its message. */
export async function readImageEvents(
  body: ReadableStream<Uint8Array>,
  onProgress: (line: string) => void,
): Promise<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const image: { value: unknown } = { value: undefined }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseChunk(buffer)
      buffer = parsed.rest
      takeImageEvents(parsed.frames, onProgress, image)
    }
    buffer += decoder.decode()
    if (buffer.trim() !== '') {
      const flushed = parseSseChunk(buffer.endsWith('\n\n') ? buffer : `${buffer}\n\n`)
      takeImageEvents(flushed.frames, onProgress, image)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The stream was already cancelled.
    }
  }
  if (image.value === undefined) {
    throw new Error('engined returned no image data')
  }
  return image.value
}
