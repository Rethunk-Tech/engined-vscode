/**
 * Request shapes for the four `engined_*` tools. Pure: takes the row
 * `defaultModels.ts` (`resolveDefaultModel`) already chose and builds the
 * request `extension.ts` sends -- route picking itself lives there, as the
 * one shared rule behind every `engined.defaultModels.*` setting.
 */

import type { EnginedModelRow } from './door.ts'

const IMAGE_SIDE_MIN = 64
const IMAGE_SIDE_MAX = 4096
const IMAGE_SIDE_STEP = 8

export class ToolRouteError extends Error {}

export interface ImageGenerationRequest {
  path: '/openai/v1/images/generations'
  body: { model: string; prompt: string; size?: string; response_format: 'b64_json' }
}

export interface ImageEditRequest {
  path: '/openai/v1/images/edits'
  form: { model: string; prompt: string; image: Blob; response_format: 'b64_json' }
}

const IMAGE_SIZE = /^([0-9]+)x([0-9]+)$/

/** WxH, each side 64–4096 and a multiple of 8 — the door's `/openai/v1/images` `size` rule. */
function assertImageSize(size: string | undefined): void {
  if (size === undefined) {
    return
  }
  const match = IMAGE_SIZE.exec(size)
  const sideOk = (n: number): boolean =>
    n >= IMAGE_SIDE_MIN && n <= IMAGE_SIDE_MAX && n % IMAGE_SIDE_STEP === 0
  if (match === null || !sideOk(Number(match[1])) || !sideOk(Number(match[2]))) {
    throw new ToolRouteError('size must be WxH with each side 64-4096 and a multiple of 8')
  }
}

/** No `source` -> generation; a `source` -> an edit of it. Both need the `comfy` image route (engined src/images.ts / src/imageEdits.ts). */
export function buildImageRequest(
  row: EnginedModelRow,
  input: { prompt: string; size?: string; source?: Blob },
): ImageGenerationRequest | ImageEditRequest {
  assertImageSize(input.size)
  if (input.source !== undefined) {
    return {
      path: '/openai/v1/images/edits',
      form: {
        model: row.routeId,
        prompt: input.prompt,
        image: input.source,
        response_format: 'b64_json',
      },
    }
  }
  return {
    path: '/openai/v1/images/generations',
    body: {
      model: row.routeId,
      prompt: input.prompt,
      size: input.size,
      response_format: 'b64_json',
    },
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
  row: EnginedModelRow,
  input: { mode: 'ocr' | 'describe'; question?: string; mimeType: string; base64: string },
): ReadImageRequest {
  const prompt =
    input.question ??
    (input.mode === 'ocr' ? 'Transcribe every visible character exactly.' : 'Describe this image.')
  return {
    model: row.routeId,
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
  row: EnginedModelRow,
  input: { audio: Blob; translate?: boolean },
): TranscribeRequest {
  return {
    path:
      input.translate === true
        ? '/openai/v1/audio/translations'
        : '/openai/v1/audio/transcriptions',
    form: { model: row.routeId, file: input.audio },
  }
}

export interface SpeakRequest {
  path: '/openai/v1/audio/speech'
  body: { model: string; input: string; voice?: string }
}

export function buildSpeakRequest(
  row: EnginedModelRow,
  input: { text: string; voice?: string },
): SpeakRequest {
  return {
    path: '/openai/v1/audio/speech',
    body: { model: row.routeId, input: input.text, voice: input.voice },
  }
}

/** The workspace file a tool will read or write, as `prepareInvocation` shows it. */
export interface ConfirmationTarget {
  /** Workspace-relative path. */
  path: string
  /** True when the tool writes to `path` and a file is already there. */
  overwrites?: boolean
}

/**
 * The confirmation message `prepareInvocation` shows: the route, the workspace path the
 * tool touches, whether it overwrites an existing file, and, when its `egress` is not
 * local, that content leaves the machine.
 */
export function confirmationMessage(
  row: EnginedModelRow,
  action: string,
  target?: ConfirmationTarget,
): string {
  const egressNote =
    row.egress !== undefined && row.egress !== 'none'
      ? ` This content leaves this machine (egress: ${row.egress}).`
      : ''
  const pathNote = target === undefined ? '' : ` Path: ${target.path}.`
  const overwriteNote = target?.overwrites === true ? ' This overwrites an existing file.' : ''
  return `${action} via ${row.id}.${pathNote}${overwriteNote}${egressNote}`
}
