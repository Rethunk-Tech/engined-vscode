/**
 * Route selection and request shapes for the four `engined_*` tools. Pure:
 * takes the rows already fetched from `/openai/v1/models` and builds the
 * request the adapter sends, or a `ToolRouteError` naming what is missing.
 */

import type { EnginedModelRow } from './door.ts'

export class ToolRouteError extends Error {}

function installedRows(rows: readonly EnginedModelRow[], serves: string): EnginedModelRow[] {
  return rows.filter((r) => r.state === 'installed' && r.serves.includes(serves))
}

/** The first installed row serving `serves`, or a `ToolRouteError` naming the missing route. */
export function pickRoute(
  rows: readonly EnginedModelRow[],
  serves: string,
  label: string,
): EnginedModelRow {
  const [row] = installedRows(rows, serves)
  if (row === undefined) {
    throw new ToolRouteError(`no installed engined route serves ${label} (${serves})`)
  }
  return row
}

/** The vision row for OCR (`vision: "read"`) or description (`vision: "describe"`), or a `ToolRouteError`. */
export function pickVisionRoute(
  rows: readonly EnginedModelRow[],
  mode: 'ocr' | 'describe',
): EnginedModelRow {
  const wanted = mode === 'ocr' ? 'read' : 'describe'
  const row = installedRows(rows, '/openai/v1/chat/completions').find(
    (r) => r.role === 'vision' && r.vision === wanted,
  )
  if (row === undefined) {
    throw new ToolRouteError(
      `no installed engined vision route with vision: "${wanted}" for ${mode}`,
    )
  }
  return row
}

/** The transcription row: any installed transcriber for a plain transcription, one whose `translate` is true for a translation. */
export function pickTranscriptionRoute(
  rows: readonly EnginedModelRow[],
  translate: boolean,
): EnginedModelRow {
  const path = translate ? '/openai/v1/audio/translations' : '/openai/v1/audio/transcriptions'
  const label = translate ? 'audio translation' : 'audio transcription'
  return pickRoute(rows, path, label)
}

export interface ImageGenerationRequest {
  path: '/openai/v1/images/generations'
  body: { model: string; prompt: string; size?: string }
}

export interface ImageEditRequest {
  path: '/openai/v1/images/edits'
  form: { model: string; prompt: string; image: Blob }
}

/** No `sourcePath` -> generation; a `sourcePath` -> an edit of it. Both need the `comfy` image route (engined src/images.ts / src/imageEdits.ts). */
export function buildImageRequest(
  rows: readonly EnginedModelRow[],
  input: { prompt: string; size?: string; source?: Blob },
): ImageGenerationRequest | ImageEditRequest {
  if (input.source !== undefined) {
    const row = pickRoute(rows, '/openai/v1/images/edits', 'image edits')
    return {
      path: '/openai/v1/images/edits',
      form: { model: row.id, prompt: input.prompt, image: input.source },
    }
  }
  const row = pickRoute(rows, '/openai/v1/images/generations', 'image generation')
  return {
    path: '/openai/v1/images/generations',
    body: { model: row.id, prompt: input.prompt, size: input.size },
  }
}

export interface ReadImageRequest {
  model: string
  messages: [
    {
      role: 'user'
      content: [{ type: 'text'; text: string }, { type: 'image_url'; image_url: { url: string } }]
    },
  ]
}

/** A one-shot chat completion against the vision row, image as a data URI. */
export function buildReadImageRequest(
  rows: readonly EnginedModelRow[],
  input: { mode: 'ocr' | 'describe'; question?: string; mimeType: string; base64: string },
): ReadImageRequest {
  const row = pickVisionRoute(rows, input.mode)
  const prompt =
    input.question ??
    (input.mode === 'ocr' ? 'Transcribe every visible character exactly.' : 'Describe this image.')
  return {
    model: row.id,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${input.mimeType};base64,${input.base64}` },
          },
        ],
      },
    ],
  }
}

export interface TranscribeRequest {
  path: '/openai/v1/audio/transcriptions' | '/openai/v1/audio/translations'
  form: { model: string; file: Blob }
}

export function buildTranscribeRequest(
  rows: readonly EnginedModelRow[],
  input: { audio: Blob; translate?: boolean },
): TranscribeRequest {
  const row = pickTranscriptionRoute(rows, input.translate === true)
  return {
    path:
      input.translate === true
        ? '/openai/v1/audio/translations'
        : '/openai/v1/audio/transcriptions',
    form: { model: row.id, file: input.audio },
  }
}

export interface SpeakRequest {
  path: '/openai/v1/audio/speech'
  body: { model: string; input: string; voice?: string }
}

export function buildSpeakRequest(
  rows: readonly EnginedModelRow[],
  input: { text: string; voice?: string },
): SpeakRequest {
  const row = pickRoute(rows, '/openai/v1/audio/speech', 'text-to-speech')
  return {
    path: '/openai/v1/audio/speech',
    body: { model: row.id, input: input.text, voice: input.voice },
  }
}

/** The confirmation message `prepareInvocation` shows: the route and, when its `egress` is not local, that content leaves the machine. */
export function confirmationMessage(row: EnginedModelRow, action: string): string {
  const egressNote =
    row.egress !== undefined && row.egress !== 'none'
      ? ` This content leaves this machine (egress: ${row.egress}).`
      : ''
  return `${action} via ${row.id}.${egressNote}`
}
