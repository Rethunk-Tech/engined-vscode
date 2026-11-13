/**
 * Image-verb SSE: `progress`, `preview`, `image`, `error`. A preview is not
 * the file; the `image` event is the same JSON a buffered call returns.
 * A `preview` with `image` (a frame of at most 32 KiB) is handed to
 * `onPreview`. A larger frame has `bytes` and no `image`, and changes nothing.
 */

import { BYTES_PER_KIB } from './constants.ts'
import { flushSseRest, parseSseChunk } from './engineEvents.ts'

/** The final `image` event is a whole base64 render (up to 4096x4096, several per call), unlike engine-events frames; this only stops an unterminated frame from growing without bound. */
const IMAGE_PENDING_MIB = 512
const MAX_IMAGE_PENDING_CHARS = IMAGE_PENDING_MIB * BYTES_PER_KIB * BYTES_PER_KIB

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

/** An inline preview: base64 bytes and the format the door named. */
export interface ImagePreviewFrame {
  image: string
  format: 'jpeg' | 'png'
}

/** A `preview` event's `image` is at most 32 KiB decoded; anything larger is not a thumbnail. */
const PREVIEW_MAX_KIB = 32
const MAX_PREVIEW_BYTES = PREVIEW_MAX_KIB * BYTES_PER_KIB

function imagePreviewFrame(data: unknown): ImagePreviewFrame | undefined {
  if (data === null || typeof data !== 'object' || !('image' in data) || !('format' in data)) {
    return undefined
  }
  const { image, format } = data
  if (typeof image !== 'string' || image === '') {
    return undefined
  }
  if (format !== 'jpeg' && format !== 'png') {
    return undefined
  }
  if (Buffer.byteLength(image, 'base64') > MAX_PREVIEW_BYTES) {
    return undefined
  }
  return { image, format }
}

/** `<outputPath>.preview.jpeg` or `<outputPath>.preview.png`. */
function imagePreviewPath(outputPath: string, format: ImagePreviewFrame['format']): string {
  return `${outputPath}.preview.${format}`
}

/** The preview file written for the render in progress, if one has been shown. */
export interface PreviewFile {
  path: string | undefined
}

/**
 * Replace the latest preview file with this frame. A format change removes the
 * previous path first so only one preview file is on disk.
 */
export async function writePreviewFile(
  file: PreviewFile,
  outputPath: string,
  frame: ImagePreviewFrame,
  io: {
    write: (path: string, bytes: Uint8Array) => Promise<void>
    remove: (path: string) => Promise<void>
  },
): Promise<void> {
  const path = imagePreviewPath(outputPath, frame.format)
  if (file.path !== undefined && file.path !== path) {
    await io.remove(file.path)
  }
  await io.write(path, Buffer.from(frame.image, 'base64'))
  file.path = path
}

/** Delete the preview file, if one was written. A second call does nothing. */
export async function removePreviewFile(
  file: PreviewFile,
  remove: (path: string) => Promise<void>,
): Promise<void> {
  const { path } = file
  if (path === undefined) {
    return
  }
  file.path = undefined
  await remove(path)
}

async function takeImageEvents(
  frames: { event: string; data: unknown }[],
  onProgress: (line: string) => void,
  onPreview: ((frame: ImagePreviewFrame) => void | Promise<void>) | undefined,
  image: { value: unknown },
): Promise<void> {
  for (const frame of frames) {
    if (frame.event === 'progress') {
      onProgress(imageProgressLine(frame.data))
    } else if (frame.event === 'error') {
      throw new Error(imageEventError(frame.data))
    } else if (frame.event === 'preview') {
      const preview = imagePreviewFrame(frame.data)
      if (preview !== undefined && onPreview !== undefined) {
        await onPreview(preview)
      }
    } else if (frame.event === 'image') {
      image.value = frame.data
    }
  }
}

/**
 * Read events until the `image` payload. An `error` event throws its message.
 * Each inline `preview` is delivered, in order, before the events that follow it.
 */
export async function readImageEvents(
  body: ReadableStream<Uint8Array>,
  onProgress: (line: string) => void,
  onPreview?: (frame: ImagePreviewFrame) => void | Promise<void>,
): Promise<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const image: { value: unknown } = { value: undefined }
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      buffer += decoder.decode(r.value, { stream: true })
      const parsed = parseSseChunk(buffer, MAX_IMAGE_PENDING_CHARS)
      buffer = parsed.rest
      await takeImageEvents(parsed.frames, onProgress, onPreview, image)
    }
    buffer += decoder.decode()
    const flushed = flushSseRest(buffer, MAX_IMAGE_PENDING_CHARS)
    await takeImageEvents(flushed.frames, onProgress, onPreview, image)
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already closed or cancelled.
    }
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
